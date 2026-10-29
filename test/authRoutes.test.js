import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createAuthController } from '../server/controllers/authController.js';
import User from '../server/models/User.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';
import { CognitoConfigurationError } from '../server/services/cognito.js';

const jwtSecret = 'auth-route-cognito-migration-test-secret';
const cognitoToken = 'verified-cognito-id-token';
const claims = {
  sub: 'cognito-user-sub',
  email: 'cloud@example.com',
  email_verified: true,
};

test('MongoDB user schema keeps legacy password hashes intact but never requires them', () => {
  const passwordHash = User.schema.path('passwordHash');
  assert.ok(passwordHash, 'the legacy password hash field must stay in the schema');
  assert.equal(passwordHash.options.required, false);
  assert.equal(passwordHash.options.select, false);
  assert.equal(User.schema.path('cognitoSub').options.unique, true);
});

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.()
    ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

function decodeTransactionCookie(response) {
  const cookie = cookieFrom(response, 'cognitoTransaction');
  return jwt.verify(decodeURIComponent(cookie.slice('cognitoTransaction='.length)), jwtSecret);
}

async function startAuthServer({
  initialUsers = [],
  tokenClaims = claims,
  getOAuthClient,
  verifyIdToken,
  grantError,
} = {}) {
  process.env.JWT_SECRET = jwtSecret;
  const users = new Map(initialUsers.map((user) => {
    if (typeof user.save !== 'function') {
      user.save = async () => {};
    }
    return [user._id.toString(), user];
  }));
  const UserModel = {
    async create(values) {
      if ([...users.values()].some((user) => user.username === values.username)) {
        throw Object.assign(new Error('Duplicate username'), {
          code: 11000,
          keyPattern: { username: 1 },
          keyValue: { username: values.username },
        });
      }
      if ([...users.values()].some((user) => user.email === values.email)) {
        throw Object.assign(new Error('Duplicate email'), {
          code: 11000,
          keyPattern: { email: 1 },
          keyValue: { email: values.email },
        });
      }
      const id = `user-${users.size + 1}`;
      const user = {
        ...values,
        _id: { toString: () => id },
        async save() {},
      };
      users.set(user._id.toString(), user);
      return user;
    },
    async findOne(query) {
      return [...users.values()].find((user) =>
        Object.entries(query).every(([key, value]) => user[key] === value),
      ) ?? null;
    },
    async findById(id) {
      return users.get(id) ?? null;
    },
  };

  const callbackCalls = [];
  const oauthClient = {
    authorizationUrl(parameters) {
      const query = new URLSearchParams(parameters);
      return `https://cognito.example.test/oauth2/authorize?${query.toString()}`;
    },
    async grant(body) {
      callbackCalls.push({ body });
      if (grantError) {
        throw grantError;
      }
      return { id_token: cognitoToken };
    },
  };
  const authController = createAuthController({
    UserModel,
    verifyIdToken: verifyIdToken ?? (async (token) => {
      if (token !== cognitoToken) {
        throw new Error('Invalid Cognito token');
      }
      return tokenClaims;
    }),
    getOAuthClient: getOAuthClient ?? (async () => ({
      client: oauthClient,
      callbackUrl: 'http://localhost:5173/',
    })),
    getLogoutUrl: () => null,
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', createAuthRouter({ authController }));
  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: error.message });
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    callbackCalls,
    users,
    url: `http://127.0.0.1:${port}/api/auth`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function beginLogin(server, body = { mode: 'login' }) {
  const response = await fetch(`${server.url}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

async function finishLogin(server, startResponse, state, code = 'authorization-code') {
  const response = await fetch(`${server.url}/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookieFrom(startResponse, 'cognitoTransaction'),
    },
    body: JSON.stringify({ code, state }),
  });
  return response;
}

test('authorization code login uses state, nonce, and PKCE before creating an HTTP-only app session', async () => {
  const existingUser = {
    _id: { toString: () => 'user-1' },
    firstName: 'Cloud',
    lastName: 'User',
    username: 'cloud_user',
    email: 'cloud@example.com',
    cognitoSub: claims.sub,
  };
  const server = await startAuthServer({ initialUsers: [existingUser] });

  try {
    const start = await beginLogin(server, { mode: 'login', email: 'CLOUD@example.com' });
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json();
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.searchParams.get('scope'), 'openid email');
    assert.equal(authorization.searchParams.get('login_hint'), 'cloud@example.com');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorization.searchParams.get('code_challenge'));
    assert.ok(authorization.searchParams.get('nonce'));
    assert.ok(authorization.searchParams.get('state'));
    assert.match(cookieFrom(start, 'cognitoTransaction'), /^cognitoTransaction=/);
    assert.match(start.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(start.headers.get('set-cookie'), /SameSite=Lax/i);

    const state = authorization.searchParams.get('state');
    const completed = await finishLogin(server, start, state);
    assert.equal(completed.status, 200, await completed.clone().text());
    const result = await completed.json();
    assert.deepEqual(result.user, {
      id: 'user-1',
      firstName: 'Cloud',
      lastName: 'User',
      username: 'cloud_user',
      email: 'cloud@example.com',
    });
    assert.equal(result.returnTo, '/meetings');
    assert.equal(server.users.get('user-1').cognitoSub, claims.sub);
    assert.equal('passwordHash' in server.users.get('user-1'), false);

    const callback = server.callbackCalls[0];
    assert.equal(callback.body.grant_type, 'authorization_code');
    assert.equal(callback.body.code, 'authorization-code');
    assert.equal(callback.body.redirect_uri, 'http://localhost:5173/');
    assert.ok(callback.body.code_verifier);
    const authCookie = cookieFrom(completed, 'authToken');
    assert.match(completed.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(completed.headers.get('set-cookie'), /Max-Age=3600/i);

    const currentUser = await fetch(`${server.url}/me`, {
      headers: { cookie: authCookie },
    });
    assert.equal(currentUser.status, 200);
    assert.deepEqual((await currentUser.json()).user, result.user);
  } finally {
    await server.close();
  }
});

test('signup sends a profile to Cognito callback and provisions it without storing a password', async () => {
  const server = await startAuthServer();

  try {
    const start = await beginLogin(server, {
      mode: 'signup',
      email: 'cloud@example.com',
      profile: {
        firstName: 'Cloud',
        lastName: 'User',
        username: 'Cloud_User',
      },
    });
    const authorization = new URL((await start.json()).authorizationUrl);
    assert.equal(authorization.searchParams.get('screen_hint'), 'signup');

    const completed = await finishLogin(
      server,
      start,
      authorization.searchParams.get('state'),
    );
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal((await completed.json()).user.username, 'cloud_user');
    assert.equal(server.users.size, 1);
    assert.equal('passwordHash' in server.users.get('user-1'), false);
  } finally {
    await server.close();
  }
});

test('state mismatch is rejected without exchanging the authorization code', async () => {
  const server = await startAuthServer();

  try {
    const start = await beginLogin(server);
    const completed = await finishLogin(server, start, 'attacker-state');
    assert.equal(completed.status, 401);
    assert.equal(server.callbackCalls.length, 0);
    assert.equal(server.users.size, 0);
  } finally {
    await server.close();
  }
});

test('login without a DevLoop profile requires a one-time verified profile completion', async () => {
  const server = await startAuthServer();

  try {
    const start = await beginLogin(server);
    const authorization = new URL((await start.json()).authorizationUrl);
    const completed = await finishLogin(
      server,
      start,
      authorization.searchParams.get('state'),
    );
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), {
      profileRequired: true,
      email: 'cloud@example.com',
      returnTo: '/meetings',
    });

    const profileCookie = cookieFrom(completed, 'cognitoProfile');
    assert.match(completed.headers.get('set-cookie'), /HttpOnly/i);
    const profileResponse = await fetch(`${server.url}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: profileCookie,
      },
      body: JSON.stringify({
        firstName: 'Cloud',
        lastName: 'User',
        username: 'cloud_user',
      }),
    });
    assert.equal(profileResponse.status, 200);
    const profileResult = await profileResponse.json();
    assert.equal(profileResult.user.email, 'cloud@example.com');
    assert.equal(server.users.size, 1);
  } finally {
    await server.close();
  }
});

test('unverified Cognito email claims are rejected before MongoDB writes', async () => {
  const server = await startAuthServer({
    tokenClaims: { ...claims, email_verified: false },
  });

  try {
    const start = await beginLogin(server);
    const authorization = new URL((await start.json()).authorizationUrl);
    const completed = await finishLogin(
      server,
      start,
      authorization.searchParams.get('state'),
    );
    assert.equal(completed.status, 403);
    assert.equal(server.users.size, 0);
  } finally {
    await server.close();
  }
});

test('a verified Cognito identity can link an existing matching-email profile', async () => {
  const existingUser = {
    _id: { toString: () => 'legacy-user' },
    firstName: 'Legacy',
    lastName: 'User',
    username: 'legacy_user',
    email: 'cloud@example.com',
    async save() {},
  };
  const server = await startAuthServer({ initialUsers: [existingUser] });

  try {
    const start = await beginLogin(server);
    const authorization = new URL((await start.json()).authorizationUrl);
    const completed = await finishLogin(
      server,
      start,
      authorization.searchParams.get('state'),
    );
    assert.equal(completed.status, 200);
    assert.equal(existingUser.cognitoSub, claims.sub);
    assert.equal((await completed.json()).user.id, 'legacy-user');
  } finally {
    await server.close();
  }
});

test('an expired app session is rejected and logout clears app and OAuth cookies', async () => {
  const server = await startAuthServer();

  try {
    const invalidSession = await fetch(`${server.url}/me`, {
      headers: { cookie: 'authToken=not-a-valid-jwt' },
    });
    assert.equal(invalidSession.status, 401);
    assert.match(invalidSession.headers.get('set-cookie'), /authToken=;/);

    const logout = await fetch(`${server.url}/logout`, { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { loggedOut: true });
    assert.match(logout.headers.get('set-cookie'), /authToken=;/);
    assert.match(logout.headers.get('set-cookie'), /cognitoTransaction=;/);
    assert.match(logout.headers.get('set-cookie'), /cognitoProfile=;/);
  } finally {
    await server.close();
  }
});

test('missing backend OAuth settings return a clear configuration error without contacting Cognito', async () => {
  const server = await startAuthServer({
    getOAuthClient: async () => {
      throw new CognitoConfigurationError(
        'Cognito OAuth is not configured. Set COGNITO_CLIENT_SECRET in the backend .env.',
      );
    },
  });

  try {
    const response = await beginLogin(server);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      code: 'COGNITO_NOT_CONFIGURED',
      error: 'Cognito OAuth is not configured. Set COGNITO_CLIENT_SECRET in the backend .env.',
    });
    assert.equal(server.callbackCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('OAuth transaction cookies cannot be forged without the server signing secret', async () => {
  process.env.JWT_SECRET = jwtSecret;
  const forged = jwt.sign({ state: 'forged' }, 'different-signing-secret');
  const server = await startAuthServer();

  try {
    const response = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `cognitoTransaction=${forged}`,
      },
      body: JSON.stringify({ code: 'authorization-code', state: 'forged' }),
    });
    assert.equal(response.status, 401);
    assert.equal(server.callbackCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('an identity token that carries the nonce of the sign-in request is accepted', async () => {
  let expectedNonce = '';
  const server = await startAuthServer({
    verifyIdToken: async () => ({ ...claims, nonce: expectedNonce }),
  });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    assert.ok(transaction.nonce, 'the authorization request must carry a nonce');
    expectedNonce = transaction.nonce;

    const completed = await finishLogin(server, start, transaction.state);
    assert.equal(completed.status, 200, await completed.clone().text());
  } finally {
    await server.close();
  }
});

test('an identity token with a different nonce is rejected', async () => {
  const server = await startAuthServer({
    verifyIdToken: async () => ({ ...claims, nonce: 'a-nonce-from-another-sign-in' }),
  });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    const completed = await finishLogin(server, start, transaction.state);

    assert.equal(completed.status, 401);
    const result = await completed.json();
    assert.equal(result.code, 'COGNITO_IDENTITY_REJECTED');
    assert.equal(server.users.size, 0, 'no account may be created for a rejected sign-in');
  } finally {
    await server.close();
  }
});

test('an identity token without a nonce claim is accepted because Cognito omits it on a resumed session', async () => {
  const server = await startAuthServer({
    verifyIdToken: async () => ({ ...claims }),
  });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    const completed = await finishLogin(server, start, transaction.state);

    assert.equal(completed.status, 200, await completed.clone().text());
  } finally {
    await server.close();
  }
});

test('signing up with an email that already has a DevLoop account asks the user to sign in', async () => {
  const existingUser = {
    _id: { toString: () => 'linked-user' },
    firstName: 'Cloud',
    lastName: 'User',
    username: 'cloud_user',
    email: 'cloud@example.com',
    cognitoSub: claims.sub,
  };
  const server = await startAuthServer({ initialUsers: [existingUser] });

  try {
    const start = await beginLogin(server, {
      mode: 'signup',
      email: 'CLOUD@example.com',
      profile: {
        firstName: 'Cloud',
        lastName: 'User',
        username: 'Cloud_User',
      },
    });

    assert.equal(start.status, 409);
    const result = await start.json();
    assert.equal(result.code, 'ACCOUNT_EXISTS');
    assert.match(result.error, /sign in instead/i);
    assert.equal(result.authorizationUrl, undefined, 'no signup may be started for an existing account');
    assert.equal(server.callbackCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('a legacy account without a Cognito identity may still sign up and is linked afterwards', async () => {
  const legacyUser = {
    _id: { toString: () => 'legacy-user' },
    firstName: 'Legacy',
    lastName: 'User',
    username: 'legacy_user',
    email: 'cloud@example.com',
    cognitoSub: null,
    async save() {},
  };
  const server = await startAuthServer({ initialUsers: [legacyUser] });

  try {
    const start = await beginLogin(server, {
      mode: 'signup',
      email: 'cloud@example.com',
      profile: {
        firstName: 'Cloud',
        lastName: 'User',
        username: 'Cloud_User',
      },
    });
    assert.equal(start.status, 200);

    const authorization = new URL((await start.json()).authorizationUrl);
    const completed = await finishLogin(server, start, authorization.searchParams.get('state'));

    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal(legacyUser.cognitoSub, claims.sub);
    assert.equal((await completed.json()).user.id, 'legacy-user');
    assert.equal(server.users.size, 1, 'the legacy account must not be duplicated');
  } finally {
    await server.close();
  }
});

test('a rejected sign-in attempt is reported with the reason Cognito gave', async () => {
  const grantError = Object.assign(
    new Error('invalid_grant: the authorization code is invalid, expired, revoked, or does not redirect to the redirect_uri'),
    {
      name: 'OPError',
      error: 'invalid_grant',
      error_description: 'Invalid grant: the authorization code is invalid, expired, revoked, or does not redirect to the redirect_uri',
    },
  );
  const server = await startAuthServer({ grantError });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    const completed = await finishLogin(server, start, transaction.state);

    assert.equal(completed.status, 401);
    const result = await completed.json();
    assert.equal(result.code, 'COGNITO_SIGN_IN_FAILED');
    assert.match(result.error, /start again/i);
  } finally {
    await server.close();
  }
});

test('a Cognito client rejection is reported as a server configuration problem', async () => {
  const grantError = Object.assign(new Error('invalid_client'), {
    name: 'OPError',
    error: 'invalid_client',
  });
  const server = await startAuthServer({ grantError });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    const completed = await finishLogin(server, start, transaction.state);

    assert.equal(completed.status, 503);
    const result = await completed.json();
    assert.equal(result.code, 'COGNITO_CLIENT_REJECTED');
  } finally {
    await server.close();
  }
});

test('an unverified Cognito email reports its own error code', async () => {
  const server = await startAuthServer({
    tokenClaims: { ...claims, email_verified: false },
  });

  try {
    const start = await beginLogin(server);
    const transaction = decodeTransactionCookie(start);
    const completed = await finishLogin(server, start, transaction.state);

    assert.equal(completed.status, 403);
    const result = await completed.json();
    assert.equal(result.code, 'EMAIL_NOT_VERIFIED');
    assert.match(result.error, /not verified/i);
    assert.equal(server.users.size, 0);
  } finally {
    await server.close();
  }
});
