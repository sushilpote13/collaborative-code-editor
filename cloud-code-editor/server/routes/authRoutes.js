import { Router } from 'express';
import { createAuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';

export function createAuthRouter({ authController = createAuthController() } = {}) {
  const router = Router();

  router.post('/login', authController.startLogin);
  router.post('/callback', authController.completeLogin);
  router.post('/session', authController.createSession);
  router.post('/token', authController.createSessionFromToken);
  router.post('/resolve-signin', authController.resolveSignInIdentifier);
  router.post('/logout', authController.logout);
  router.get('/me', requireAuth, authController.currentUser);

  return router;
}

export default createAuthRouter();
