import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { Server as SocketServer } from 'socket.io';
import { io as createSocketClient } from 'socket.io-client';
import * as Y from 'yjs';
import { initialCode } from '../shared/initialWorkspace.js';
import { registerCollaborationHandlers } from '../server/sockets/collaboration.js';
import { createSessionToken, revokeSessionToken } from '../server/services/session.js';

const jwtSecret = 'realtime-collaboration-test-secret-value-32-chars';

function createRoomState() {
  const document = new Y.Doc();
  const mainFile = new Y.Text();
  mainFile.insert(0, initialCode);
  document.getMap('files').set('Main.java', mainFile);
  const helperFile = new Y.Text();
  helperFile.insert(0, 'public class Helper {\n}\n');
  document.getMap('files').set('Helper.java', helperFile);
  const state = Buffer.from(Y.encodeStateAsUpdate(document));
  document.destroy();
  return state;
}

function waitForEvent(socket, eventName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), 3000);
    socket.once(eventName, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function emitWithAck(socket, eventName, payload) {
  return new Promise((resolve) => socket.emit(eventName, payload, resolve));
}

async function startTestServer({ roomId: existingRoomId, projectFiles: existingProjectFiles } = {}) {
  const roomId = existingRoomId
    ?? `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const isolatedRoomId = `other-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const users = new Map([
    ['user-one', {
      _id: { toString: () => 'user-one' },
      username: 'first_user',
      firstName: 'First',
      lastName: 'User',
    }],
    ['user-two', {
      _id: { toString: () => 'user-two' },
      username: 'second_user',
      firstName: 'Second',
      lastName: 'User',
    }],
  ]);
  const room = { roomId, state: createRoomState() };
  const isolatedRoom = { roomId: isolatedRoomId, state: createRoomState() };
  const legacyRoomState = Buffer.from(room.state);
  const projectFiles = existingProjectFiles ?? new Map();
  const rooms = new Map([
    [room.roomId, room],
    [isolatedRoom.roomId, isolatedRoom],
  ]);
  let persistenceWaiter = null;
  const UserModel = {
    findById(id) {
      return { select: async () => users.get(id) ?? null };
    },
  };
  const RoomModel = {
    async findOne({ roomId: requestedRoomId }) {
      return rooms.get(requestedRoomId) ?? null;
    },
  };
  const storage = {
    async loadProjectFiles({ roomId: requestedRoomId }) {
      return projectFiles.get(requestedRoomId) ?? [];
    },
    async listProjectFiles({ roomId: requestedRoomId }) {
      return (projectFiles.get(requestedRoomId) ?? []).map((file) => ({
        name: file.name,
        size: Buffer.byteLength(file.source, 'utf8'),
      }));
    },
    async replaceProjectFiles({ roomId: requestedRoomId, files }) {
      projectFiles.set(requestedRoomId, files.map((file) => ({ ...file })));
      persistenceWaiter?.resolve();
      persistenceWaiter = null;
    },
    async saveProjectFile({ roomId: requestedRoomId, fileName, source }) {
      const files = projectFiles.get(requestedRoomId) ?? [];
      const index = files.findIndex((file) => file.name === fileName);
      if (index >= 0) {
        files[index] = { name: fileName, source };
      } else {
        files.push({ name: fileName, source });
      }
      projectFiles.set(requestedRoomId, files);
    },
    async loadProjectFile({ roomId: requestedRoomId, fileName }) {
      const file = (projectFiles.get(requestedRoomId) ?? [])
        .find((entry) => entry.name === fileName);
      if (!file) {
        const error = new Error('Missing object');
        error.name = 'NoSuchKey';
        throw error;
      }
      return file.source;
    },
    async deleteProjectFile({ roomId: requestedRoomId, fileName }) {
      projectFiles.set(requestedRoomId, (projectFiles.get(requestedRoomId) ?? [])
        .filter((file) => file.name !== fileName));
    },
  };

  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer);
  registerCollaborationHandlers(socketServer, { RoomModel, UserModel, storage });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  function connect(userId) {
    const token = createSessionToken({ userId });
    return connectWithCookie(token);
  }

  function connectWithCookie(token) {
    const socket = createSocketClient(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { cookie: `authToken=${token}` },
    });
    socket.connect();
    return socket;
  }

  return {
    connect,
    connectWithCookie,
    room,
    roomId,
    isolatedRoomId,
    projectFiles,
    legacyRoomState,
    url: `http://127.0.0.1:${port}`,
    waitForPersistence() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          persistenceWaiter = null;
          reject(new Error('Room state was not persisted'));
        }, 3000);
        persistenceWaiter = {
          resolve() {
            clearTimeout(timer);
            resolve();
          },
        };
      });
    },
    async close() {
      for (const socket of socketServer.of('/').sockets.values()) {
        socket.disconnect(true);
      }
      await new Promise((resolve) => socketServer.close(resolve));
    },
  };
}

test('Socket.IO rejects unauthenticated clients and unknown rooms', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const server = await startTestServer();
  const unauthenticated = createSocketClient(
    server.url,
    { autoConnect: false, transports: ['websocket'] },
  );

  try {
    const authError = waitForEvent(unauthenticated, 'connect_error');
    unauthenticated.connect();
    assert.match((await authError).message, /Authentication required/);

    const authenticated = server.connect('user-one');
    await waitForEvent(authenticated, 'connect');
    const result = await emitWithAck(authenticated, 'room:join', { roomId: 'missing-room' });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/);
    authenticated.disconnect();
  } finally {
    unauthenticated.disconnect();
    await server.close();
  }
});

test('Socket.IO rejects clients that present a forged, unsigned, or revoked session', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const server = await startTestServer();
  const forged = jwt.sign({ purpose: 'devloop-session' }, 'a-different-signing-secret-value', {
    subject: 'user-one',
    expiresIn: '1h',
  });
  const withoutPurpose = jwt.sign({}, jwtSecret, { subject: 'user-one', expiresIn: '1h' });
  const revoked = createSessionToken({ userId: 'user-one' });
  revokeSessionToken(revoked);

  try {
    for (const [label, token] of [
      ['a forged token', forged],
      ['a token without the session purpose', withoutPurpose],
      ['a revoked token', revoked],
      ['a token for an unknown user', createSessionToken({ userId: 'missing-user' })],
    ]) {
      const socket = server.connectWithCookie(token);
      try {
        const authError = waitForEvent(socket, 'connect_error');
        socket.connect();
        assert.match(
          (await authError).message,
          /Authentication required/,
          `${label} must be rejected`,
        );
      } finally {
        socket.disconnect();
      }
    }
  } finally {
    await server.close();
  }
});

test('authenticated room members receive Yjs updates and leave notifications', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const server = await startTestServer();
  const first = server.connect('user-one');
  const second = server.connect('user-two');
  const isolatedClient = server.connect('user-two');
  let isolatedRoomUpdateReceived = false;
  isolatedClient.on('room:document-update', () => {
    isolatedRoomUpdateReceived = true;
  });

  try {
    await Promise.all([
      waitForEvent(first, 'connect'),
      waitForEvent(second, 'connect'),
      waitForEvent(isolatedClient, 'connect'),
    ]);
    const firstJoin = await emitWithAck(first, 'room:join', { roomId: server.roomId });
    assert.equal(firstJoin.ok, true);
    assert.equal(firstJoin.members.length, 1);

    const joinedNotice = waitForEvent(first, 'room:participant-joined');
    const secondJoin = await emitWithAck(second, 'room:join', { roomId: server.roomId });
    assert.equal(secondJoin.ok, true);
    assert.equal(secondJoin.members.length, 2);
    assert.equal((await joinedNotice).username, 'second_user');

    const isolatedJoin = await emitWithAck(
      isolatedClient,
      'room:join',
      { roomId: server.isolatedRoomId },
    );
    assert.equal(isolatedJoin.ok, true);
    assert.equal(isolatedJoin.members.length, 1);

    const invalidUpdate = waitForEvent(first, 'room:error');
    first.emit('room:document-update', { update: new Uint8Array([0, 1, 2]) });
    assert.match((await invalidUpdate).error, /invalid/);

    const remoteUpdate = waitForEvent(second, 'room:document-update');
    const persisted = server.waitForPersistence();
    const clientDocument = new Y.Doc();
    Y.applyUpdate(clientDocument, Buffer.from(firstJoin.state, 'base64'));
    clientDocument.getMap('files').get('Main.java').insert(
      initialCode.length,
      '\n// shared update',
    );
    first.emit('room:document-update', {
      update: Y.encodeStateAsUpdate(clientDocument),
    });

    const updatePacket = await remoteUpdate;
    const synchronizedDocument = new Y.Doc();
    Y.applyUpdate(synchronizedDocument, Buffer.from(secondJoin.state, 'base64'));
    Y.applyUpdate(synchronizedDocument, updatePacket.update);
    assert.match(
      synchronizedDocument.getMap('files').get('Main.java').toString(),
      /\/\/ shared update/,
    );
    assert.equal(
      synchronizedDocument.getMap('files').get('Helper.java').toString(),
      'public class Helper {\n}\n',
    );
    await persisted;

    const reverseUpdate = waitForEvent(first, 'room:document-update');
    const reversePersisted = server.waitForPersistence();
    synchronizedDocument.getMap('files').get('Main.java').insert(
      synchronizedDocument.getMap('files').get('Main.java').length,
      '\n// reverse shared update',
    );
    second.emit('room:document-update', {
      update: Y.encodeStateAsUpdate(synchronizedDocument),
    });
    const reversePacket = await reverseUpdate;
    await reversePersisted;
    const firstDocument = new Y.Doc();
    Y.applyUpdate(firstDocument, Buffer.from(firstJoin.state, 'base64'));
    Y.applyUpdate(firstDocument, reversePacket.update);
    assert.match(
      firstDocument.getMap('files').get('Main.java').toString(),
      /\/\/ reverse shared update/,
    );

    const helperUpdate = waitForEvent(first, 'room:document-update');
    const helperPersisted = server.waitForPersistence();
    const helperText = synchronizedDocument.getMap('files').get('Helper.java');
    helperText.insert(helperText.length, '\n// helper-only update');
    second.emit('room:document-update', {
      update: Y.encodeStateAsUpdate(synchronizedDocument),
    });
    const helperPacket = await helperUpdate;
    await helperPersisted;
    Y.applyUpdate(firstDocument, helperPacket.update);
    assert.match(
      firstDocument.getMap('files').get('Helper.java').toString(),
      /\/\/ helper-only update/,
    );
    assert.doesNotMatch(
      firstDocument.getMap('files').get('Main.java').toString(),
      /helper-only update/,
    );

    const firstText = firstDocument.getMap('files').get('Main.java');
    const secondText = synchronizedDocument.getMap('files').get('Main.java');
    firstText.insert(0, '// concurrent from first\n');
    secondText.insert(0, '// concurrent from second\n');
    const firstConcurrentUpdate = waitForEvent(first, 'room:document-update');
    const secondConcurrentUpdate = waitForEvent(second, 'room:document-update');
    const concurrentPersisted = server.waitForPersistence();
    first.emit('room:document-update', { update: Y.encodeStateAsUpdate(firstDocument) });
    second.emit('room:document-update', {
      update: Y.encodeStateAsUpdate(synchronizedDocument),
    });
    const [firstConcurrentPacket, secondConcurrentPacket] = await Promise.all([
      firstConcurrentUpdate,
      secondConcurrentUpdate,
    ]);
    Y.applyUpdate(firstDocument, firstConcurrentPacket.update);
    Y.applyUpdate(synchronizedDocument, secondConcurrentPacket.update);
    await concurrentPersisted;
    assert.equal(
      firstText.toString(),
      secondText.toString(),
      'simultaneous Yjs edits should converge on both clients',
    );
    assert.match(firstText.toString(), /\/\/ concurrent from first/);
    assert.match(firstText.toString(), /\/\/ concurrent from second/);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(isolatedRoomUpdateReceived, false);
    const isolatedDocument = new Y.Doc();
    Y.applyUpdate(isolatedDocument, Buffer.from(isolatedJoin.state, 'base64'));
    assert.doesNotMatch(
      isolatedDocument.getMap('files').get('Main.java').toString(),
      /shared update|concurrent from/,
    );
    isolatedDocument.destroy();

    const latestJoiner = server.connect('user-one');
    await waitForEvent(latestJoiner, 'connect');
    const latestJoin = await emitWithAck(latestJoiner, 'room:join', { roomId: server.roomId });
    assert.equal(latestJoin.ok, true);
    const latestDocument = new Y.Doc();
    Y.applyUpdate(latestDocument, Buffer.from(latestJoin.state, 'base64'));
    assert.match(
      latestDocument.getMap('files').get('Main.java').toString(),
      /\/\/ reverse shared update/,
    );
    assert.match(
      latestDocument.getMap('files').get('Main.java').toString(),
      /\/\/ concurrent from first/,
    );
    assert.match(
      latestDocument.getMap('files').get('Main.java').toString(),
      /\/\/ concurrent from second/,
    );
    assert.match(
      latestDocument.getMap('files').get('Helper.java').toString(),
      /\/\/ helper-only update/,
    );
    latestDocument.destroy();
    firstDocument.destroy();
    latestJoiner.disconnect();

    const restartedServer = await startTestServer({
      roomId: server.roomId,
      projectFiles: server.projectFiles,
    });
    const restartedClient = restartedServer.connect('user-one');
    try {
      await waitForEvent(restartedClient, 'connect');
      const restartedJoin = await emitWithAck(
        restartedClient,
        'room:join',
        { roomId: server.roomId },
      );
      assert.equal(restartedJoin.ok, true);
      const restartedDocument = new Y.Doc();
      Y.applyUpdate(restartedDocument, Buffer.from(restartedJoin.state, 'base64'));
      assert.match(
        restartedDocument.getMap('files').get('Main.java').toString(),
        /\/\/ concurrent from second/,
      );
      assert.match(
        restartedDocument.getMap('files').get('Helper.java').toString(),
        /\/\/ helper-only update/,
      );
      restartedDocument.destroy();
    } finally {
      restartedClient.disconnect();
      await restartedServer.close();
    }

    const persistedDocument = new Y.Doc();
    for (const file of server.projectFiles.get(server.roomId)) {
      const text = new Y.Text();
      text.insert(0, file.source);
      persistedDocument.getMap('files').set(file.name, text);
    }
    assert.match(
      persistedDocument.getMap('files').get('Main.java').toString(),
      /\/\/ reverse shared update/,
    );
    assert.match(
      persistedDocument.getMap('files').get('Main.java').toString(),
      /\/\/ concurrent from first/,
    );
    assert.match(
      persistedDocument.getMap('files').get('Main.java').toString(),
      /\/\/ concurrent from second/,
    );
    assert.match(
      persistedDocument.getMap('files').get('Helper.java').toString(),
      /\/\/ helper-only update/,
    );
    assert.deepEqual(server.room.state, server.legacyRoomState);

    const leftNotice = waitForEvent(first, 'room:participant-left');
    second.disconnect();
    assert.equal((await leftNotice).username, 'second_user');
    clientDocument.destroy();
    synchronizedDocument.destroy();
    persistedDocument.destroy();
  } finally {
    first.disconnect();
    second.disconnect();
    isolatedClient.disconnect();
    await server.close();
  }
});
