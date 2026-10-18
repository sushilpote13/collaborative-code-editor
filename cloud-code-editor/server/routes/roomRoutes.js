import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { initialCode } from '../../shared/initialWorkspace.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { s3Storage } from '../services/s3Storage.js';
import { updateRoomMember } from '../services/roomPresence.js';

const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

export function createRoomRouter({
  RoomModel = Room,
  UserModel = User,
  storage = s3Storage,
} = {}) {
  const roomRouter = Router();

  roomRouter.post('/', requireAuth, async (request, response, next) => {
    try {
      const user = await UserModel.findById(request.auth.userId).select('_id');
      if (!user) {
        return response.status(401).json({ error: 'Please log in to create a room.' });
      }

      const roomId = randomUUID();
      const document = new Y.Doc();
      const mainFile = new Y.Text();
      mainFile.insert(0, initialCode);
      document.getMap('files').set('Main.java', mainFile);

      try {
        const initialFiles = [{ name: 'Main.java', source: initialCode }];
        await storage.replaceProjectFiles({
          roomId,
          files: initialFiles,
        });
        const verifiedFiles = await storage.loadProjectFiles({ roomId });
        if (
          verifiedFiles.length !== initialFiles.length ||
          verifiedFiles[0].name !== initialFiles[0].name ||
          verifiedFiles[0].source !== initialFiles[0].source
        ) {
          throw new Error('The new project file could not be verified in S3.');
        }
        const room = await RoomModel.create({
          roomId,
          createdBy: user._id,
        });
        return response.status(201).json({ roomId: room.roomId });
      } finally {
        document.destroy();
      }

    } catch (error) {
      return next(error);
    }
  });

  roomRouter.put('/:roomId/presence', requireAuth, async (request, response, next) => {
    const { roomId } = request.params;
    if (!roomIdPattern.test(roomId)) {
      return response.status(400).json({ error: 'Enter a valid room ID.' });
    }

    try {
      const room = await RoomModel.findOne({ roomId }).select('roomId');
      if (!room) {
        return response.status(404).json({ error: 'This room does not exist.' });
      }

      const user = await UserModel.findById(request.auth.userId).select('username firstName lastName');
      if (!user) {
        return response.status(401).json({ error: 'Please log in to continue.' });
      }

      const members = updateRoomMember(roomId, {
        id: user._id.toString(),
        username: user.username || null,
        firstName: user.firstName,
        lastName: user.lastName,
      });
      return response.status(200).json({ members });
    } catch (error) {
      return next(error);
    }
  });

  return roomRouter;
}

export default createRoomRouter();
