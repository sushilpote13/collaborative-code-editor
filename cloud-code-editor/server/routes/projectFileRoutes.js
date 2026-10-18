import { Router } from 'express';
import Room from '../models/Room.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { isS3ObjectNotFound, s3Storage } from '../services/s3Storage.js';
import { isRoomMember } from '../services/roomPresence.js';

const roomIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
const fileNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/;
const maxFileBytes = 32 * 1024;

function validateProjectFilePath(request, response, next) {
  if (!roomIdPattern.test(request.params.roomId)) {
    return response.status(400).json({ error: 'Enter a valid room ID.' });
  }
  if (!fileNamePattern.test(request.params.fileName)) {
    return response.status(400).json({ error: 'Enter a valid Java filename.' });
  }
  return next();
}

export function createProjectFileRouter({
  RoomModel = Room,
  storage = s3Storage,
  authorizeRoomMember = isRoomMember,
} = {}) {
  const router = Router();

  async function requireProjectRoom(request, response, next) {
    try {
      const room = await RoomModel.findOne({ roomId: request.params.roomId }).select('_id');
      if (!room) {
        return response.status(404).json({ error: 'This room does not exist.' });
      }
      if (!authorizeRoomMember(request.params.roomId, request.auth.userId)) {
        return response.status(403).json({ error: 'Join this room before accessing its project files.' });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  }

  router.get(
    '/:roomId/files',
    requireAuth,
    (request, response, next) => {
      if (!roomIdPattern.test(request.params.roomId)) {
        return response.status(400).json({ error: 'Enter a valid room ID.' });
      }
      return next();
    },
    requireProjectRoom,
    async (request, response, next) => {
      try {
        const files = await storage.listProjectFiles({ roomId: request.params.roomId });
        return response.status(200).json({ files });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.put(
    '/:roomId/files',
    requireAuth,
    (request, response, next) => {
      if (!roomIdPattern.test(request.params.roomId)) {
        return response.status(400).json({ error: 'Enter a valid room ID.' });
      }
      return next();
    },
    requireProjectRoom,
    async (request, response, next) => {
      const { files } = request.body ?? {};
      if (!Array.isArray(files) || files.length < 1 || files.length > 20) {
        return response.status(400).json({ error: 'Provide between 1 and 20 Java project files.' });
      }

      const fileNames = new Set();
      let totalBytes = 0;
      for (const file of files) {
        if (
          !file ||
          typeof file.name !== 'string' ||
          !fileNamePattern.test(file.name) ||
          typeof file.source !== 'string'
        ) {
          return response.status(400).json({ error: 'Each project file needs a valid Java filename and text source.' });
        }
        if (fileNames.has(file.name.toLowerCase())) {
          return response.status(400).json({ error: 'Java filenames must be unique.' });
        }
        fileNames.add(file.name.toLowerCase());
        const fileBytes = Buffer.byteLength(file.source, 'utf8');
        if (fileBytes > maxFileBytes) {
          return response.status(413).json({ error: `${file.name} must be no larger than 32 KB.` });
        }
        totalBytes += fileBytes;
        if (totalBytes > 128 * 1024) {
          return response.status(413).json({ error: 'The Java project must be no larger than 128 KB.' });
        }
      }
      if (!fileNames.has('main.java')) {
        return response.status(400).json({ error: 'The Java project must include Main.java.' });
      }

      try {
        await storage.replaceProjectFiles({ roomId: request.params.roomId, files });
        return response.status(200).json({ files: files.map(({ name }) => name) });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.put(
    '/:roomId/files/:fileName',
    requireAuth,
    validateProjectFilePath,
    requireProjectRoom,
    async (request, response, next) => {
      const { roomId, fileName } = request.params;
      const { source } = request.body ?? {};
      if (typeof source !== 'string') {
        return response.status(400).json({ error: 'Project file source must be text.' });
      }
      if (Buffer.byteLength(source, 'utf8') > maxFileBytes) {
        return response.status(413).json({ error: 'Project files must be no larger than 32 KB.' });
      }

      try {
        const files = await storage.listProjectFiles({ roomId });
        const currentFile = files.find((file) => file.name === fileName);
        if (!currentFile && files.length >= 20) {
          return response.status(413).json({ error: 'A project can contain up to 20 Java files.' });
        }
        const totalBytes = files
          .filter((file) => file.name !== fileName)
          .reduce((total, file) => total + file.size, Buffer.byteLength(source, 'utf8'));
        if (totalBytes > 128 * 1024) {
          return response.status(413).json({ error: 'The Java project must be no larger than 128 KB.' });
        }
        await storage.saveProjectFile({ roomId, fileName, source });
        return response.status(200).json({ name: fileName });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get(
    '/:roomId/files/:fileName',
    requireAuth,
    validateProjectFilePath,
    requireProjectRoom,
    async (request, response, next) => {
      const { roomId, fileName } = request.params;
      try {
        const source = await storage.loadProjectFile({ roomId, fileName });
        return response.status(200).json({ name: fileName, source });
      } catch (error) {
        if (isS3ObjectNotFound(error)) {
          return response.status(404).json({ error: 'This project file has not been saved to S3.' });
        }
        return next(error);
      }
    },
  );

  router.delete(
    '/:roomId/files/:fileName',
    requireAuth,
    validateProjectFilePath,
    requireProjectRoom,
    async (request, response, next) => {
      const { roomId, fileName } = request.params;
      try {
        await storage.deleteProjectFile({ roomId, fileName });
        return response.status(204).end();
      } catch (error) {
        return next(error);
      }
    },
  );

  return router;
}

export default createProjectFileRouter();
