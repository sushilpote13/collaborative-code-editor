import 'dotenv/config';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import { createApp } from './server/app.js';
import { registerCollaborationHandlers } from './server/sockets/collaboration.js';

const port = 3001;
const retryDelayMs = 10_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectDatabaseWithRetry(mongoUri) {
  while (true) {
    try {
      await mongoose.connect(mongoUri, {
        ...(process.env.MONGODB_TLS === 'true' ? { tls: true } : {}),
        ...(process.env.MONGODB_TLS_CA_FILE ? { tlsCAFile: process.env.MONGODB_TLS_CA_FILE } : {}),
        serverSelectionTimeoutMS: 5000,
      });
      console.log('Connected to the configured MongoDB-compatible database.');
      return;
    } catch (error) {
      console.error(
        `MongoDB is unavailable: ${error.message}. Retrying in ${retryDelayMs / 1000} seconds.`,
      );
      await delay(retryDelayMs);
    }
  }
}

async function startServer() {
  const mongoUri = process.env.MONGODB_URI;
  const jwtSecret = process.env.JWT_SECRET;

  if (!mongoUri) {
    throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure it.');
  }

  if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace-this')) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
  }

  const server = createServer(createApp({
    databaseReady: () => mongoose.connection.readyState === 1,
  }));
  const io = new SocketServer(server, { maxHttpBufferSize: 1024 * 1024 });
  registerCollaborationHandlers(io);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Please stop the process using port ${port} or choose another port.`);
    } else {
      console.error('Server error:', error.message);
    }
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`DevLoop API and collaboration server listening at http://127.0.0.1:${port}`);
  });

  // Keep the frontend and API available while Atlas connectivity is repaired.
  // Database-dependent routes return a clear 503 until Mongoose reconnects.
  void connectDatabaseWithRetry(mongoUri);
}

startServer().catch((error) => {
  console.error('Could not start the DevLoop server:', error.message);
  process.exitCode = 1;
});
