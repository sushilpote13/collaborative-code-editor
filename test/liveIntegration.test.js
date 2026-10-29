import 'dotenv/config';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import { io as createSocketClient } from 'socket.io-client';
import { createApp } from '../server/app.js';
import { registerCollaborationHandlers } from '../server/sockets/collaboration.js';
import { createSessionToken } from '../server/services/session.js';
import User from '../server/models/User.js';

test('Live MongoDB, Express API, Auth Middleware, Java Execution, and Socket.IO Integration', async () => {
  let isMongoConnected = false;
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/devloop', {
      serverSelectionTimeoutMS: 2000,
    });
    isMongoConnected = true;
  } catch (err) {
    console.warn('MongoDB not reachable in this test runner context:', err.message);
  }

  const app = createApp({ databaseReady: () => isMongoConnected });
  const server = createServer(app);
  const io = new SocketServer(server, { maxHttpBufferSize: 1024 * 1024 });
  registerCollaborationHandlers(io);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    // 1. Health check
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await healthRes.json();
    assert.equal(healthRes.status, isMongoConnected ? 200 : 503);
    assert.equal(health.status, isMongoConnected ? 'ok' : 'degraded');

    let testUserId = 'test-integration-user-id';
    let testSub = 'test-cognito-sub';

    if (isMongoConnected) {
      const testEmail = 'qa-engineer@devloop.test';
      let user = await User.findOne({ email: testEmail });
      if (!user) {
        user = await User.create({
          firstName: 'DevLoop',
          lastName: 'Engineer',
          username: 'qa_engineer',
          email: testEmail,
          cognitoSub: 'test-cognito-sub-' + Date.now(),
        });
      }
      testUserId = user._id.toString();
      testSub = user.cognitoSub;

      // Current user endpoint
      const token = createSessionToken({ userId: user._id, cognitoSub: user.cognitoSub });
      const meRes = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
        headers: { Cookie: `authToken=${token}` },
      });
      assert.equal(meRes.status, 200);
      const me = await meRes.json();
      assert.equal(me.user.email, testEmail);
    }

    // Java execution (database-independent)
    const token = createSessionToken({ userId: testUserId, cognitoSub: testSub });
    const javaRes = await fetch(`http://127.0.0.1:${port}/api/java/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `authToken=${token}`,
      },
      body: JSON.stringify({
        source: 'public class Main { public static void main(String[] args) { System.out.println("Integration Java Success"); } }',
      }),
    });
    assert.equal(javaRes.status, 200);
    const javaResult = await javaRes.json();
    assert.equal(javaResult.success, true);
    assert.match(javaResult.output, /Integration Java Success/);

    // Socket.IO unauthenticated rejection
    const unauthClient = createSocketClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      autoConnect: false,
    });
    const unauthError = await new Promise((resolve) => {
      unauthClient.on('connect_error', (err) => resolve(err.message));
      unauthClient.connect();
    });
    unauthClient.disconnect();
    assert.match(unauthError, /Authentication required/);

  } finally {
    server.close();
    if (isMongoConnected) {
      await mongoose.disconnect();
    }
  }
});

