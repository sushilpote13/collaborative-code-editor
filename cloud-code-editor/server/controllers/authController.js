import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { generators } from 'openid-client';
import User from '../models/User.js';
import {
  CognitoConfigurationError,
  CognitoTokenInvalidError,
  CognitoVerificationUnavailableError,
  assertCognitoNonce,
  verifyCognitoIdToken,
} from '../services/cognito.js';
import {
  createCognitoLogoutUrl,
  getCognitoOAuthClient,
} from '../services/cognitoOAuth.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  getSigningSecret,
  revokeSessionToken,
  sessionCookieOptions,
} from '../services/session.js';

const transactionCookieName = 'cognitoTransaction';
const profileCookieName = 'cognitoProfile';
const transactionTtlSeconds = 10 * 60;

const consumedTransactions = new Map();

function pruneConsumedTransactions() {
  const now = Date.now();
  for (const [id, expiresAt] of consumedTransactions) {
    if (expiresAt <= now) {
      consumedTransactions.delete(id);
    }
  }
}

function timingSafeEqualStrings(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') {
    return false;
  }
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

const usernamePattern = /^[a-z][a-z0-9_]{2,19}$/i;

function isProfileUsername(value) {
  return typeof value === 'string' && usernamePattern.test(value.trim());
}

function validProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    return false;
  }
  const { firstName, lastName, username } = profile;
  return isProfileUsername(username)
    && typeof firstName === 'string'
    && firstName.trim().length > 0
    && firstName.trim().length <= 80
    && typeof lastName === 'string'
    && lastName.trim().length > 0
    && lastName.trim().length <= 80;
}

function validReturnTo(value) {
  return typeof value === 'string'
    && (value === '/meetings' || /^\/editor\/[A-Za-z0-9_-]{3,40}$/.test(value));
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

function setAuthCookie(response, user) {
  const token = createSessionToken({
    userId: user._id,
    cognitoSub: user.cognitoSub || null,
  });
  response.cookie(SESSION_COOKIE_NAME, token, {
    ...sessionCookieOptions,
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function clearFlowCookies(response) {
  response.clearCookie(transactionCookieName, sessionCookieOptions);
  response.clearCookie(profileCookieName, sessionCookieOptions);
}

// The cookie carries the identity of the person between the two steps of the
// hosted UI flow. It keeps the email address of the account twice: once in
// the form the database looks accounts up by, and once in the form Cognito
// signs the account in with.
function issueProfileCookie(response, { sub, email, account }, returnTo) {
  const token = jwt.sign({
    purpose: 'cognito-profile',
    sub,
    email,
    account,
    returnTo,
  }, getSigningSecret(), { expiresIn: '10m' });
  response.cookie(profileCookieName, token, {
    ...sessionCookieOptions,
    maxAge: 10 * 60 * 1000,
  });
}

function normalizeEmail(claims) {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.sub || !email || !verified) {
    return null;
  }
  return email;
}

// The identity token carries the display details of the account, so the
// server can build the DevLoop profile without trusting the browser.
//
// The name of a person inside DevLoop is the preferred_username attribute of
// the account. The name Cognito signs the account in with is the email
// address, so it is never used as the name inside DevLoop.
function profileFromClaims(claims) {
  const read = (value) => (typeof value === 'string' ? value.trim() : '');
  const preferred = read(claims.preferred_username);
  return {
    firstName: read(claims.given_name),
    lastName: read(claims.family_name),
    username: isProfileUsername(preferred) ? preferred : '',
  };
}

// Amazon Cognito signs people in with the email address of their account,
// because the user pool uses the email address as the sign-in attribute. The
// account is therefore known by that address, and the address is kept in the
// case the person registered with, because Cognito compares it exactly.
function cognitoUsernameFromClaims(claims) {
  const email = typeof claims.email === 'string' ? claims.email.trim() : '';
  return email || null;
}

// The name the sign-in screen has to send to Cognito. Accounts that were
// stored before the user pool signed people in with their email address hold
// the internal Cognito user name in that field, and that name is a UUID, so
// only an email address is taken from it.
function cognitoSignInName(user) {
  const stored = typeof user?.cognitoUsername === 'string' ? user.cognitoUsername.trim() : '';
  if (stored.includes('@')) {
    return stored;
  }
  const email = typeof user?.email === 'string' ? user.email.trim() : '';
  return email || null;
}

function verifyProfileCookie(request) {
  const token = request.cookies?.[profileCookieName];
  if (!token) {
    return null;
  }
  try {
    const payload = jwt.verify(token, getSigningSecret());
    if (payload.purpose !== 'cognito-profile' || !payload.sub || !payload.email) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function describeOAuthError(error) {
  const description = error?.error_description || error?.error || error?.message || '';
  if (typeof description !== 'string') {
    return '';
  }
  return description
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 200);
}

// Cognito reports why it refused to hand out tokens. Each entry turns that
// provider error into a message the person in front of the browser can act
// on, and into the status code that matches the cause: a configuration
// problem is a server problem, everything else is a failed sign-in.
const tokenExchangeFailures = {
  invalid_grant: {
    status: 401,
    code: 'COGNITO_SIGN_IN_FAILED',
    message: 'Cognito rejected the sign-in. The sign-in request may have expired or already been used. Please start again.',
  },
  invalid_client: {
    status: 503,
    code: 'COGNITO_CLIENT_REJECTED',
    message: 'The DevLoop server could not authenticate with Cognito. Check VITE_COGNITO_CLIENT_ID and COGNITO_CLIENT_SECRET in the backend .env.',
  },
  unauthorized_client: {
    status: 503,
    code: 'COGNITO_CLIENT_REJECTED',
    message: 'This Cognito app client may not exchange sign-in codes. Check the allowed OAuth flows of the app client.',
  },
  invalid_scope: {
    status: 503,
    code: 'COGNITO_CLIENT_REJECTED',
    message: 'This Cognito app client does not allow the openid and email scopes DevLoop needs.',
  },
  access_denied: {
    status: 401,
    code: 'COGNITO_SIGN_IN_DENIED',
    message: 'Cognito denied the sign-in. Please start again.',
  },
  server_error: {
    status: 503,
    code: 'COGNITO_UNAVAILABLE',
    message: 'Cognito could not complete the sign-in. Please try again in a moment.',
  },
  temporarily_unavailable: {
    status: 503,
    code: 'COGNITO_UNAVAILABLE',
    message: 'Cognito is temporarily unavailable. Please try again in a moment.',
  },
};

function describeTokenExchangeFailure(error) {
  const providerCode = typeof error?.error === 'string' ? error.error : '';
  const known = tokenExchangeFailures[providerCode];
  if (known) {
    return known;
  }

  const detail = describeOAuthError(error);
  return {
    status: 401,
    code: 'COGNITO_SIGN_IN_FAILED',
    message: detail
      ? `Cognito could not complete the sign-in: ${detail}. Please start again.`
      : 'Cognito could not complete the sign-in. Please start again.',
  };
}

export function createAuthController({
  UserModel = User,
  verifyIdToken = verifyCognitoIdToken,
  getOAuthClient = getCognitoOAuthClient,
  getLogoutUrl = createCognitoLogoutUrl,
} = {}) {
  async function findOrCreateUser(claims, email, profile) {
    const cognitoUsername = cognitoUsernameFromClaims(claims);
    let user = await UserModel.findOne({ cognitoSub: claims.sub });
    if (user) {
      if (cognitoUsername && user.cognitoUsername !== cognitoUsername) {
        user.cognitoUsername = cognitoUsername;
        await user.save();
      }
      return { user };
    }

    user = await UserModel.findOne({ email });
    if (user) {
      if (user.cognitoSub && user.cognitoSub !== claims.sub) {
        // Amazon Cognito knows one account per email address in a user pool,
        // so a different subject for the same address means the account this
        // row was linked to is no longer the account Cognito issues for that
        // address: it was deleted and created again, or the pool was replaced.
        // The identity token was just verified against the pool of this
        // server, so the person in front of the browser controls the address
        // and the account is linked to that identity again. Refusing the
        // sign-in here would leave a confirmed Cognito account that can never
        // reach its DevLoop account.
        console.warn(
          `[DevLoop] The account ${email} was linked to an older Cognito identity`
          + ' and is linked to the verified identity again.',
        );
      }
      user.cognitoSub = claims.sub;
      if (cognitoUsername) {
        user.cognitoUsername = cognitoUsername;
      }
      await user.save();
      return { user };
    }

    if (!validProfile(profile)) {
      return { profileRequired: true };
    }

    try {
      user = await UserModel.create({
        cognitoSub: claims.sub,
        cognitoUsername,
        firstName: profile.firstName.trim(),
        lastName: profile.lastName.trim(),
        username: profile.username.trim().toLowerCase(),
        email,
      });
      return { user };
    } catch (error) {
      if (error.code !== 11000) {
        throw error;
      }
      const duplicateUser = await UserModel.findOne({ cognitoSub: claims.sub });
      if (duplicateUser) {
        return { user: duplicateUser };
      }
      const duplicateUsername = error.keyPattern?.username || error.keyValue?.username;
      return {
        error: {
          status: 409,
          body: {
            code: duplicateUsername ? 'USERNAME_TAKEN' : 'ACCOUNT_EXISTS',
            error: duplicateUsername
              ? 'That username is already taken. Please choose another.'
              : 'An account with this email already exists.',
          },
        },
      };
    }
  }

  async function findExistingAccountByEmail(email) {
    try {
      return await UserModel.findOne({ email });
    } catch (error) {
      // A failed lookup must never block a sign-in, so the check is skipped
      // and the account is linked or created during the callback instead.
      console.error('Could not look up an existing DevLoop account:', error.message);
      return null;
    }
  }

  async function startLogin(request, response) {
    const { mode = 'login', email: inputEmail = '', profile = {}, returnTo } = request.body ?? {};
    if (mode !== 'login' && mode !== 'signup') {
      return response.status(400).json({ error: 'Choose login or signup to continue.' });
    }

    const email = typeof inputEmail === 'string' ? inputEmail.trim().toLowerCase() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (mode === 'signup' && !validProfile(profile)) {
      return response.status(400).json({ error: 'Enter a valid DevLoop profile before signing up.' });
    }

    if (mode === 'signup' && email) {
      const existingAccount = await findExistingAccountByEmail(email);
      if (existingAccount?.cognitoSub) {
        return response.status(409).json({
          code: 'ACCOUNT_EXISTS',
          error: 'This email address already has a DevLoop account. Sign in instead of creating another account.',
        });
      }
    }


    try {
      const { client } = await getOAuthClient();
      const state = generators.state();
      const nonce = generators.nonce();
      const codeVerifier = generators.codeVerifier();
      const codeChallenge = generators.codeChallenge(codeVerifier, 'S256');
      const transaction = jwt.sign({
        purpose: 'cognito-transaction',
        jti: generators.state(),
        state,
        nonce,
        codeVerifier,
        mode,
        profile: mode === 'signup' ? profile : null,
        returnTo: validReturnTo(returnTo) ? returnTo : '/meetings',
      }, getSigningSecret(), { expiresIn: `${transactionTtlSeconds}s` });
      response.cookie(transactionCookieName, transaction, {
        ...sessionCookieOptions,
        maxAge: transactionTtlSeconds * 1000,
      });

      const authorizationUrl = client.authorizationUrl({
        scope: 'openid email',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(email ? { login_hint: email } : {}),
        ...(mode === 'signup' ? { screen_hint: 'signup' } : {}),
      });
      return response.status(200).json({ authorizationUrl });
    } catch (error) {
      if (error instanceof CognitoConfigurationError) {
        return response.status(503).json({
          code: 'COGNITO_NOT_CONFIGURED',
          error: error.message,
        });
      }
      if (typeof response.setHeader === 'function') {
        response.setHeader('Retry-After', '3');
      }
      return response.status(503).json({
        code: 'COGNITO_UNAVAILABLE',
        error: 'Cognito sign-in is temporarily unavailable. Please try again.',
      });
    }
  }

  async function completeLogin(request, response, next) {
    const { code, state } = request.body ?? {};

    let transaction;
    try {
      transaction = jwt.verify(
        request.cookies?.[transactionCookieName] ?? '',
        getSigningSecret(),
      );
    } catch {
      return response.status(401).json({
        code: 'TRANSACTION_EXPIRED',
        error: 'The Cognito login has expired. Please start again.',
      });
    }

    if (transaction.purpose !== 'cognito-transaction') {
      clearFlowCookies(response);
      return response.status(401).json({
        code: 'INVALID_SIGN_IN_STATE',
        error: 'The Cognito login could not be verified. Please start again.',
      });
    }

    pruneConsumedTransactions();
    if (transaction.jti && consumedTransactions.has(transaction.jti)) {
      clearFlowCookies(response);
      return response.status(401).json({
        code: 'SIGN_IN_ALREADY_USED',
        error: 'This Cognito sign-in link has already been used. Please start again.',
      });
    }
    if (
      typeof code !== 'string'
      || !code
      || typeof state !== 'string'
      || !timingSafeEqualStrings(state, transaction.state)
    ) {
      clearFlowCookies(response);
      return response.status(401).json({
        code: 'INVALID_SIGN_IN_STATE',
        error: 'The Cognito login could not be verified. Please start again.',
      });
    }

    if (transaction.jti) {
      consumedTransactions.set(
        transaction.jti,
        Date.now() + transactionTtlSeconds * 1000,
      );
    }

    try {
      const { client, callbackUrl } = await getOAuthClient();
      // The code is exchanged with the token endpoint directly instead of
      // through the client callback helper, because the identity token is
      // verified below with the Cognito aware verifier and with the nonce
      // check that belongs to this sign-in request.
      const tokenSet = await client.grant({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl,
        code_verifier: transaction.codeVerifier,
      });
      if (!tokenSet?.id_token) {
        clearFlowCookies(response);
        return response.status(401).json({
          code: 'COGNITO_SIGN_IN_FAILED',
          error: 'Cognito did not return a verified identity. Please try again.',
        });
      }

      const claims = await verifyIdToken(tokenSet.id_token);
      assertCognitoNonce(claims, transaction.nonce);
      const email = normalizeEmail(claims);
      if (!email) {
        clearFlowCookies(response);
        return response.status(403).json({
          code: 'EMAIL_NOT_VERIFIED',
          error: 'Your email address is not verified in Cognito yet. Confirm the email that Cognito sent you, then sign in again.',
        });
      }

      const returnTo = validReturnTo(transaction.returnTo) ? transaction.returnTo : '/meetings';
      issueProfileCookie(
        response,
        { sub: claims.sub, email, account: cognitoUsernameFromClaims(claims) },
        returnTo,
      );
      const result = await findOrCreateUser(
        claims,
        email,
        transaction.mode === 'signup' ? transaction.profile : null,
      );
      if (result.error) {
        return response.status(result.error.status).json({
          ...result.error.body,
          email,
          returnTo,
        });
      }
      if (result.profileRequired) {
        return response.status(200).json({
          profileRequired: true,
          email,
          returnTo,
        });
      }

      response.clearCookie(profileCookieName, sessionCookieOptions);
      clearFlowCookies(response);
      setAuthCookie(response, result.user);
      return response.status(200).json({
        user: publicUser(result.user),
        returnTo,
      });
    } catch (error) {
      clearFlowCookies(response);
      if (
        error instanceof CognitoConfigurationError
        || error instanceof CognitoVerificationUnavailableError
      ) {
        if (error instanceof CognitoVerificationUnavailableError && typeof response.setHeader === 'function') {
          response.setHeader('Retry-After', '3');
        }
        return response.status(503).json({
          code: 'COGNITO_UNAVAILABLE',
          error: error.message,
        });
      }
      if (error instanceof CognitoTokenInvalidError) {
        return response.status(401).json({
          code: 'COGNITO_IDENTITY_REJECTED',
          error: 'Cognito could not confirm your identity. Please start again.',
        });
      }
      if (error.name === 'OPError' || error.name === 'RPError') {
        const failure = describeTokenExchangeFailure(error);
        console.error('Cognito token exchange failed:', error.name, describeOAuthError(error));
        return response.status(failure.status).json({
          code: failure.code,
          error: failure.message,
        });
      }
      return next(error);
    }
  }

  async function createSession(request, response, next) {
    const profileIdentity = verifyProfileCookie(request);
    if (!profileIdentity) {
      response.clearCookie(profileCookieName, sessionCookieOptions);
      return response.status(401).json({
        error: 'Your verified Cognito profile has expired. Please sign in again.',
      });
    }

    try {
      const claims = {
        sub: profileIdentity.sub,
        email: profileIdentity.account ?? profileIdentity.email,
        email_verified: true,
      };
      const result = await findOrCreateUser(
        claims,
        profileIdentity.email,
        request.body ?? {},
      );
      if (result.error) {
        return response.status(result.error.status).json({
          ...result.error.body,
          email: profileIdentity.email,
          returnTo: validReturnTo(profileIdentity.returnTo)
            ? profileIdentity.returnTo
            : '/meetings',
        });
      }
      if (result.profileRequired) {
        return response.status(400).json({
          code: 'PROFILE_REQUIRED',
          error: 'Complete your DevLoop profile to continue.',
        });
      }

      response.clearCookie(profileCookieName, sessionCookieOptions);
      setAuthCookie(response, result.user);
      return response.status(200).json({
        user: publicUser(result.user),
        returnTo: validReturnTo(profileIdentity.returnTo)
          ? profileIdentity.returnTo
          : '/meetings',
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Creates the DevLoop session from the identity token that Amazon Cognito
   * issued for the person who just signed in. The token is verified with the
   * Cognito aware verifier, so the server never trusts anything the browser
   * sends about who the person is.
   */
  async function createSessionFromToken(request, response, next) {
    const { idToken, profile = {}, returnTo } = request.body ?? {};
    if (typeof idToken !== 'string' || !idToken || idToken.length > 8192) {
      return response.status(400).json({
        code: 'ID_TOKEN_REQUIRED',
        error: 'The sign-in could not be completed. Please try again.',
      });
    }

    let claims;
    try {
      claims = await verifyIdToken(idToken);
    } catch (error) {
      if (error instanceof CognitoVerificationUnavailableError) {
        if (typeof response.setHeader === 'function') {
          response.setHeader('Retry-After', '3');
        }
        return response.status(503).json({
          code: 'COGNITO_UNAVAILABLE',
          error: error.message,
        });
      }
      if (error instanceof CognitoTokenInvalidError) {
        return response.status(401).json({
          code: 'COGNITO_IDENTITY_REJECTED',
          error: 'Cognito could not confirm your identity. Please sign in again.',
        });
      }
      return next(error);
    }

    const email = normalizeEmail(claims);
    if (!email) {
      return response.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Your email address is not verified in Cognito yet. Confirm the email that Cognito sent you, then sign in again.',
      });
    }

    const destination = validReturnTo(returnTo) ? returnTo : '/meetings';
    const tokenProfile = profileFromClaims(claims);
    const mergedProfile = {
      firstName: tokenProfile.firstName || (typeof profile?.firstName === 'string' ? profile.firstName : ''),
      lastName: tokenProfile.lastName || (typeof profile?.lastName === 'string' ? profile.lastName : ''),
      username: tokenProfile.username || (typeof profile?.username === 'string' ? profile.username : ''),
    };

    try {
      issueProfileCookie(
        response,
        { sub: claims.sub, email, account: cognitoUsernameFromClaims(claims) },
        destination,
      );
      const result = await findOrCreateUser(claims, email, mergedProfile);
      if (result.error) {
        return response.status(result.error.status).json({
          ...result.error.body,
          email,
          returnTo: destination,
        });
      }
      if (result.profileRequired) {
        return response.status(200).json({
          profileRequired: true,
          email,
          returnTo: destination,
        });
      }

      response.clearCookie(profileCookieName, sessionCookieOptions);
      setAuthCookie(response, result.user);
      return response.status(200).json({
        user: publicUser(result.user),
        returnTo: destination,
      });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Looks up the name that Amazon Cognito knows an account by. The sign-in
   * screen takes an email address, and because the user pool signs people in
   * with their email address, that address is also the name the account has
   * inside Cognito.
   */
  async function resolveSignInIdentifier(request, response, next) {
    const { identifier } = request.body ?? {};
    const value = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
    if (!value || value.length > 254) {
      return response.status(400).json({ error: 'Enter the email address of your account.' });
    }

    try {
      const user = await UserModel.findOne({
        $or: [{ email: value }, { username: value }],
      });
      const account = cognitoSignInName(user);
      return response.status(200).json({ account });
    } catch (error) {
      return next(error);
    }
  }

  async function currentUser(request, response) {
    const user = await UserModel.findById(request.auth.userId);
    if (!user) {
      response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
      return response.status(401).json({ error: 'Please log in to continue.' });
    }

    return response.status(200).json({ user: publicUser(user) });
  }

  function logout(request, response) {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      revokeSessionToken(token);
    }
    response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions);
    clearFlowCookies(response);
    const logoutUrl = getLogoutUrl();
    return response.status(200).json({
      loggedOut: true,
      ...(logoutUrl ? { logoutUrl } : {}),
    });
  }

  return {
    startLogin,
    completeLogin,
    createSession,
    createSessionFromToken,
    resolveSignInIdentifier,
    currentUser,
    logout,
  };
}

const defaultAuthController = createAuthController();
export const {
  startLogin,
  completeLogin,
  createSession,
  createSessionFromToken,
  resolveSignInIdentifier,
  currentUser,
  logout,
} = defaultAuthController;
