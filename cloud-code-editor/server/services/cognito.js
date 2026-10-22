import { timingSafeEqual } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  FetchError,
  JwksNotAvailableInCacheError,
  ParameterValidationError,
} from 'aws-jwt-verify/error';

export class CognitoConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CognitoConfigurationError';
  }
}

export class CognitoVerificationUnavailableError extends Error {
  constructor() {
    super('Cognito signing keys are temporarily unavailable. Please try again.');
    this.name = 'CognitoVerificationUnavailableError';
  }
}

export class CognitoTokenInvalidError extends Error {
  constructor(message = 'The Cognito identity token is not valid.') {
    super(message);
    this.name = 'CognitoTokenInvalidError';
  }
}

let cachedVerifier;
let cachedConfiguration;
let cachedJwks;

export function getCognitoConfiguration(environment = process.env) {
  const configuration = {
    region: environment.VITE_AWS_REGION?.trim() ?? '',
    userPoolId: environment.VITE_COGNITO_USER_POOL_ID?.trim() ?? '',
    clientId: environment.VITE_COGNITO_CLIENT_ID?.trim() ?? '',
  };
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value)
    .map(([key]) => ({
      region: 'VITE_AWS_REGION',
      userPoolId: 'VITE_COGNITO_USER_POOL_ID',
      clientId: 'VITE_COGNITO_CLIENT_ID',
    }[key]));

  if (missing.length > 0) {
    throw new CognitoConfigurationError(
      `Cognito authentication is not configured. Set ${missing.join(', ')} in .env.`,
    );
  }
  if (!configuration.userPoolId.startsWith(`${configuration.region}_`)) {
    throw new CognitoConfigurationError(
      'VITE_COGNITO_USER_POOL_ID must belong to VITE_AWS_REGION.',
    );
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d_[A-Za-z0-9]+$/.test(configuration.userPoolId)) {
    throw new CognitoConfigurationError(
      'VITE_COGNITO_USER_POOL_ID must look like "<region>_<pool id>".',
    );
  }
  if (!/^[A-Za-z0-9]{1,128}$/.test(configuration.clientId)) {
    throw new CognitoConfigurationError(
      'VITE_COGNITO_CLIENT_ID must be a valid Cognito app client id.',
    );
  }

  return configuration;
}

export function createCognitoIdTokenVerifier(configuration, { jwks } = {}) {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: configuration.userPoolId,
    tokenUse: 'id',
    clientId: configuration.clientId,
  });

  if (jwks) {
    verifier.cacheJwks(jwks, configuration.userPoolId);
  }

  return verifier;
}

export async function verifyCognitoIdToken(token, { jwks } = {}) {
  if (typeof token !== 'string' || !token) {
    throw new CognitoTokenInvalidError('Cognito did not return an identity token.');
  }

  const configuration = getCognitoConfiguration();
  const key = JSON.stringify(configuration);

  try {
    if (!cachedVerifier || cachedConfiguration !== key || cachedJwks !== jwks) {
      cachedVerifier = createCognitoIdTokenVerifier(configuration, { jwks });
      cachedConfiguration = key;
      cachedJwks = jwks;
    }

    const claims = await cachedVerifier.verify(token);

    if (!claims?.sub) {
      throw new CognitoTokenInvalidError('The Cognito identity token has no subject.');
    }
    if (claims.token_use !== 'id') {
      throw new CognitoTokenInvalidError('The Cognito token is not an identity token.');
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(configuration.clientId)) {
      throw new CognitoTokenInvalidError(
        'The Cognito identity token was not issued for this app client.',
      );
    }

    return claims;
  } catch (error) {
    if (error instanceof CognitoTokenInvalidError) {
      throw error;
    }
    if (error instanceof FetchError || error instanceof JwksNotAvailableInCacheError) {
      throw new CognitoVerificationUnavailableError();
    }
    // The configuration is validated before verification, so a parameter error
    // here means the token itself is not acceptable (for example an unknown
    // issuer), not that the server is misconfigured.
    if (error instanceof ParameterValidationError) {
      throw new CognitoTokenInvalidError();
    }
    throw new CognitoTokenInvalidError();
  }
}

function equalStrings(left, right) {
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

/**
 * Checks the nonce claim of a verified Cognito ID token against the nonce that
 * was sent in the authorization request.
 *
 * Amazon Cognito echoes the nonce of the authorization request into the ID
 * token, so a nonce that is present has to match exactly. Cognito leaves the
 * claim out when it resumes an existing hosted UI session, so an absent claim
 * is accepted instead of failing a sign-in that is already protected by the
 * state and PKCE checks.
 */
export function assertCognitoNonce(claims, expectedNonce) {
  const received = typeof claims?.nonce === 'string' ? claims.nonce : '';
  if (!received) {
    return;
  }
  if (typeof expectedNonce !== 'string' || !expectedNonce) {
    throw new CognitoTokenInvalidError(
      'The Cognito identity token carried a nonce that this sign-in request did not send.',
    );
  }
  if (!equalStrings(received, expectedNonce)) {
    throw new CognitoTokenInvalidError(
      'The Cognito identity token nonce did not match the sign-in request.',
    );
  }
}
