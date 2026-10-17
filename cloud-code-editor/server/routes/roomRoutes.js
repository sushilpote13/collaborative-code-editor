import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { initialCode } from '../../shared/initialWorkspace.js';
import Room from '../models/Room.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { updateRoomMember } from '../services/roomPresence.js';

const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

export function createRoomRouter({ RoomModel = Room, UserModel = User } = {}) {
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

      const room = await RoomModel.create({
        roomId,
        createdBy: user._id,
        state: Buffer.from(Y.encodeStateAsUpdate(document)),
      });
      document.destroy();

      return response.status(201).json({ roomId: room.roomId });
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
