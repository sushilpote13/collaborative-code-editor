import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';
import { CognitoTokenInvalidError } from '../server/services/cognito.js';

const jwtSecret = 'auth-token-session-test-secret-value-that-is-long-enough';
const identityToken = 'verified-cognito-identity-token';

const baseClaims = {
  sub: 'cognito-subject-1',
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

async function startAuthServer({ initialUsers = [], tokenClaims = baseClaims, verifyIdToken } = {}) {
  process.env.JWT_SECRET = jwtSecret;
  const users = new Map(initialUsers.map((user) => [user._id.toString(), user]));

  const UserModel = {
    async create(values) {
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
    verifyIdToken: verifyIdToken ?? (async (token) => {
      if (token !== identityToken) {
        throw new CognitoTokenInvalidError();
      }
      return tokenClaims;
    }),
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

test('a verified identity token starts a DevLoop session', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: identityToken }),
    });

    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.user.email, 'cloud@example.com');
    assert.equal(result.user.username, 'alex_dev');
    assert.equal(result.user.firstName, 'Alex');
    assert.equal(result.returnTo, '/meetings');

    const sessionCookie = cookieFrom(response, 'authToken');
    assert.ok(sessionCookie, 'the session cookie must be set');

    const currentUser = await fetch(`${server.url}/me`, { headers: { cookie: sessionCookie } });
    assert.equal(currentUser.status, 200);
    assert.equal((await currentUser.json()).user.email, 'cloud@example.com');
  } finally {
    await server.close();
  }
});

test('the account remembers the name that Cognito knows it by', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: identityToken }),
    });
    assert.equal(response.status, 200);

    const stored = [...server.users.values()][0];
    assert.equal(stored.cognitoSub, 'cognito-subject-1');
    assert.equal(stored.cognitoUsername, 'cloud@example.com');
  } finally {
    await server.close();
  }
});

test('an existing DevLoop account is linked instead of duplicated', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'legacy-user' },
      firstName: 'Alex',
      lastName: 'Morgan',
      username: 'alex_dev',
      email: 'cloud@example.com',
      cognitoSub: null,
      async save() {},
    }],
  });

  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: identityToken }),
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(server.users.size, 1, 'no second account may be created');

    const stored = [...server.users.values()][0];
    assert.equal(stored.cognitoSub, 'cognito-subject-1');
    assert.equal(stored.cognitoUsername, 'cloud@example.com');
  } finally {
    await server.close();
  }
});

test('an identity token without display details asks for a profile', async () => {
  const server = await startAuthServer({
    tokenClaims: {
      sub: 'cognito-subject-2',
      email: 'new@example.com',
      email_verified: true,
      'cognito:username': '7f1c9a30-4c53-4a26-9d1b-2f0e3c5d6a71',
    },
  });

  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: identityToken }),
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.profileRequired, true);
    assert.equal(result.email, 'new@example.com');
    assert.equal(server.users.size, 0);
  } finally {
    await server.close();
  }
});

test('the internal Cognito name is never used as the name inside DevLoop', async () => {
  const server = await startAuthServer({
    tokenClaims: {
      sub: 'cognito-subject-3',
      email: 'uuid@example.com',
      email_verified: true,
      'cognito:username': '7f1c9a30-4c53-4a26-9d1b-2f0e3c5d6a71',
    },
  });

  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken: identityToken,
        profile: { firstName: 'Alex', lastName: 'Morgan', username: 'alex_dev' },
      }),
    });

    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.user.username, 'alex_dev');
    assert.equal(result.user.email, 'uuid@example.com');
  } finally {
    await server.close();
  }
});

test('an identity token that cannot be verified is rejected', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'a-token-that-is-not-verified' }),
    });

    assert.equal(response.status, 401);
    const result = await response.json();
    assert.equal(result.code, 'COGNITO_IDENTITY_REJECTED');
  } finally {
    await server.close();
  }
});

test('an identity token with an unverified email address is rejected', async () => {
  const server = await startAuthServer({
    tokenClaims: { ...baseClaims, email_verified: false },
  });

  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: identityToken }),
    });

    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.code, 'EMAIL_NOT_VERIFIED');
  } finally {
    await server.close();
  }
});

test('a request without an identity token is rejected', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.code, 'ID_TOKEN_REQUIRED');
  } finally {
    await server.close();
  }
});

test('a sign-in identifier resolves to the name that Cognito knows', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'linked-user' },
      firstName: 'Alex',
      lastName: 'Morgan',
      username: 'alex_dev',
      email: 'cloud@example.com',
      cognitoSub: 'cognito-subject-1',
      cognitoUsername: 'cloud@example.com',
      async save() {},
    }],
  });

  try {
    const response = await fetch(`${server.url}/resolve-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud@example.com' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { account: 'cloud@example.com' });
  } finally {
    await server.close();
  }
});

test('an account that still holds the old Cognito name resolves to its email address', async () => {
  const server = await startAuthServer({
    initialUsers: [{
      _id: { toString: () => 'legacy-user' },
      firstName: 'Alex',
      lastName: 'Morgan',
      username: 'alex_dev',
      email: 'cloud@example.com',
      cognitoSub: 'cognito-subject-1',
      cognitoUsername: '29ce24f8-2061-7070-0096-ab17da357e7e',
      async save() {},
    }],
  });

  try {
    const response = await fetch(`${server.url}/resolve-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'cloud@example.com' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      { account: 'cloud@example.com' },
      'the internal Cognito name is a UUID and cannot be signed in with',
    );
  } finally {
    await server.close();
  }
});

test('an unknown sign-in identifier resolves to nothing', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/resolve-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'nobody@example.com' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { account: null });
  } finally {
    await server.close();
  }
});

test('an empty sign-in identifier is rejected', async () => {
  const server = await startAuthServer();
  try {
    const response = await fetch(`${server.url}/resolve-signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: '   ' }),
    });

    assert.equal(response.status, 400);
  } finally {
    await server.close();
  }
});
