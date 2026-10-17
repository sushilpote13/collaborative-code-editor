import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { Server as SocketServer } from 'socket.io';
import { io as createSocketClient } from 'socket.io-client';
import * as Y from 'yjs';
import { initialCode } from '../shared/initialWorkspace.js';
import { registerCollaborationHandlers } from '../server/sockets/collaboration.js';

const jwtSecret = 'realtime-collaboration-test-secret';

function createRoomState() {
  const document = new Y.Doc();
  const mainFile = new Y.Text();
  mainFile.insert(0, initialCode);
  document.getMap('files').set('Main.java', mainFile);
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

async function startTestServer() {
  const roomId = `room-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
  let persistenceWaiter = null;
  const UserModel = {
    findById(id) {
      return { select: async () => users.get(id) ?? null };
    },
  };
  const RoomModel = {
    async findOne({ roomId: requestedRoomId }) {
      return requestedRoomId === room.roomId ? room : null;
    },
    async updateOne({ roomId: requestedRoomId }, { $set }) {
      if (requestedRoomId === room.roomId) {
        room.state = $set.state;
        persistenceWaiter?.resolve();
        persistenceWaiter = null;
      }
    },
  };

  const httpServer = createServer();
  const socketServer = new SocketServer(httpServer);
  registerCollaborationHandlers(socketServer, { RoomModel, UserModel });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  function connect(userId) {
    const token = jwt.sign({}, jwtSecret, { subject: userId, expiresIn: '1h' });
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
    room,
    roomId,
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

test('authenticated room members receive Yjs updates and leave notifications', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const server = await startTestServer();
  const first = server.connect('user-one');
  const second = server.connect('user-two');

  try {
    await Promise.all([waitForEvent(first, 'connect'), waitForEvent(second, 'connect')]);
    const firstJoin = await emitWithAck(first, 'room:join', { roomId: server.roomId });
    assert.equal(firstJoin.ok, true);
    assert.equal(firstJoin.members.length, 1);

    const joinedNotice = waitForEvent(first, 'room:participant-joined');
    const secondJoin = await emitWithAck(second, 'room:join', { roomId: server.roomId });
    assert.equal(secondJoin.ok, true);
    assert.equal(secondJoin.members.length, 2);
    assert.equal((await joinedNotice).username, 'second_user');

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
    await persisted;
    const persistedDocument = new Y.Doc();
    Y.applyUpdate(persistedDocument, server.room.state);
    assert.match(
      persistedDocument.getMap('files').get('Main.java').toString(),
      /\/\/ shared update/,
    );

    const leftNotice = waitForEvent(first, 'room:participant-left');
    second.disconnect();
    assert.equal((await leftNotice).username, 'second_user');
    clientDocument.destroy();
    synchronizedDocument.destroy();
    persistedDocument.destroy();
  } finally {
    first.disconnect();
    second.disconnect();
    await server.close();
  }
});
