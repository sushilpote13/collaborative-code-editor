import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { runJava } from '../services/javaRunner.js';

const router = Router();

router.post('/run', requireAuth, async (request, response, next) => {
  const { source, sourceFiles, input = '' } = request.body ?? {};
  let files;

  if (sourceFiles !== undefined) {
    if (!Array.isArray(sourceFiles) || sourceFiles.length === 0 || sourceFiles.length > 20) {
      return response.status(400).json({ error: 'Provide between 1 and 20 Java source files.' });
    }

    const fileNames = new Set();
    let totalSourceBytes = 0;
    for (const file of sourceFiles) {
      if (
        !file ||
        typeof file.name !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/.test(file.name) ||
        typeof file.source !== 'string'
      ) {
        return response.status(400).json({ error: 'Each source file needs a valid Java filename and text source.' });
      }
      const normalizedName = file.name.toLowerCase();
      if (fileNames.has(normalizedName)) {
        return response.status(400).json({ error: 'Java source filenames must be unique.' });
      }
      fileNames.add(normalizedName);

      const sourceBytes = Buffer.byteLength(file.source, 'utf8');
      if (sourceBytes > 32 * 1024) {
        return response.status(413).json({ error: `${file.name} must be no larger than 32 KB.` });
      }
      totalSourceBytes += sourceBytes;
      if (totalSourceBytes > 128 * 1024) {
        return response.status(413).json({ error: 'The Java project must be no larger than 128 KB.' });
      }
    }

    if (!sourceFiles.some((file) => file.name === 'Main.java')) {
      return response.status(400).json({ error: 'The Java project must include Main.java as its entry point.' });
    }
    files = sourceFiles;
  } else if (typeof source === 'string' && source.trim()) {
    files = [{ name: 'Main.java', source }];
  } else {
    return response.status(400).json({ error: 'Enter Java source code before running it.' });
  }

  if (typeof input !== 'string') {
    return response.status(400).json({ error: 'Program input must be text.' });
  }
  if (Buffer.byteLength(input, 'utf8') > 16 * 1024) {
    return response.status(413).json({ error: 'Program input must be no larger than 16 KB.' });
  }

  try {
    const result = await runJava(files, input);
    return response.status(200).json(result);
  } catch (error) {
    return next(error);
  }
});

export default router;
