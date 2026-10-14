import 'dotenv/config';
import mongoose from 'mongoose';
import { createApp } from './server/app.js';

const port = 3001;

async function startServer() {
  const mongoUri = process.env.MONGODB_URI;
  const jwtSecret = process.env.JWT_SECRET;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure it.');
  }

  if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace-this')) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB.');

  const app = createApp();
  app.listen(port, '127.0.0.1', () => {
    console.log(`Auth API listening at http://127.0.0.1:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Could not start the auth API:', error.message);
  process.exitCode = 1;
});
