import cookieParser from 'cookie-parser';
import express from 'express';
import authRoutes from './routes/authRoutes.js';
import javaRoutes from './routes/javaRoutes.js';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '128kb' }));
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/java', javaRoutes);
  app.use((request, response) => {
    response.status(404).json({ error: 'Route not found.' });
  });
  app.use((error, _request, response, next) => {
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
      return response.status(error.status).json({ error: error.message });
    }

    console.error('API error:', error);
    return response.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
