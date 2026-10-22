import { Issuer } from 'openid-client';
import { CognitoConfigurationError } from './cognito.js';

let cachedClient;
let cachedConfiguration;
let warnedAboutMissingSecret = false;

function readClientId(environment) {
  const clientId = environment.VITE_COGNITO_CLIENT_ID?.trim() ?? '';
  if (environment.COGNITO_CLIENT_ID?.trim()) {
    throw new CognitoConfigurationError(
      'COGNITO_CLIENT_ID is a duplicate app client id definition. Remove it and keep only VITE_COGNITO_CLIENT_ID.',
    );
  }
  return clientId;
}

function assertSafeUrl(value, name, { allowLocalhost = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CognitoConfigurationError(`${name} must be a valid absolute URL.`);
  }
  if (parsed.protocol !== 'https:' && !(allowLocalhost && parsed.hostname === 'localhost')) {
    throw new CognitoConfigurationError(
      `${name} must use HTTPS outside local development.`,
    );
  }
  return parsed;
}

function getConfiguration(environment = process.env, requireSecret = false) {
  const region = environment.VITE_AWS_REGION?.trim() ?? '';
  const userPoolId = environment.VITE_COGNITO_USER_POOL_ID?.trim() ?? '';
  const clientId = readClientId(environment);
  const domain = environment.COGNITO_DOMAIN?.trim().replace(/\/+$/, '') ?? '';
  const clientSecret = environment.COGNITO_CLIENT_SECRET?.trim() ?? '';
  const callbackUrl = environment.COGNITO_CALLBACK_URL?.trim() ?? '';
  const logoutUrl = environment.COGNITO_LOGOUT_URL?.trim() ?? '';
  const missing = [
    !region && 'VITE_AWS_REGION',
    !userPoolId && 'VITE_COGNITO_USER_POOL_ID',
    !clientId && 'VITE_COGNITO_CLIENT_ID',
    !domain && 'COGNITO_DOMAIN',
    requireSecret && !clientSecret && 'COGNITO_CLIENT_SECRET',
    !callbackUrl && 'COGNITO_CALLBACK_URL',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new CognitoConfigurationError(
      `Cognito OAuth is not configured. Set ${missing.join(', ')} in the backend .env.`,
    );
  }
  if (!userPoolId.startsWith(`${region}_`)) {
    throw new CognitoConfigurationError(
      'VITE_COGNITO_USER_POOL_ID must belong to VITE_AWS_REGION.',
    );
  }

  const domainUrl = assertSafeUrl(domain, 'COGNITO_DOMAIN', { allowLocalhost: false });
  const standardDomainMatch = domainUrl.hostname.match(/^(.+)\.auth\.([a-z0-9-]+)\.amazoncognito\.com$/);
  if (standardDomainMatch && standardDomainMatch[2] !== region) {
    throw new CognitoConfigurationError(
      `COGNITO_DOMAIN belongs to ${standardDomainMatch[2]} but VITE_AWS_REGION is ${region}.`,
    );
  }
  if (domainUrl.search || domainUrl.hash || domainUrl.pathname !== '/') {
    throw new CognitoConfigurationError(
      'COGNITO_DOMAIN must be the bare Cognito domain URL without a path, query, or fragment.',
    );
  }

  const callback = assertSafeUrl(callbackUrl, 'COGNITO_CALLBACK_URL');
  if (logoutUrl) {
    assertSafeUrl(logoutUrl, 'COGNITO_LOGOUT_URL');
  }

  return {
    region,
    userPoolId,
    clientId,
    domain: domainUrl.origin,
    clientSecret,
    callbackUrl: callback.href,
    logoutUrl,
  };
}

export function getCognitoOAuthConfiguration(environment = process.env, requireSecret = false) {
  return getConfiguration(environment, requireSecret);
}

export async function getCognitoOAuthClient() {
  const configuration = getConfiguration(process.env, false);
  const key = JSON.stringify(configuration);
  if (cachedClient && cachedConfiguration === key) {
    return cachedClient;
  }

  if (!configuration.clientSecret && !warnedAboutMissingSecret) {
    warnedAboutMissingSecret = true;
    console.warn(
      '[DevLoop] COGNITO_CLIENT_SECRET is empty, so the app is treated as a public client'
      + ' and the token endpoint is called without a client secret. This only works when the'
      + ' Cognito app client was created without a secret. If your app client has a secret,'
      + ' the code exchange fails with "invalid_client"; set COGNITO_CLIENT_SECRET in the'
      + ' backend .env instead.',
    );
  }

  const issuerUrl = `https://cognito-idp.${configuration.region}.amazonaws.com/${configuration.userPoolId}`;
  let issuer;
  try {
    issuer = await Issuer.discover(issuerUrl);
  } catch (error) {
    console.error('Failed to discover the Cognito issuer at', issuerUrl, ':', error.message);
    const discoveryError = new Error('Cognito authentication service is temporarily unavailable. Please try again.');
    discoveryError.name = 'CognitoVerificationUnavailableError';
    throw discoveryError;
  }

  const client = new issuer.Client({
    client_id: configuration.clientId,
    ...(configuration.clientSecret
      ? {
          client_secret: configuration.clientSecret,
          token_endpoint_auth_method: 'client_secret_basic',
        }
      : {
          token_endpoint_auth_method: 'none',
        }),
    redirect_uris: [configuration.callbackUrl],
    response_types: ['code'],
  });
  cachedClient = {
    client,
    callbackUrl: configuration.callbackUrl,
    domain: configuration.domain,
  };
  cachedConfiguration = key;
  return cachedClient;
}

export function createCognitoLogoutUrl() {
  let configuration;
  try {
    configuration = getConfiguration(process.env, false);
  } catch (error) {
    if (error instanceof CognitoConfigurationError) {
      return null;
    }
    throw error;
  }
  if (!configuration.logoutUrl) {
    return null;
  }
  const url = new URL('/logout', configuration.domain);
  url.searchParams.set('client_id', configuration.clientId);
  url.searchParams.set('logout_uri', configuration.logoutUrl);
  return url.toString();
}
