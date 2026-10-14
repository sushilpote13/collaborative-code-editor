import { Router } from 'express';
import {
  currentUser,
  login,
  logout,
  signup,
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.post('/signup', signup);
router.post('/login', login);
router.post('/logout', logout);
router.get('/me', requireAuth, currentUser);

export default router;
