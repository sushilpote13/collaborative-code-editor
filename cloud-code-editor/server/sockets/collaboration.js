import jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import Room from '../models/Room.js';
import User from '../models/User.js';
import {
  connectRoomMember,
  disconnectRoomMember,
} from '../services/roomPresence.js';

const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
const fileNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/;
const maxUpdateBytes = 512 * 1024;
const persistenceDelayMs = 200;

function getAuthToken(cookieHeader = '') {
  const tokenCookie = cookieHeader.split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('authToken='));
  if (!tokenCookie) {
    return null;
  }

  try {
    return decodeURIComponent(tokenCookie.slice('authToken='.length));
  } catch {
    return null;
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

function validWorkspace(document) {
  const files = document.getMap('files');
  if (files.size < 1 || files.size > 20 || !files.has('Main.java')) {
    return false;
  }

  let totalBytes = 0;
  for (const [fileName, fileText] of files) {
    if (!(fileText instanceof Y.Text) || !fileNamePattern.test(fileName)) {
      return false;
    }
    const sourceBytes = Buffer.byteLength(fileText.toString(), 'utf8');
    if (sourceBytes > 32 * 1024) {
      return false;
    }
    totalBytes += sourceBytes;
    if (totalBytes > 128 * 1024) {
      return false;
    }
  }
  return true;
}

export function registerCollaborationHandlers(
  io,
  { RoomModel = Room, UserModel = User } = {},
) {
  const documents = new Map();
  const pendingWrites = new Map();
  const persistenceTimers = new Map();

  io.use(async (socket, next) => {
    const token = getAuthToken(socket.request.headers.cookie);
    if (!token) {
      return next(new Error('Authentication required.'));
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next(new Error('Authentication required.'));
    }

    try {
      const user = await UserModel.findById(payload.sub).select(
        '_id username firstName lastName',
      );
      if (!user) {
        return next(new Error('Authentication required.'));
      }

      socket.data.user = {
        id: user._id.toString(),
        username: user.username || null,
        firstName: user.firstName,
        lastName: user.lastName,
      };
      return next();
    } catch (error) {
      console.error('Could not verify the Socket.IO user:', error);
      return next(new Error('Authentication service unavailable.'));
    }
  });

  async function getRoomDocument(room) {
    const existing = documents.get(room.roomId);
    if (existing) {
      return existing;
    }

    const document = new Y.Doc();
    if (room.state) {
      Y.applyUpdate(document, new Uint8Array(room.state), 'database');
    }
    if (!validWorkspace(document)) {
      document.destroy();
      throw new Error('The room workspace is invalid.');
    }
    documents.set(room.roomId, document);
    return document;
  }

  function scheduleRoomPersistence(roomId, document) {
    const previousTimer = persistenceTimers.get(roomId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    const timer = setTimeout(() => {
      if (persistenceTimers.get(roomId) !== timer) {
        return;
      }
      persistenceTimers.delete(roomId);

      const state = Buffer.from(Y.encodeStateAsUpdate(document));
      const previousWrite = pendingWrites.get(roomId) ?? Promise.resolve();
      const write = previousWrite
        .catch(() => {})
        .then(() => RoomModel.updateOne({ roomId }, { $set: { state } }));
      pendingWrites.set(roomId, write);
      write
        .catch((error) => {
          console.error('Could not persist the collaboration workspace:', error);
          io.to(roomId).emit('room:error', {
            error: 'The latest workspace change could not be saved to MongoDB.',
          });
        })
        .finally(() => {
          if (pendingWrites.get(roomId) === write) {
            pendingWrites.delete(roomId);
          }
        });
    }, persistenceDelayMs);
    persistenceTimers.set(roomId, timer);
  }

  function leaveCurrentRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    socket.data.roomId = null;
    const { left, members } = disconnectRoomMember(
      roomId,
      socket.data.user.id,
      socket.id,
    );
    socket.leave(roomId);
    if (left) {
      socket.to(roomId).emit('room:participant-left', left);
    }
    io.to(roomId).emit('room:members', members);
  }

  io.on('connection', (socket) => {
    socket.on('room:join', async (payload, callback) => {
      const acknowledge = typeof callback === 'function' ? callback : () => {};
      const roomId = payload?.roomId;
      if (typeof roomId !== 'string' || !roomIdPattern.test(roomId)) {
        acknowledge({ ok: false, error: 'Enter a valid room ID.' });
        return;
      }

      try {
        const room = await RoomModel.findOne({ roomId });
        if (!room) {
          acknowledge({ ok: false, error: 'This room does not exist. Create a room or check the invite link.' });
          return;
        }
        const document = await getRoomDocument(room);

        if (socket.data.roomId && socket.data.roomId !== roomId) {
          leaveCurrentRoom(socket);
        }
        socket.join(roomId);
        socket.data.roomId = roomId;

        const { joined, members } = connectRoomMember(
          roomId,
          socket.data.user,
          socket.id,
        );
        if (joined) {
          socket.to(roomId).emit('room:participant-joined', socket.data.user);
        }
        io.to(roomId).emit('room:members', members);
        acknowledge({
          ok: true,
          roomId,
          members,
          state: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
        });
      } catch (error) {
        console.error('Could not join collaboration room:', error);
        acknowledge({ ok: false, error: 'Could not join this room. Please try again.' });
      }
    });

    socket.on('room:document-update', (payload) => {
      const roomId = socket.data.roomId;
      const update = toUint8Array(payload?.update);
      const document = roomId && documents.get(roomId);
      if (!document || !update || update.byteLength === 0 || update.byteLength > maxUpdateBytes) {
        socket.emit('room:error', { error: 'The workspace update is invalid or too large.' });
        return;
      }

      const candidate = new Y.Doc();
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document), 'server');
        Y.applyUpdate(candidate, update, 'candidate');
        if (!validWorkspace(candidate)) {
          socket.emit('room:error', { error: 'The update exceeds the workspace limits.' });
          return;
        }

        Y.applyUpdate(document, update, socket.id);
        socket.to(roomId).emit('room:document-update', { update });
        scheduleRoomPersistence(roomId, document);
      } catch {
        socket.emit('room:error', { error: 'The workspace update is invalid.' });
      } finally {
        candidate.destroy();
      }
    });

    socket.on('room:awareness-update', (payload) => {
      const roomId = socket.data.roomId;
      const update = toUint8Array(payload?.update);
      if (!roomId || !update || update.byteLength === 0 || update.byteLength > 16 * 1024) {
        socket.emit('room:error', { error: 'The participant update is invalid.' });
        return;
      }

      socket.to(roomId).emit('room:awareness-update', { update });
    });

    socket.on('room:leave', () => leaveCurrentRoom(socket));
    socket.on('disconnecting', () => leaveCurrentRoom(socket));
  });
}
