import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import { createRoomRouter } from '../server/routes/roomRoutes.js';
import { createInitialCode, initialCode } from '../shared/initialWorkspace.js';

const jwtSecret = 'room-creation-test-secret';
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

  const app = express();
  app.use(cookieParser());
  app.use('/api/rooms', createRoomRouter({ RoomModel, UserModel }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const token = jwt.sign({}, jwtSecret, { subject: 'room-owner', expiresIn: '1h' });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { cookie: `authToken=${token}` },
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.match(result.roomId, /^[A-Fa-f0-9-]{36}$/);
    assert.equal(createdRoom.createdBy, user._id);

    const document = new Y.Doc();
    Y.applyUpdate(document, createdRoom.state);
    assert.equal(document.getMap('files').get('Main.java').toString(), expectedStarterCode);
    document.destroy();
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
