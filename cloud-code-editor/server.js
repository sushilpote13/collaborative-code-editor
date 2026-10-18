import 'dotenv/config';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './server/app.js';
import { registerCollaborationHandlers } from './server/sockets/collaboration.js';

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

  await mongoose.connect(mongoUri, {
    ...(process.env.MONGODB_TLS === 'true' ? { tls: true } : {}),
    ...(process.env.MONGODB_TLS_CA_FILE ? { tlsCAFile: process.env.MONGODB_TLS_CA_FILE } : {}),
  });
  console.log('Connected to the configured MongoDB-compatible database.');

  const server = createServer(createApp());
  const io = new SocketServer(server, { maxHttpBufferSize: 1024 * 1024 });
  registerCollaborationHandlers(io);

  server.listen(port, '127.0.0.1', () => {
    console.log(`DevLoop API and collaboration server listening at http://127.0.0.1:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Could not start the DevLoop server:', error.message);
  process.exitCode = 1;
});
