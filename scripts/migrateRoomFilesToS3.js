import 'dotenv/config';
import mongoose from 'mongoose';
import * as Y from 'yjs';
import Room from '../server/models/Room.js';
import { s3Storage } from '../server/services/s3Storage.js';

const fileNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/;

function isValidWorkspace(document) {
  const files = document.getMap('files');
  if (files.size < 1 || files.size > 20 || !files.has('Main.java')) {
    return false;
  }
  let totalBytes = 0;
  for (const [name, text] of files) {
    if (!(text instanceof Y.Text) || !fileNamePattern.test(name)) {
      return false;
    }
    const bytes = Buffer.byteLength(text.toString(), 'utf8');
    if (bytes > 32 * 1024) {
      return false;
    }
    totalBytes += bytes;
    if (totalBytes > 128 * 1024) {
      return false;
    }
  }
  return true;
}

function filesFromDocument(document) {
  return [...document.getMap('files').entries()]
    .map(([name, text]) => ({ name, source: text.toString() }));
}

function sameFiles(first, second) {
  return first.length === second.length && first.every((file) =>
    second.some((other) => other.name === file.name && other.source === file.source),
  );
}

async function migrateRoom(room) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, new Uint8Array(room.state));
    if (!isValidWorkspace(document)) {
      throw new Error('A legacy room workspace is invalid; migration stopped without removing data.');
    }
    const legacyFiles = filesFromDocument(document);
    const existingFiles = await s3Storage.loadProjectFiles({ roomId: room.roomId });
    if (existingFiles.length > 0 && !sameFiles(legacyFiles, existingFiles)) {
      throw new Error('S3 already contains different room files; migration stopped without overwriting them.');
    }
    if (existingFiles.length === 0) {
      await s3Storage.replaceProjectFiles({ roomId: room.roomId, files: legacyFiles });
    }
    const verifiedFiles = await s3Storage.loadProjectFiles({ roomId: room.roomId });
    if (!sameFiles(legacyFiles, verifiedFiles)) {
      throw new Error('S3 verification failed; the MongoDB snapshot was retained.');
    }

    return legacyFiles.length;
  } finally {
    document.destroy();
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI must point to the database containing the existing room workspaces.');
  }
  const removeVerifiedSnapshot = process.argv.includes('--remove-verified-snapshots');
  if (process.env.MONGODB_TLS === 'true' && !process.env.MONGODB_TLS_CA_FILE) {
    console.warn('MONGODB_TLS_CA_FILE is not set; the runtime TLS trust store will be used.');
  }
  await mongoose.connect(process.env.MONGODB_URI, {
    ...(process.env.MONGODB_TLS === 'true' ? { tls: true } : {}),
    ...(process.env.MONGODB_TLS_CA_FILE ? { tlsCAFile: process.env.MONGODB_TLS_CA_FILE } : {}),
  });

  try {
    let migratedRooms = 0;
    let migratedFiles = 0;
    const rooms = Room.find({ state: { $exists: true, $ne: null } }).cursor();
    for await (const room of rooms) {
      migratedFiles += await migrateRoom(room);
      migratedRooms += 1;
    }
    if (removeVerifiedSnapshot) {
      const snapshots = Room.find({ state: { $exists: true, $ne: null } }).cursor();
      for await (const room of snapshots) {
        await migrateRoom(room);
        const result = await Room.updateOne(
          { _id: room._id, state: room.state },
          { $unset: { state: 1 } },
        );
        if (result.modifiedCount !== 1) {
          throw new Error('A verified S3 copy exists, but a MongoDB snapshot changed and was retained.');
        }
      }
    }
    console.log(
      `Verified S3 copies for ${migratedRooms} rooms and ${migratedFiles} files.${removeVerifiedSnapshot ? ' Only verified legacy room snapshots were removed.' : ' MongoDB room snapshots were retained.'}`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('Room-to-S3 migration failed:', error.message);
  process.exitCode = 1;
});
