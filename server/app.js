import cookieParser from 'cookie-parser';
import express from 'express';
import authRoutes from './routes/authRoutes.js';
import javaRoutes from './routes/javaRoutes.js';
import projectFileRoutes from './routes/projectFileRoutes.js';
import roomRoutes from './routes/roomRoutes.js';

export function createApp({ databaseReady = () => true } = {}) {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.get('/api/health', (_request, response) => {
    const ready = databaseReady();
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      database: ready ? 'connected' : 'unavailable',
    });
  });
  app.use('/api', (request, response, next) => {
    const databaseIndependentRoute = request.path === '/auth/login'
      || request.path === '/auth/logout'
      || request.path.startsWith('/java/');
    if (databaseReady() || databaseIndependentRoute) {
      return next();
    }
    response.setHeader('Retry-After', '10');
    return response.status(503).json({
      code: 'DATABASE_UNAVAILABLE',
      error: 'The DevLoop database is unavailable. Check the MongoDB Atlas network access list and try again.',
    });
  });
  app.use('/api/auth', authRoutes);
  app.use('/api/java', javaRoutes);
  app.use('/api/projects', projectFileRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use((request, response) => {
    response.status(404).json({ error: 'Route not found.' });
  });
  app.use(handleApiError);

  return app;
}

export function handleApiError(error, _request, response, next) {
  if (response.headersSent) {
    return next(error);
  }

  if (error.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large.' });
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'Request body must be valid JSON.' });
  }

  if (error.status === 413 || error.status === 503) {
    if (error.status === 503 && typeof response.setHeader === 'function') {
      response.setHeader('Retry-After', '3');
    }
    return response.status(error.status).json({ error: error.message });
  }

  if (
    error.name === 'CredentialsProviderError' ||
    typeof error.$metadata?.httpStatusCode === 'number'
  ) {
    console.error('Cloud storage API error:', error.name, error.message);
    if (typeof response.setHeader === 'function') {
      response.setHeader('Retry-After', '5');
    }
    return response.status(503).json({
      error: 'Cloud file storage is unavailable. Configure AWS credentials and S3 access for the server.',
    });
  }

  console.error('API error:', error);
  return response.status(500).json({ error: 'Internal server error.' });
}
