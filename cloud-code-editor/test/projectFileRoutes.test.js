import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createProjectFileRouter } from '../server/routes/projectFileRoutes.js';
import { createSessionToken } from '../server/services/session.js';

const jwtSecret = 'project-file-test-secret-value-at-least-32-chars';
const roomId = 'project-files-room';
const fileName = 'Main.java';

async function startProjectFileServer({ storage, roomExists = true, authorized = true }) {
  process.env.JWT_SECRET = jwtSecret;
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api/projects', createProjectFileRouter({
    RoomModel: {
      findOne() {
        return { select: async () => (roomExists ? { _id: roomId } : null) };
      },
    },
    storage,
    authorizeRoomMember: () => authorized,
  }));
  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: error.message });
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const token = createSessionToken({ userId: 'project-file-user' });

  return {
    filesUrl: `http://127.0.0.1:${port}/api/projects/${roomId}/files`,
    url: `http://127.0.0.1:${port}/api/projects/${roomId}/files/${fileName}`,
    cookie: `authToken=${token}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('authenticated project file APIs save, load, and delete room-scoped files', async () => {
  let storedFile = null;
  const storage = {
    async saveProjectFile(file) {
      storedFile = file;
    },
    async loadProjectFile() {
      if (!storedFile) {
        const error = new Error('Missing object');
        error.name = 'NoSuchKey';
        throw error;
      }
      return storedFile.source;
    },
    async deleteProjectFile() {
      storedFile = null;
    },
    async replaceProjectFiles({ files }) {
      storedFile = files.find((file) => file.name === fileName) ?? null;
    },
    async listProjectFiles() {
      return storedFile
        ? [{ name: storedFile.fileName, size: Buffer.byteLength(storedFile.source, 'utf8') }]
        : [];
    },
  };
  const server = await startProjectFileServer({ storage });

  try {
    const saveResponse = await fetch(server.url, {
      method: 'PUT',
      headers: { cookie: server.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'public class Main {}' }),
    });
    assert.equal(saveResponse.status, 200);
    assert.deepEqual(await saveResponse.json(), { name: fileName });
    assert.deepEqual(storedFile, {
      roomId,
      fileName,
      source: 'public class Main {}',
    });

    const loadResponse = await fetch(server.url, {
      headers: { cookie: server.cookie },
    });
    assert.equal(loadResponse.status, 200);
    assert.deepEqual(await loadResponse.json(), {
      name: fileName,
      source: 'public class Main {}',
    });

    const listResponse = await fetch(server.filesUrl, {
      headers: { cookie: server.cookie },
    });
    assert.equal(listResponse.status, 200);
    assert.deepEqual((await listResponse.json()).files.map((file) => file.name), [fileName]);

    const replaceResponse = await fetch(server.filesUrl, {
      method: 'PUT',
      headers: { cookie: server.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: fileName, source: 'public class Main { int value; }' }] }),
    });
    assert.equal(replaceResponse.status, 200);
    assert.equal(storedFile.source, 'public class Main { int value; }');

    const deleteResponse = await fetch(server.url, {
      method: 'DELETE',
      headers: { cookie: server.cookie },
    });
    assert.equal(deleteResponse.status, 204);
    assert.equal(storedFile, null);

    const missingResponse = await fetch(server.url, {
      headers: { cookie: server.cookie },
    });
    assert.equal(missingResponse.status, 404);
  } finally {
    await server.close();
  }
});

test('project file APIs require authentication and an existing room', async () => {
  const storage = {
    saveProjectFile: async () => assert.fail('Unauthenticated requests must not save files.'),
    loadProjectFile: async () => assert.fail('Unauthenticated requests must not load files.'),
    deleteProjectFile: async () => assert.fail('Unauthenticated requests must not delete files.'),
  };
  const server = await startProjectFileServer({ storage, roomExists: false });

  try {
    const unauthenticated = await fetch(server.url);
    assert.equal(unauthenticated.status, 401);

    const missingRoom = await fetch(server.url, {
      headers: { cookie: server.cookie },
    });
    assert.equal(missingRoom.status, 404);
  } finally {
    await server.close();
  }
});

test('project file APIs reject authenticated users who have not joined the room', async () => {
  const storage = {
    listProjectFiles: async () => assert.fail('Non-members must not list project files.'),
    saveProjectFile: async () => assert.fail('Non-members must not save project files.'),
    loadProjectFile: async () => assert.fail('Non-members must not load project files.'),
    deleteProjectFile: async () => assert.fail('Non-members must not delete project files.'),
  };
  const server = await startProjectFileServer({ storage, authorized: false });

  try {
    const response = await fetch(server.filesUrl, {
      headers: { cookie: server.cookie },
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

test('project file save rejects invalid source and oversized files', async () => {
  let saveCalled = false;
  const server = await startProjectFileServer({
    storage: {
      async saveProjectFile() {
        saveCalled = true;
      },
      loadProjectFile: async () => '',
      deleteProjectFile: async () => {},
    },
  });

  try {
    const invalid = await fetch(server.url, {
      method: 'PUT',
      headers: { cookie: server.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 123 }),
    });
    assert.equal(invalid.status, 400);

    const oversized = await fetch(server.url, {
      method: 'PUT',
      headers: { cookie: server.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'a'.repeat(32 * 1024 + 1) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(saveCalled, false);
  } finally {
    await server.close();
  }
});
