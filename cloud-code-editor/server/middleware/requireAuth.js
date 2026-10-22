import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from '../services/session.js';

export function requireAuth(request, response, next) {
  const token = request.cookies?.[SESSION_COOKIE_NAME];

  if (!token) {
    return response.status(401).json({ error: 'Please log in to continue.' });
  }

  const session = verifySessionToken(token);
  if (!session) {
    response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
    return response.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }

  request.auth = { userId: session.userId, cognitoSub: session.cognitoSub };
  return next();
}
