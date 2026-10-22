import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const SESSION_COOKIE_NAME = 'authToken';
export const SESSION_TTL_SECONDS = 60 * 60;

const SESSION_PURPOSE = 'devloop-session';

// Session ids that were explicitly revoked (for example on sign-out). The
// list lives in the API process memory, so it is cleared when the API
// restarts. That only shortens a revoked session, it never extends one.
const revokedSessions = new Map();

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

export function getSigningSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
  }
  return secret;
}

function pruneRevokedSessions() {
  const now = Date.now();
  for (const [id, expiresAt] of revokedSessions) {
    if (expiresAt <= now) {
      revokedSessions.delete(id);
    }
  }
}

export function createSessionToken({ userId, cognitoSub = null } = {}) {
  if (!userId) {
    throw new Error('A session token requires a user id.');
  }

  return jwt.sign(
    {
      purpose: SESSION_PURPOSE,
      jti: randomUUID(),
      cognitoSub: cognitoSub ?? null,
    },
    getSigningSecret(),
    { subject: userId.toString(), expiresIn: `${SESSION_TTL_SECONDS}s` },
  );
}

export function revokeSessionToken(token) {
  if (typeof token !== 'string' || !token) {
    return false;
  }

  let payload;
  try {
    payload = jwt.verify(token, getSigningSecret());
  } catch {
    return false;
  }

  if (payload?.purpose !== SESSION_PURPOSE || !payload.jti) {
    return false;
  }

  pruneRevokedSessions();
  revokedSessions.set(payload.jti, (payload.exp ?? 0) * 1000);
  return true;
}

export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) {
    return null;
  }

  const secret = getSigningSecret();

  try {
    const payload = jwt.verify(token, secret);
    if (payload?.purpose !== SESSION_PURPOSE || !payload.sub) {
      return null;
    }
    pruneRevokedSessions();
    if (payload.jti && revokedSessions.has(payload.jti)) {
      return null;
    }
    return {
      userId: payload.sub,
      cognitoSub: typeof payload.cognitoSub === 'string' ? payload.cognitoSub : null,
      sessionId: typeof payload.jti === 'string' ? payload.jti : null,
    };
  } catch {
    return null;
  }
}

export function readSessionCookie(cookieHeader = '') {
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return null;
  }

  const prefix = `${SESSION_COOKIE_NAME}=`;
  const cookie = cookieHeader.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!cookie) {
    return null;
  }

  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return null;
  }
}
