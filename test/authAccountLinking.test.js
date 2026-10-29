import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';
import { CognitoTokenInvalidError } from '../server/services/cognito.js';

const jwtSecret = 'auth-account-linking-test-secret-that-is-long-enough';
const identityToken = 'verified-cognito-identity-token';

const baseClaims = {
  sub: 'cognito-subject-current',
  email: 'cloud@example.com',
  email_verified: true,
  // Amazon Cognito names the account by a UUID when the user pool signs
  // people in with their email address.
  'cognito:username': '29ce24f8-2061-7070-0096-ab17da357e7e',
  given_name: 'Alex',
  family_name: 'Morgan',
  preferred_username: 'alex_dev',
};

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.()
    ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

/**
 * A stand in for the DevLoop account collection. It behaves like the real
 * one where it matters here: the name inside DevLoop is unique, so a name
 * that somebody else uses is refused instead of taken over.
 */
async function startAuthServer({ initialUsers = [], tokenClaims = baseClaims } = {}) {
  process.env.JWT_SECRET = jwtSecret;
  const users = new Map(initialUsers.map((user) => [user._id.toString(), user]));

  const UserModel = {
    async create(values) {
      const taken = [...users.values()].some((user) => user.username === values.username);
      if (taken) {
        const error = new Error('E11000 duplicate key error');
        error.code = 11000;
        error.keyPattern = { username: 1 };
        throw error;
      }
      const id = `user-${users.size + 1}`;
      const user = { ...values, _id: { toString: () => id }, async save() {} };
      users.set(user._id.toString(), user);
      return user;
    },
    async findOne(query) {
      const matchesCondition = (user, condition) => Object
        .entries(condition)
        .every(([key, value]) => user[key] === value);
      const matches = (user) => {
        if (query.$or) {
          return query.$or.some((condition) => matchesCondition(user, condition));
        }
        return matchesCondition(user, query);
      };
      return [...users.values()].find(matches) ?? null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
  };

  const authController = createAuthController({
    UserModel,
    verifyIdToken: async (token) => {
      if (token !== identityToken) {
        throw new CognitoTokenInvalidError();
      }
      return tokenClaims;
    },
    getOAuthClient: async () => {
      throw new Error('The hosted UI is not used by this flow.');
    },
    getLogoutUrl: () => null,
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter({ authController }));
  app.use((error, _request, response, _next) => {
    console.error('unexpected error:', error);
    response.status(500).json({ error: error.message });
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/api/auth`,
    users,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function exchangeToken(server, body = {}) {
  return fetch(`${server.url}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: identityToken, ...body }),
  });
}

test('an account that is linked to an older Cognito identity is linked again', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'linked-user' },
      firstName: 'Alex',
      lastName: 'Morgan',
      username: 'alex_dev',
      email: 'cloud@example.com',
      // The identity of an account that was deleted and created again.
      cognitoSub: 'cognito-subject-older',
      cognitoUsername: 'cloud@example.com',
      async save() {},
    }],
  });

  try {
    const response = await exchangeToken(server);

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(server.users.size, 1, 'no second account may be created');

    const stored = [...server.users.values()][0];
    assert.equal(stored.cognitoSub, 'cognito-subject-current');
    assert.equal(stored.cognitoUsername, 'cloud@example.com');
    assert.equal(stored.username, 'alex_dev', 'the name inside DevLoop stays the same');

    const sessionCookie = cookieFrom(response, 'authToken');
    assert.ok(sessionCookie, 'the session cookie must be set');

    const currentUser = await fetch(`${server.url}/me`, { headers: { cookie: sessionCookie } });
    assert.equal(currentUser.status, 200);
    assert.equal((await currentUser.json()).user.email, 'cloud@example.com');
  } finally {
    await server.close();
  }
});

test('an account that is linked to the verified identity signs in', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'linked-user' },
      firstName: 'Alex',
      lastName: 'Morgan',
      username: 'alex_dev',
      email: 'cloud@example.com',
      cognitoSub: 'cognito-subject-current',
      cognitoUsername: 'cloud@example.com',
      async save() {},
    }],
  });

  try {
    const response = await exchangeToken(server);

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(server.users.size, 1);
    assert.equal((await response.json()).user.email, 'cloud@example.com');
  } finally {
    await server.close();
  }
});

test('a person that signs up for the first time gets an account', async () => {
  const server = await startAuthServer();

  try {
    const response = await exchangeToken(server, {
      profile: { firstName: 'Alex', lastName: 'Morgan', username: 'alex_dev' },
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(server.users.size, 1);

    const stored = [...server.users.values()][0];
    assert.equal(stored.cognitoSub, 'cognito-subject-current');
    assert.equal(stored.email, 'cloud@example.com');
    assert.equal(stored.username, 'alex_dev');
  } finally {
    await server.close();
  }
});

test('the name of somebody else inside DevLoop is not taken over', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'other-user' },
      firstName: 'Robin',
      lastName: 'Vega',
      username: 'alex_dev',
      email: 'other@example.com',
      cognitoSub: 'cognito-subject-other',
      cognitoUsername: 'other@example.com',
      async save() {},
    }],
  });

  try {
    const response = await exchangeToken(server, {
      profile: { firstName: 'Alex', lastName: 'Morgan', username: 'alex_dev' },
    });

    assert.equal(response.status, 409, await response.clone().text());
    const result = await response.json();
    assert.equal(result.code, 'USERNAME_TAKEN');

    const stored = [...server.users.values()][0];
    assert.equal(stored.email, 'other@example.com', 'the account of somebody else stays untouched');
  } finally {
    await server.close();
  }
});
