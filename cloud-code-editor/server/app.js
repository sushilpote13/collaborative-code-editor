import cookieParser from 'cookie-parser';
import express from 'express';
import authRoutes from './routes/authRoutes.js';
import javaRoutes from './routes/javaRoutes.js';
import projectFileRoutes from './routes/projectFileRoutes.js';
import roomRoutes from './routes/roomRoutes.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
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
