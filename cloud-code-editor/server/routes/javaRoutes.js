import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { runJava } from '../services/javaRunner.js';

const router = Router();

router.post('/run', requireAuth, async (request, response, next) => {
  const { source, input = '' } = request.body ?? {};
  if (typeof source !== 'string' || !source.trim()) {
    return response.status(400).json({ error: 'Enter Java source code before running it.' });
  }
  if (typeof input !== 'string') {
    return response.status(400).json({ error: 'Program input must be text.' });
  }
  if (Buffer.byteLength(input, 'utf8') > 16 * 1024) {
    return response.status(413).json({ error: 'Program input must be no larger than 16 KB.' });
  }

  try {
    const result = await runJava(source, input);
    return response.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
