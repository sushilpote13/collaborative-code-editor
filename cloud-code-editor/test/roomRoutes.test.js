import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { handleApiError } from '../server/app.js';
import { createRoomRouter } from '../server/routes/roomRoutes.js';
import { createSessionToken } from '../server/services/session.js';
import { createInitialCode, initialCode } from '../shared/initialWorkspace.js';

const jwtSecret = 'room-creation-test-secret-value-at-least-32-chars';
const expectedStarterCode = `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, DevLoop!");
    }
}
`;

test('workspace starters use the runnable DevLoop greeting and match each Java filename', () => {
  assert.equal(initialCode, expectedStarterCode);
  assert.equal(createInitialCode('Helper'), expectedStarterCode.replace('Main', 'Helper'));
});

test('authenticated room creation stores a seeded Yjs workspace', async () => {
  process.env.JWT_SECRET = jwtSecret;
  let createdRoom;
  let uploadedFiles;
  const user = {
    _id: { toString: () => 'room-owner' },
    username: 'room_owner',
    firstName: 'Room',
    lastName: 'Owner',
  };
  const UserModel = {
    findById(id) {
      return { select: async () => (id === 'room-owner' ? user : null) };
    },
  };
  const RoomModel = {
    async create(room) {
      createdRoom = room;
      return room;
    },
  };
  const storage = {
    async replaceProjectFiles(project) {
      uploadedFiles = project;
    },
    async loadProjectFiles() {
      return uploadedFiles.files;
    },
  };

  const app = express();
  app.use(cookieParser());
  app.use('/api/rooms', createRoomRouter({ RoomModel, UserModel, storage }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const token = createSessionToken({ userId: 'room-owner' });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { cookie: `authToken=${token}` },
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.match(result.roomId, /^[A-Fa-f0-9-]{36}$/);
    assert.equal(createdRoom.createdBy, user._id);
    assert.equal(createdRoom.state, undefined);
    assert.deepEqual(uploadedFiles, {
      roomId: result.roomId,
      files: [{ name: 'Main.java', source: expectedStarterCode }],
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('room creation rejects a request without the authentication cookie', async () => {
  const app = express();
  app.use(cookieParser());
  app.use('/api/rooms', createRoomRouter({
    RoomModel: { create: async () => assert.fail('Unauthenticated room creation must not persist a room.') },
    UserModel: { findById: () => assert.fail('Unauthenticated room creation must not look up a user.') },
    storage: {
      replaceProjectFiles: async () => assert.fail('Unauthenticated room creation must not upload files.'),
      loadProjectFiles: async () => assert.fail('Unauthenticated room creation must not load files.'),
    },
  }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('room creation reports unavailable S3 credentials without creating an incomplete room', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const user = { _id: { toString: () => 'room-owner' } };
  let roomCreated = false;
  const app = express();
  app.use(cookieParser());
  app.use('/api/rooms', createRoomRouter({
    RoomModel: {
      async create() {
        roomCreated = true;
      },
    },
    UserModel: {
      findById() {
        return { select: async () => user };
      },
    },
    storage: {
      async replaceProjectFiles() {
        throw Object.assign(new Error('Could not load credentials from any providers'), {
          name: 'CredentialsProviderError',
        });
      },
      async loadProjectFiles() {
        assert.fail('S3 verification should not run after the upload fails.');
      },
    },
  }));
  app.use(handleApiError);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const token = createSessionToken({ userId: 'room-owner' });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { cookie: `authToken=${token}` },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Cloud file storage is unavailable. Configure AWS credentials and S3 access for the server.',
    });
    assert.equal(roomCreated, false);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
