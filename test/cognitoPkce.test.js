import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';

const jwtSecret = 'cognito-pkce-test-secret-value-at-least-32-chars';
const claims = {
  sub: 'cognito-pkce-sub',
  email: 'pkce@example.com',
  email_verified: true,
};

process.env.JWT_SECRET = jwtSecret;

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.()
    ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

function decodeTransactionCookie(response) {
  const cookie = cookieFrom(response, 'cognitoTransaction');
  const value = decodeURIComponent(cookie.slice('cognitoTransaction='.length));
  return jwt.verify(value, jwtSecret);
}

function s256Challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function startServer({ getOAuthClient } = {}) {
  const exchangeCalls = [];
  const oauthClient = {
    authorizationUrl(parameters) {
      const query = new URLSearchParams(parameters);
      return `https://cognito.example.test/oauth2/authorize?${query.toString()}`;
    },
    async grant(body) {
      exchangeCalls.push({ body });
      return { id_token: 'verified-id-token' };
    },
  };

  const authController = createAuthController({
    UserModel: {
      async findOne() {
        return null;
      },
      async create(values) {
        return { ...values, _id: { toString: () => 'pkce-user' } };
      },
    },
    verifyIdToken: async () => claims,
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
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    exchangeCalls,
    url: `http://127.0.0.1:${port}/api/auth`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startLogin(server, body = { mode: 'login' }) {
  return fetch(`${server.url}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function completeLogin(server, startResponse, { code = 'auth-code', state } = {}) {
  const authorization = new URL((await startResponse.clone().json()).authorizationUrl);
  return fetch(`${server.url}/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookieFrom(startResponse, 'cognitoTransaction'),
    },
    body: JSON.stringify({ code, state: state ?? authorization.searchParams.get('state') }),
  });
}

test('the authorization request derives an S256 PKCE challenge from a high-entropy verifier', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    assert.equal(start.status, 200);

    const authorization = new URL((await start.json()).authorizationUrl);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');

    const challenge = authorization.searchParams.get('code_challenge');
    const transaction = decodeTransactionCookie(start);
    const verifier = transaction.codeVerifier;

    assert.ok(verifier, 'the transaction must carry a code verifier');
    assert.ok(verifier.length >= 43, 'the verifier must have at least 256 bits of entropy');
    assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
    assert.equal(
      challenge,
      s256Challenge(verifier),
      'the challenge must be the base64url SHA-256 of the verifier',
    );
    assert.notEqual(challenge, verifier, 'the challenge must not be the plain verifier');
  } finally {
    await server.close();
  }
});

test('the code verifier is never exposed to the browser and is sent only during the token exchange', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const body = await start.clone().text();
    const transaction = decodeTransactionCookie(start);

    assert.doesNotMatch(body, new RegExp(transaction.codeVerifier), 'the response must not contain the verifier');
    assert.doesNotMatch(
      start.headers.get('set-cookie') ?? '',
      new RegExp(transaction.codeVerifier),
      'the verifier must not leak into a cookie header',
    );
    assert.match(
      body,
      new RegExp(transaction.nonce),
      'the nonce is a public value and belongs in the authorization request',
    );

    const completed = await completeLogin(server, start);
    assert.equal(completed.status, 200);
    assert.equal(server.exchangeCalls.length, 1);
    assert.equal(server.exchangeCalls[0].body.grant_type, 'authorization_code');
    assert.equal(server.exchangeCalls[0].body.code, 'auth-code');
    assert.equal(server.exchangeCalls[0].body.redirect_uri, 'http://localhost:5173/');
    assert.equal(server.exchangeCalls[0].body.code_verifier, transaction.codeVerifier);
  } finally {
    await server.close();
  }
});

test('every sign-in attempt uses a fresh random state, nonce, and verifier', async () => {
  const server = await startServer();

  try {
    const first = await startLogin(server);
    const second = await startLogin(server);
    const firstAuthorization = new URL((await first.json()).authorizationUrl);
    const secondAuthorization = new URL((await second.json()).authorizationUrl);
    const firstTransaction = decodeTransactionCookie(first);
    const secondTransaction = decodeTransactionCookie(second);

    assert.notEqual(firstAuthorization.searchParams.get('state'), secondAuthorization.searchParams.get('state'));
    assert.notEqual(firstTransaction.nonce, secondTransaction.nonce);
    assert.notEqual(firstTransaction.codeVerifier, secondTransaction.codeVerifier);
    assert.ok(firstTransaction.state.length >= 32);
  } finally {
    await server.close();
  }
});

test('a callback with a mismatched state is rejected before the code is exchanged', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const completed = await completeLogin(server, start, { state: 'tampered-state' });

    assert.equal(completed.status, 401);
    assert.equal(server.exchangeCalls.length, 0, 'the authorization code must not be exchanged');
  } finally {
    await server.close();
  }
});

test('a callback with a state of a different length is rejected without crashing', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const completed = await completeLogin(server, start, { state: 'x' });

    assert.equal(completed.status, 401);
    assert.equal(server.exchangeCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('a callback without an authorization code is rejected before the code is exchanged', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const completed = await completeLogin(server, start, { code: '' });

    assert.equal(completed.status, 401);
    assert.equal(server.exchangeCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('the same authorization code cannot be redeemed twice', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const first = await completeLogin(server, start);
    assert.equal(first.status, 200);

    const replay = await completeLogin(server, start);
    assert.equal(replay.status, 401);
    assert.match((await replay.json()).error, /already been used/i);
    assert.equal(server.exchangeCalls.length, 1, 'the code must be exchanged exactly once');
  } finally {
    await server.close();
  }
});

test('a transaction cookie cannot be replayed after the sign-in flow finished', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const first = await completeLogin(server, start);
    assert.equal(first.status, 200);

    const replay = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieFrom(start, 'cognitoTransaction'),
      },
      body: JSON.stringify({
        code: 'auth-code',
        state: decodeTransactionCookie(start).state,
      }),
    });
    assert.equal(replay.status, 401);
    assert.equal(server.exchangeCalls.length, 1);
  } finally {
    await server.close();
  }
});

test('a transaction cookie signed with another secret is rejected', async () => {
  const server = await startServer();

  try {
    const forged = jwt.sign(
      { purpose: 'cognito-transaction', state: 'forged', nonce: 'n', codeVerifier: 'v' },
      'a-completely-different-signing-secret-value',
    );
    const response = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `cognitoTransaction=${forged}`,
      },
      body: JSON.stringify({ code: 'auth-code', state: 'forged' }),
    });

    assert.equal(response.status, 401);
    assert.equal(server.exchangeCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('a transaction cookie without the Cognito transaction purpose is rejected', async () => {
  const server = await startServer();

  try {
    const wrongPurpose = jwt.sign(
      { purpose: 'cognito-profile', state: 'forged', nonce: 'n', codeVerifier: 'v' },
      jwtSecret,
    );
    const response = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: `cognitoTransaction=${wrongPurpose}`,
      },
      body: JSON.stringify({ code: 'auth-code', state: 'forged' }),
    });

    assert.equal(response.status, 401);
    assert.equal(server.exchangeCalls.length, 0);
  } finally {
    await server.close();
  }
});

test('the OAuth transaction and app session cookies are HTTP-only and SameSite=Lax', async () => {
  const server = await startServer();

  try {
    const start = await startLogin(server);
    const setCookie = start.headers.getSetCookie?.() ?? [];
    const transactionCookie = setCookie.find((value) => value.startsWith('cognitoTransaction='));

    assert.ok(transactionCookie, 'a transaction cookie must be issued');
    assert.match(transactionCookie, /HttpOnly/i);
    assert.match(transactionCookie, /SameSite=Lax/i);
    assert.match(transactionCookie, /Path=\//i);
    assert.match(transactionCookie, /Max-Age=600/i);
  } finally {
    await server.close();
  }
});
