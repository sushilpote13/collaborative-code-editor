import { Router } from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { updateRoomMember } from '../services/roomPresence.js';

const router = Router();
const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

router.put('/:roomId/presence', requireAuth, async (request, response, next) => {
  const { roomId } = request.params;
  if (!roomIdPattern.test(roomId)) {
    return response.status(400).json({ error: 'Enter a valid room ID.' });
  }

  try {
    const user = await User.findById(request.auth.userId).select('username firstName lastName');
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

export default router;
