import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createS3Storage } from '../server/services/s3Storage.js';

function createMemoryS3Client(objects = new Map()) {
  const commands = [];
  const client = new S3Client({ region: 'ap-southeast-2' });
  client.send = async (command) => {
    commands.push(command);
    const { Bucket, Key } = command.input;
    if (command instanceof PutObjectCommand) {
      objects.set(Key, String(command.input.Body));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      if (!objects.has(Key)) {
        const error = new Error('Missing object');
        error.name = 'NoSuchKey';
        throw error;
      }
      const body = objects.get(Key);
      return {
        LastModified: new Date('2026-01-01T00:00:00.000Z'),
        Body: { transformToString: async () => body },
      };
    }
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [...objects.entries()]
          .filter(([key]) => key.startsWith(command.input.Prefix))
          .map(([key, body]) => ({
            Key: key,
            Size: Buffer.byteLength(body, 'utf8'),
          })),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(Key);
      return {};
    }
    throw new Error(`Unexpected S3 command for ${Bucket}.`);
  };
  return { client, commands, objects };
}

test('S3 storage persists a room workspace atomically and exposes file operations', async () => {
  const { client, commands, objects } = createMemoryS3Client();
  const storage = createS3Storage({
    client,
    getBucket: () => 'collaborative-java-editor',
  });
  const files = [
    { name: 'Main.java', source: 'public class Main {}' },
    { name: 'Helper.java', source: 'public class Helper {}' },
  ];
  const roomId = 'project-files-room';

  await storage.replaceProjectFiles({ roomId, files });
  assert.deepEqual(await storage.loadProjectFiles({ roomId }), files);
  assert.deepEqual(
    (await storage.listProjectFiles({ roomId })).map(({ name }) => name),
    ['Main.java', 'Helper.java'],
  );
  assert.equal(
    await storage.loadProjectFile({ roomId, fileName: 'Main.java' }),
    files[0].source,
  );

  await storage.saveProjectFile({
    roomId,
    fileName: 'Helper.java',
    source: 'public class Helper { int value; }',
  });
  assert.equal(
    await storage.loadProjectFile({ roomId, fileName: 'Helper.java' }),
    'public class Helper { int value; }',
  );

  await storage.deleteProjectFile({ roomId, fileName: 'Helper.java' });
  assert.deepEqual(
    await storage.loadProjectFiles({ roomId }),
    [files[0]],
  );
  assert.deepEqual([...objects.keys()], [
    'projects/project-files-room/workspace.json',
  ]);
  assert.ok(commands.some((command) => command instanceof PutObjectCommand));
  assert.ok(commands.some((command) => command instanceof GetObjectCommand));
  const saveCommand = commands.find((command) => command instanceof PutObjectCommand);
  assert.deepEqual(saveCommand.input, {
    Bucket: 'collaborative-java-editor',
    Key: 'projects/project-files-room/workspace.json',
    Body: JSON.stringify({ files }),
    ContentType: 'application/json; charset=utf-8',
    ServerSideEncryption: 'AES256',
  });
});

test('S3 storage reads and migrates legacy per-file objects after verifying the workspace copy', async () => {
  const roomId = 'legacy-files-room';
  const prefix = `projects/${roomId}/`;
  const { client, commands, objects } = createMemoryS3Client(new Map([
    [`${prefix}Main.java`, 'public class Main {}'],
    [`${prefix}Helper.java`, 'public class Helper {}'],
  ]));
  const storage = createS3Storage({
    client,
    getBucket: () => 'collaborative-java-editor',
  });

  assert.deepEqual(
    await storage.loadProjectFiles({ roomId }),
    [
      { name: 'Helper.java', source: 'public class Helper {}' },
      { name: 'Main.java', source: 'public class Main {}' },
    ],
  );
  await storage.replaceProjectFiles({
    roomId,
    files: [{ name: 'Main.java', source: 'public class Main {}' }],
  });

  assert.deepEqual([...objects.keys()], [`${prefix}workspace.json`]);
  assert.ok(commands.some((command) => command instanceof DeleteObjectCommand));
});

test('S3 file listing filters out non-Java objects from legacy project prefixes', async () => {
  const client = new S3Client({ region: 'ap-southeast-2' });
  client.send = async (command) => {
    if (command instanceof GetObjectCommand) {
      if (command.input.Key.endsWith('Main.java')) {
        return { Body: { transformToString: async () => '123456789012' } };
      }
      const error = new Error('Missing object');
      error.name = 'NoSuchKey';
      throw error;
    }
    assert.ok(command instanceof ListObjectsV2Command);
    return {
      Contents: [
        {
          Key: 'projects/project-files-room/Main.java',
          Size: 12,
          LastModified: new Date('2026-01-01T00:00:00.000Z'),
        },
        { Key: 'projects/project-files-room/notes.txt', Size: 8 },
        { Key: 'projects/another-room/Other.java', Size: 14 },
      ],
    };
  };
  const storage = createS3Storage({
    client,
    getBucket: () => 'collaborative-java-editor',
  });

  assert.deepEqual(
    await storage.listProjectFiles({ roomId: 'project-files-room' }),
    [{
      name: 'Main.java',
      size: 12,
      lastModified: null,
    }],
  );
});

test('S3 storage rejects malformed or oversized workspace data', async () => {
  const { client } = createMemoryS3Client();
  const storage = createS3Storage({
    client,
    getBucket: () => 'collaborative-java-editor',
  });

  await assert.rejects(
    storage.replaceProjectFiles({
      roomId: 'project-files-room',
      files: [{ name: '../Main.java', source: 'invalid' }],
    }),
    /invalid or duplicate Java file/,
  );
  await assert.rejects(
    storage.replaceProjectFiles({
      roomId: 'project-files-room',
      files: [{ name: 'Main.java', source: 'a'.repeat(32 * 1024 + 1) }],
    }),
    /no larger than 32 KB/,
  );
});
