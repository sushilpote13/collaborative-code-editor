import 'dotenv/config';
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';

const collections = ['users', 'rooms'];

function canonicalValue(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') };
  }
  if (typeof value.toHexString === 'function') {
    return { $oid: value.toHexString() };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function documentDigest(document) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(document)))
    .digest('hex');
}

function connectionOptions(tlsEnabled) {
  return tlsEnabled
    ? {
      tls: true,
      ...(process.env.MONGODB_MIGRATION_CA_FILE
        ? { tlsCAFile: process.env.MONGODB_MIGRATION_CA_FILE }
        : {}),
    }
    : {};
}

function sameDatabase(source, destination) {
  const sourceHosts = source.getClient().options.hosts
    .map((host) => `${host.host}:${host.port}`)
    .sort();
  const destinationHosts = destination.getClient().options.hosts
    .map((host) => `${host.host}:${host.port}`)
    .sort();
  return sourceHosts.join(',') === destinationHosts.join(',')
    && source.name === destination.name;
}

async function copyCollection(source, destination, collectionName) {
  const sourceCollection = source.collection(collectionName);
  const destinationCollection = destination.collection(collectionName);
  let copied = 0;
  let verified = 0;

  const indexes = await sourceCollection.indexes();
  for (const index of indexes) {
    if (index.name === '_id_') {
      continue;
    }
    const { key, name, unique, sparse, expireAfterSeconds } = index;
    await destinationCollection.createIndex(key, {
      name,
      ...(unique ? { unique: true } : {}),
      ...(sparse ? { sparse: true } : {}),
      ...(expireAfterSeconds !== undefined ? { expireAfterSeconds } : {}),
    });
  }

  for await (const sourceDocument of sourceCollection.find({})) {
    const existingDocument = await destinationCollection.findOne({ _id: sourceDocument._id });
    if (existingDocument) {
      if (documentDigest(existingDocument) !== documentDigest(sourceDocument)) {
        throw new Error(`Destination collection "${collectionName}" has a conflicting document.`);
      }
    } else {
      await destinationCollection.insertOne(sourceDocument);
      copied += 1;
    }

    const verifiedDocument = await destinationCollection.findOne({ _id: sourceDocument._id });
    if (!verifiedDocument || documentDigest(verifiedDocument) !== documentDigest(sourceDocument)) {
      throw new Error(`Verification failed for a document in "${collectionName}".`);
    }
    verified += 1;
  }

  return { collectionName, copied, verified };
}

async function main() {
  const sourceUri = process.env.MONGODB_MIGRATION_SOURCE_URI;
  const destinationUri = process.env.MONGODB_MIGRATION_DESTINATION_URI;
  if (!sourceUri || !destinationUri) {
    throw new Error(
      'Set MONGODB_MIGRATION_SOURCE_URI and MONGODB_MIGRATION_DESTINATION_URI before running the non-destructive database copy.',
    );
  }

  const source = await mongoose.createConnection(
    sourceUri,
    connectionOptions(process.env.MONGODB_MIGRATION_SOURCE_TLS === 'true'),
  ).asPromise();
  let destination;
  try {
    destination = await mongoose.createConnection(
      destinationUri,
      connectionOptions(process.env.MONGODB_MIGRATION_DESTINATION_TLS !== 'false'),
    ).asPromise();
    if (sameDatabase(source, destination)) {
      throw new Error('The migration source and destination resolve to the same database.');
    }

    const results = [];
    for (const collectionName of collections) {
      results.push(await copyCollection(source, destination, collectionName));
    }
    for (const result of results) {
      console.log(
        `Verified ${result.verified} ${result.collectionName} documents; inserted ${result.copied}. The source was not modified.`,
      );
    }
  } finally {
    await Promise.all([
      source.close(),
      destination?.close(),
    ]);
  }
}

main().catch((error) => {
  console.error('MongoDB-compatible data migration failed:', error.message);
  process.exitCode = 1;
});
