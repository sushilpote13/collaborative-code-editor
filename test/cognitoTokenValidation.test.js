import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
  CognitoConfigurationError,
  CognitoTokenInvalidError,
  verifyCognitoIdToken,
} from '../server/services/cognito.js';

const region = 'ap-southeast-2';
const userPoolId = 'ap-southeast-2_TestPool1';
const clientId = 'testpublicclientid123456';
const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
const keyId = 'test-signing-key';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' });
const jwks = {
  keys: [{
    kid: keyId,
    kty: 'RSA',
    alg: 'RS256',
    use: 'sig',
    n: publicJwk.n,
    e: publicJwk.e,
  }],
};

function signIdToken(overrides = {}, { key = privateKey, kid = keyId } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'cognito-subject',
    aud: clientId,
    iss: issuer,
    token_use: 'id',
    email: 'token@example.com',
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return jwt.sign(payload, key, { algorithm: 'RS256', keyid: kid });
}

function useEnvironment(overrides = {}) {
  const previous = { ...process.env };
  process.env.VITE_AWS_REGION = region;
  process.env.VITE_COGNITO_USER_POOL_ID = userPoolId;
  process.env.VITE_COGNITO_CLIENT_ID = clientId;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    process.env = previous;
  };
}

test('a correctly signed Cognito ID token is accepted and its claims are returned', async () => {
  const restore = useEnvironment();
  try {
    const claims = await verifyCognitoIdToken(signIdToken(), { jwks });
    assert.equal(claims.sub, 'cognito-subject');
    assert.equal(claims.email, 'token@example.com');
    assert.equal(claims.token_use, 'id');
    assert.equal(claims.aud, clientId);
  } finally {
    restore();
  }
});

test('an ID token signed by an unknown key is rejected', async () => {
  const restore = useEnvironment();
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken({}, { key: otherKeys.privateKey }), { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an ID token with a tampered payload is rejected', async () => {
  const restore = useEnvironment();
  try {
    const token = signIdToken();
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.email = 'attacker@example.com';
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    await assert.rejects(
      () => verifyCognitoIdToken(`${header}.${forgedPayload}.${signature}`, { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an expired ID token is rejected', async () => {
  const restore = useEnvironment();
  try {
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken({ iat: now - 7200, exp: now - 3600 }), { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an ID token issued by another user pool is rejected', async () => {
  const restore = useEnvironment();
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(
        signIdToken({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OtherPool' }),
        { jwks },
      ),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an ID token issued for another app client is rejected', async () => {
  const restore = useEnvironment();
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken({ aud: 'a-different-client-id' }), { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an access token is rejected where an identity token is required', async () => {
  const restore = useEnvironment();
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken({ token_use: 'access' }), { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('an ID token without a subject is rejected', async () => {
  const restore = useEnvironment();
  try {
    const token = jwt.sign(
      {
        aud: clientId,
        iss: issuer,
        token_use: 'id',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      privateKey,
      { algorithm: 'RS256', keyid: keyId },
    );
    await assert.rejects(
      () => verifyCognitoIdToken(token, { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('a malformed or empty token is rejected without contacting Cognito', async () => {
  const restore = useEnvironment();
  try {
    await assert.rejects(
      () => verifyCognitoIdToken('not-a-jwt', { jwks }),
      CognitoTokenInvalidError,
    );
    await assert.rejects(
      () => verifyCognitoIdToken('', { jwks }),
      CognitoTokenInvalidError,
    );
  } finally {
    restore();
  }
});

test('missing Cognito settings raise a configuration error instead of a token error', async () => {
  const restore = useEnvironment({ VITE_COGNITO_CLIENT_ID: undefined });
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken(), { jwks }),
      CognitoConfigurationError,
    );
  } finally {
    restore();
  }
});

test('a user pool from another region is rejected as a configuration error', async () => {
  const restore = useEnvironment({ VITE_COGNITO_USER_POOL_ID: 'us-east-1_TestPool1' });
  try {
    await assert.rejects(
      () => verifyCognitoIdToken(signIdToken(), { jwks }),
      CognitoConfigurationError,
    );
  } finally {
    restore();
  }
});
