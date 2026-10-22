import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';
import {
  createSessionToken,
  revokeSessionToken,
  verifySessionToken,
} from '../server/services/session.js';

const jwtSecret = 'auth-session-test-secret-value-at-least-32-chars';
const cognitoToken = 'verified-cognito-id-token';
const claims = {
  sub: 'cognito-session-sub',
  email: 'session@example.com',
  email_verified: true,
};

process.env.JWT_SECRET = jwtSecret;

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.()
    ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

async function startAuthServer({ users = new Map(), getLogoutUrl = () => null } = {}) {
  const UserModel = {
    async findOne(query) {
      return [...users.values()].find((user) =>
        Object.entries(query).every(([key, value]) => user[key] === value),
      ) ?? null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
    async create(values) {
      const user = { ...values, _id: { toString: () => 'session-user' } };
      users.set(user._id.toString(), user);
      return user;
    },
  };

  const oauthClient = {
    authorizationUrl: (parameters) => `https://cognito.example.test/oauth2/authorize?${new URLSearchParams(parameters)}`,
    async grant() {
      return { id_token: cognitoToken };
    },
  };

  const authController = createAuthController({
    UserModel,
    verifyIdToken: async () => claims,
    getOAuthClient: async () => ({ client: oauthClient, callbackUrl: 'http://localhost:5173/' }),
    getLogoutUrl,
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter({ authController }));

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

async function signIn(server) {
  const start = await fetch(`${server.url}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'signup',
      profile: { firstName: 'Session', lastName: 'User', username: 'session_user' },
    }),
  });
  const authorization = new URL((await start.json()).authorizationUrl);
  const completed = await fetch(`${server.url}/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookieFrom(start, 'cognitoTransaction'),
    },
    body: JSON.stringify({
      code: 'authorization-code',
      state: authorization.searchParams.get('state'),
    }),
  });
  return { start, completed };
}

test('a signed-in user receives a hardened HTTP-only app session cookie', async () => {
  const server = await startAuthServer();

  try {
    const { completed } = await signIn(server);
    assert.equal(completed.status, 200);

    const sessionCookie = (completed.headers.getSetCookie?.() ?? [])
      .find((value) => value.startsWith('authToken='));
    assert.ok(sessionCookie, 'an app session cookie must be issued');
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
    assert.match(sessionCookie, /Path=\//i);
    assert.match(sessionCookie, /Max-Age=3600/i);
    assert.doesNotMatch(sessionCookie, /Secure/i, 'the local http session must stay usable');
  } finally {
    await server.close();
  }
});

test('the app session cookie is a server-signed token, not the Cognito token', async () => {
  const server = await startAuthServer();

  try {
    const { completed } = await signIn(server);
    const cookie = cookieFrom(completed, 'authToken');
    const token = decodeURIComponent(cookie.slice('authToken='.length));
    const payload = jwt.decode(token);

    assert.notEqual(token, cognitoToken);
    assert.equal(payload.purpose, 'devloop-session');
    assert.equal(payload.cognitoSub, claims.sub);
    assert.ok(payload.exp > payload.iat);
  } finally {
    await server.close();
  }
});

test('the current user endpoint returns the signed-in profile', async () => {
  const server = await startAuthServer();

  try {
    const { completed } = await signIn(server);
    const cookie = cookieFrom(completed, 'authToken');
    const response = await fetch(`${server.url}/me`, { headers: { cookie } });

    assert.equal(response.status, 200);
    const { user } = await response.json();
    assert.equal(user.email, claims.email);
    assert.equal(user.id, 'session-user');
  } finally {
    await server.close();
  }
});

test('a protected route rejects a request without a session cookie', async () => {
  const server = await startAuthServer();

  try {
    const response = await fetch(`${server.url}/me`);
    assert.equal(response.status, 401);
    assert.match((await response.json()).error, /log in/i);
  } finally {
    await server.close();
  }
});

test('a protected route rejects a forged session cookie and clears it', async () => {
  const server = await startAuthServer();

  try {
    const response = await fetch(`${server.url}/me`, {
      headers: { cookie: 'authToken=not-a-valid-session' },
    });

    assert.equal(response.status, 401);
    assert.match(
      (response.headers.getSetCookie?.() ?? []).join(';'),
      /authToken=;/,
      'the rejected cookie must be cleared',
    );
  } finally {
    await server.close();
  }
});

test('a session token signed with another secret is rejected', async () => {
  const server = await startAuthServer();

  try {
    const forged = jwt.sign(
      { purpose: 'devloop-session' },
      'a-totally-different-signing-secret-value',
      { subject: 'session-user', expiresIn: '1h' },
    );
    const response = await fetch(`${server.url}/me`, {
      headers: { cookie: `authToken=${forged}` },
    });

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('a token without the session purpose cannot be used as an app session', async () => {
  const server = await startAuthServer();

  try {
    const wrongPurpose = jwt.sign(
      { purpose: 'cognito-profile' },
      jwtSecret,
      { subject: 'session-user', expiresIn: '1h' },
    );
    const response = await fetch(`${server.url}/me`, {
      headers: { cookie: `authToken=${wrongPurpose}` },
    });

    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('a session for a deleted user is rejected', async () => {
  const users = new Map();
  const server = await startAuthServer({ users });

  try {
    const { completed } = await signIn(server);
    const cookie = cookieFrom(completed, 'authToken');
    assert.equal((await fetch(`${server.url}/me`, { headers: { cookie } })).status, 200);

    users.clear();
    const response = await fetch(`${server.url}/me`, { headers: { cookie } });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test('logging out clears the app session and the OAuth flow cookies', async () => {
  const server = await startAuthServer();

  try {
    const { completed } = await signIn(server);
    const cookie = cookieFrom(completed, 'authToken');

    const logout = await fetch(`${server.url}/logout`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { loggedOut: true });

    const cleared = (logout.headers.getSetCookie?.() ?? []).join(';');
    assert.match(cleared, /authToken=;/);
    assert.match(cleared, /cognitoTransaction=;/);
    assert.match(cleared, /cognitoProfile=;/);

    const afterLogout = await fetch(`${server.url}/me`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401, 'the session must not survive a logout');
  } finally {
    await server.close();
  }
});

test('logging out returns the Cognito sign-out URL when one is configured', async () => {
  const server = await startAuthServer({
    getLogoutUrl: () => 'https://cognito.example.test/logout?client_id=abc&logout_uri=http://localhost:5173/',
  });

  try {
    const logout = await fetch(`${server.url}/logout`, { method: 'POST' });
    const result = await logout.json();

    assert.equal(result.loggedOut, true);
    assert.equal(
      result.logoutUrl,
      'https://cognito.example.test/logout?client_id=abc&logout_uri=http://localhost:5173/',
    );
  } finally {
    await server.close();
  }
});

test('session tokens are only accepted when they carry the session purpose', () => {
  const valid = createSessionToken({ userId: 'session-user', cognitoSub: 'sub' });
  const session = verifySessionToken(valid);
  assert.equal(session.userId, 'session-user');
  assert.equal(session.cognitoSub, 'sub');
  assert.ok(session.sessionId, 'a session must carry a revocable session id');

  assert.equal(verifySessionToken(jwt.sign({}, jwtSecret, { subject: 'x' })), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken('garbage'), null);
});

test('a revoked session token stops working immediately', () => {
  const token = createSessionToken({ userId: 'session-user' });
  assert.ok(verifySessionToken(token));

  assert.equal(revokeSessionToken(token), true);
  assert.equal(verifySessionToken(token), null, 'a revoked session must be rejected');
});

test('revoking an invalid or unrelated token is a no-op', () => {
  assert.equal(revokeSessionToken('not-a-token'), false);
  assert.equal(revokeSessionToken(''), false);
  assert.equal(revokeSessionToken(jwt.sign({ purpose: 'cognito-profile' }, jwtSecret)), false);
});

test('an expired session token is rejected', () => {
  const expired = jwt.sign(
    { purpose: 'devloop-session' },
    jwtSecret,
    { subject: 'session-user', expiresIn: '-1s' },
  );
  assert.equal(verifySessionToken(expired), null);
});
