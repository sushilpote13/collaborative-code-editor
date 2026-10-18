import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';

export function createAuthRouter({ authController = createAuthController() } = {}) {
  const router = Router();

  router.post('/signup', authController.signup);
  router.post('/login', authController.login);
  router.post('/logout', authController.logout);
  router.get('/me', requireAuth, authController.currentUser);

  return router;
}

export default createAuthRouter();
