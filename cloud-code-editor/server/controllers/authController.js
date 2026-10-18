import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 24 * 60 * 60 * 1000,
};

function setAuthCookie(response, userId) {
  const token = jwt.sign({}, process.env.JWT_SECRET, {
    subject: userId.toString(),
    expiresIn: '1d',
  });
  response.cookie('authToken', token, cookieOptions);
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username || null,
    email: user.email,
  };
}

function validUsername(username) {
  return typeof username === 'string' && /^[a-z][a-z0-9_]{2,19}$/i.test(username.trim());
}

function validateEmailAndPassword(email, password) {
  return (
    typeof email === 'string' &&
    emailPattern.test(email.trim()) &&
    typeof password === 'string' &&
    password.length >= 8 &&
    Buffer.byteLength(password, 'utf8') <= 72
  );
}

export function createAuthController({ UserModel = User } = {}) {
  async function signup(request, response) {
    const { firstName, lastName, username, email, password } = request.body ?? {};

    if (
      typeof firstName !== 'string' ||
      !firstName.trim() ||
      firstName.trim().length > 80 ||
      typeof lastName !== 'string' ||
      !lastName.trim() ||
      lastName.trim().length > 80 ||
      !validUsername(username) ||
      !validateEmailAndPassword(email, password)
    ) {
      return response.status(400).json({
        error: 'Enter your first and last name, a username (3-20 letters, numbers, or underscores, starting with a letter), valid email, and a password of 8-72 bytes.',
      });
    }

    try {
      const user = await UserModel.create({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        username: username.trim().toLowerCase(),
        email: email.trim().toLowerCase(),
        passwordHash: await bcrypt.hash(password, 12),
      });

      setAuthCookie(response, user._id);
      return response.status(201).json({ user: publicUser(user) });
    } catch (error) {
      if (error.code === 11000) {
        if (error.keyPattern?.username || error.keyValue?.username) {
          return response.status(409).json({
            code: 'USERNAME_TAKEN',
            error: 'That username is already taken. Please choose another.',
          });
        }

        return response.status(409).json({
          code: 'ACCOUNT_EXISTS',
          error: 'An account with this email already exists. Please log in.',
        });
      }
      throw error;
    }
  }

  async function login(request, response) {
    const { email, password } = request.body ?? {};

    if (!validateEmailAndPassword(email, password)) {
      return response.status(400).json({
        error: 'Enter a valid email and a password of 8-72 bytes.',
      });
    }

    const user = await UserModel.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
    if (!user) {
      return response.status(404).json({
        code: 'ACCOUNT_NOT_FOUND',
        error: 'No account was found with this email.',
      });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      return response.status(401).json({ error: 'The email or password is incorrect.' });
    }

    setAuthCookie(response, user._id);
    return response.status(200).json({ user: publicUser(user) });
  }

  async function currentUser(request, response) {
    const user = await UserModel.findById(request.auth.userId);
    if (!user) {
      response.clearCookie('authToken', { path: '/' });
      return response.status(401).json({ error: 'Please log in to continue.' });
    }

    return response.status(200).json({ user: publicUser(user) });
  }

  function logout(_request, response) {
    response.clearCookie('authToken', {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    return response.status(200).json({ loggedOut: true });
  }

  return { currentUser, login, logout, signup };
}

const defaultAuthController = createAuthController();
export const {
  currentUser,
  login,
  logout,
  signup,
} = defaultAuthController;
