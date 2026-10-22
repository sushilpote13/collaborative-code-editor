import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import cookieParser from 'cookie-parser';
import express from 'express';
import { Issuer } from 'openid-client';
import { createAuthController } from '../server/controllers/authController.js';
import { createAuthRouter } from '../server/routes/authRoutes.js';
import { verifyCognitoIdToken } from '../server/services/cognito.js';

const jwtSecret = 'cognito-token-exchange-test-secret-value';
const region = 'ap-southeast-2';
const userPoolId = 'ap-southeast-2_TestPool1';
const clientId = 'testpublicclientid123456';
const issuerUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
const callbackUrl = 'http://localhost:5173/';

process.env.JWT_SECRET = jwtSecret;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const jwks = {
  keys: [{
    kid: 'test-signing-key',
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    n: publicJwk.n,
    e: publicJwk.e,
  }],
};

function cookieFrom(response, name) {
  const cookies = response.headers.getSetCookie?.()
    ?? [response.headers.get('set-cookie') ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  return cookie ? cookie.split(';')[0] : '';
}

/**
 * A small stand-in for the Amazon Cognito endpoints. It behaves like the
 * hosted UI plus the token endpoint, so the DevLoop callback can be exercised
 * with a real authorization code, a real PKCE verifier, and a really signed
 * identity token without contacting AWS.
 */
async function startIdentityProvider({ signingKey = privateKey } = {}) {
  const authorizations = new Map();
  const exchanges = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        issuer: `http://127.0.0.1:${port}/${userPoolId}`,
        authorization_endpoint: `http://127.0.0.1:${port}/oauth2/authorize`,
        token_endpoint: `http://127.0.0.1:${port}/oauth2/token`,
        jwks_uri: `http://127.0.0.1:${port}/jwks.json`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'email'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }

    if (url.pathname === '/oauth2/authorize') {
      const code = randomBytes(24).toString('base64url');
      authorizations.set(code, {
        codeChallenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri'),
      });
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state'));
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return;
    }

    if (url.pathname === '/oauth2/token') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        exchanges.push(Object.fromEntries(body.entries()));
        const authorization = authorizations.get(body.get('code'));
        const verifier = body.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');

        if (!authorization || authorization.codeChallenge !== challenge) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }

        const now = Math.floor(Date.now() / 1000);
        const idToken = signIdToken({
          sub: 'mock-cognito-subject',
          email: 'exchange@example.com',
          email_verified: true,
          nonce: authorization.nonce,
          iat: now,
          exp: now + 3600,
        }, signingKey);

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id_token: idToken,
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }));
      });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    exchanges,
    discoveryUrl: `http://127.0.0.1:${port}/.well-known/openid-configuration`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function signIdToken(overrides = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    aud: clientId,
    iss: issuerUrl,
    token_use: 'id',
    iat: now,
    exp: now + 3600,
    ...overrides,
  }, key);
}

function signJwt(payload, key = privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-signing-key', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signBytes('RSA-SHA256', Buffer.from(`${header}.${body}`), key).toString('base64url');
  return `${header}.${body}.${signature}`;
}

async function startDevLoopServer(provider) {
  const issuer = await Issuer.discover(provider.discoveryUrl);
  const oauthClient = new issuer.Client({
    client_id: clientId,
    token_endpoint_auth_method: 'none',
    redirect_uris: [callbackUrl],
    response_types: ['code'],
  });

  let createdUser = null;

  const previousEnvironment = { ...process.env };
  process.env.VITE_AWS_REGION = region;
  process.env.VITE_COGNITO_USER_POOL_ID = userPoolId;
  process.env.VITE_COGNITO_CLIENT_ID = clientId;

  const authController = createAuthController({
    UserModel: {
      async findOne() {
        return null;
      },
      async create(values) {
        const user = { ...values, _id: { toString: () => 'exchange-user' } };
        createdUser = user;
        return user;
      },
      async findById() {
        return createdUser;
      },
    },
    verifyIdToken: (token) => verifyCognitoIdToken(token, { jwks }),
    getOAuthClient: async () => ({ client: oauthClient, callbackUrl }),
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
    async close() {
      process.env = previousEnvironment;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('a real authorization code is exchanged with PKCE and the identity token is verified', async () => {
  const provider = await startIdentityProvider();
  const server = await startDevLoopServer(provider);

  try {
    const start = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'signup',
        email: 'exchange@example.com',
        profile: { firstName: 'Ex', lastName: 'Change', username: 'ex_change' },
      }),
    });
    assert.equal(start.status, 200);
    const { authorizationUrl } = await start.json();

    const hostedUi = await fetch(authorizationUrl, { redirect: 'manual' });
    assert.equal(hostedUi.status, 302);
    const redirected = new URL(hostedUi.headers.get('location'));
    const code = redirected.searchParams.get('code');
    const state = redirected.searchParams.get('state');
    assert.equal(state, new URL(authorizationUrl).searchParams.get('state'));

    const completed = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieFrom(start, 'cognitoTransaction'),
      },
      body: JSON.stringify({ code, state }),
    });
    assert.equal(completed.status, 200, await completed.clone().text());

    const exchange = provider.exchanges[0];
    assert.equal(exchange.grant_type, 'authorization_code');
    assert.equal(exchange.code, code);
    assert.equal(exchange.redirect_uri, callbackUrl);
    assert.equal(exchange.client_id, clientId);
    assert.ok(exchange.code_verifier, 'the code verifier must be sent to the token endpoint');

    const result = await completed.json();
    assert.equal(result.user.email, 'exchange@example.com');
    assert.equal(result.user.username, 'ex_change');

    const authCookie = cookieFrom(completed, 'authToken');
    const currentUser = await fetch(`${server.url}/me`, { headers: { cookie: authCookie } });
    assert.equal(currentUser.status, 200);
    assert.equal((await currentUser.json()).user.email, 'exchange@example.com');
  } finally {
    await server.close();
    await provider.close();
  }
});

test('an identity token that was signed with another key is rejected after the exchange', async () => {
  const provider = await startIdentityProvider({ signingKey: otherPrivateKey });
  const server = await startDevLoopServer(provider);

  try {
    const start = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'login' }),
    });
    const { authorizationUrl } = await start.json();
    const hostedUi = await fetch(authorizationUrl, { redirect: 'manual' });
    const redirected = new URL(hostedUi.headers.get('location'));

    const completed = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieFrom(start, 'cognitoTransaction'),
      },
      body: JSON.stringify({
        code: redirected.searchParams.get('code'),
        state: redirected.searchParams.get('state'),
      }),
    });

    assert.equal(completed.status, 401);
    const result = await completed.json();
    assert.equal(result.code, 'COGNITO_IDENTITY_REJECTED');
  } finally {
    await server.close();
    await provider.close();
  }
});

test('a token endpoint that refuses the code verifier stops the sign-in', async () => {
  const provider = await startIdentityProvider();
  const server = await startDevLoopServer(provider);

  try {
    const start = await fetch(`${server.url}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'login' }),
    });
    const { authorizationUrl } = await start.json();
    const hostedUi = await fetch(authorizationUrl, { redirect: 'manual' });
    const redirected = new URL(hostedUi.headers.get('location'));

    // The provider only accepts the code when the verifier matches the
    // challenge of the authorization request, so the exchange below fails.
    provider.exchanges.length = 0;
    const completed = await fetch(`${server.url}/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: cookieFrom(start, 'cognitoTransaction'),
      },
      body: JSON.stringify({
        code: 'a-code-that-was-never-issued',
        state: redirected.searchParams.get('state'),
      }),
    });

    assert.equal(completed.status, 401);
    const result = await completed.json();
    assert.equal(result.code, 'COGNITO_SIGN_IN_FAILED');
    assert.match(result.error, /start again/i);
  } finally {
    await server.close();
    await provider.close();
  }
});
