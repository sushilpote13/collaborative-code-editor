import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';

const jwtSecret = 'auth-route-cloud-migration-test-secret';

async function startAuthServer() {
  process.env.JWT_SECRET = jwtSecret;
  const users = new Map();
  const UserModel = {
    async create(values) {
      const user = {
        ...values,
        _id: { toString: () => 'auth-test-user' },
      };
      users.set(user._id.toString(), user);
      return user;
    },
    findOne({ email }) {
      return {
        select: async () => [...users.values()].find((user) => user.email === email) ?? null,
      };
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter({
    authController: createAuthController({ UserModel }),
  }));
  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: error.message });
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    users,
    url: `http://127.0.0.1:${port}/api/auth`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('registration hashes passwords and login preserves authenticated profile access', async () => {
  const server = await startAuthServer();

  try {
    const signupResponse = await fetch(`${server.url}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Cloud',
        lastName: 'User',
        username: 'Cloud_User',
        email: 'CLOUD@example.com',
        password: 'long-test-password',
      }),
    });
    assert.equal(signupResponse.status, 201);
    const signupResult = await signupResponse.json();
    assert.equal(signupResult.user.email, 'cloud@example.com');
    assert.equal('passwordHash' in signupResult.user, false);

    const storedUser = server.users.get(signupResult.user.id);
    assert.notEqual(storedUser.passwordHash, 'long-test-password');
    assert.equal(await bcrypt.compare('long-test-password', storedUser.passwordHash), true);

    const loginResponse = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cloud@example.com',
        password: 'long-test-password',
      }),
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];

    const profileResponse = await fetch(`${server.url}/me`, {
      headers: { cookie },
    });
    assert.equal(profileResponse.status, 200);
    assert.deepEqual((await profileResponse.json()).user, signupResult.user);

    const wrongPassword = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cloud@example.com',
        password: 'wrong-test-password',
      }),
    });
    assert.equal(wrongPassword.status, 401);
  } finally {
    await server.close();
  }
});
