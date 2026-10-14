import jwt from 'jsonwebtoken';

export function requireAuth(request, response, next) {
  const token = request.cookies?.authToken;

  if (!token) {
    return response.status(401).json({ error: 'Please log in to continue.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    request.auth = { userId: payload.sub };
    return next();
  } catch {
    response.clearCookie('authToken', { path: '/' });
    return response.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}
