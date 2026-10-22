function getRetryDelay(response, attempt) {
  const retryAfter = response.headers?.get('Retry-After');
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 10000);
    }
  }
  return Math.min(500 * (2 ** attempt), 4000);
}

function delay(ms) {
  // The timer always gets a function. Anything else would be turned into a
  // string by the browser and evaluated as code, which a Content Security
  // Policy without "unsafe-eval" blocks with an error about evaluating a
  // string as JavaScript.
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

async function parseResponsePayload(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

function createApiError(response, payload) {
  let message = payload?.error;
  if (!message) {
    if (response.status === 503) {
      message = 'The service is temporarily unavailable. Please try again in a moment.';
    } else if (response.status === 502 || response.status === 504) {
      message = 'Could not reach the DevLoop server. Please check that the server is running.';
    } else {
      message = `The server returned ${response.status}.`;
    }
  }
  const error = new Error(message);
  error.status = response.status;
  error.code = payload?.code;
  error.details = payload;
  return error;
}

async function requestJson(url, body, { retrySafe = false } = {}) {
  const maxAttempts = retrySafe ? 3 : 1;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = await parseResponsePayload(response);
        if (response.status === 503 && retrySafe && attempt < maxAttempts - 1) {
          await delay(getRetryDelay(response, attempt));
          continue;
        }
        throw createApiError(response, payload);
      }

      const result = await parseResponsePayload(response);
      return result ?? {};
    } catch (error) {
      lastError = error;
      if (error instanceof TypeError && retrySafe && attempt < maxAttempts - 1) {
        await delay(500 * (2 ** attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}

export async function startCognitoLogin({ mode, email, profile, returnTo }) {
  const result = await requestJson(
    '/api/auth/login',
    {
      mode,
      email,
      profile,
      returnTo,
    },
    { retrySafe: true },
  );
  if (typeof result.authorizationUrl !== 'string' || !result.authorizationUrl) {
    const error = new Error('Cognito sign-in could not be started. Please try again.');
    error.code = 'COGNITO_SIGN_IN_UNAVAILABLE';
    throw error;
  }
  return result.authorizationUrl;
}

export async function completeCognitoLogin(code, state) {
  return requestJson('/api/auth/callback', { code, state });
}

export async function createBackendSession(profile = {}) {
  return requestJson('/api/auth/session', profile);
}

/**
 * Exchanges the identity token that Cognito issued for the DevLoop session.
 * The server verifies the token before it starts the session, so the browser
 * never decides who the person is.
 */
export async function createSessionFromIdentityToken(idToken, { profile, returnTo } = {}) {
  return requestJson('/api/auth/token', { idToken, profile, returnTo });
}

/**
 * Resolves the name that Cognito knows an account by, so a person can sign in
 * with the email address of their account. The user pool signs people in with
 * their email address, so that address is the name the sign-in screen sends.
 */
export async function resolveSignInIdentifier(identifier) {
  const result = await requestJson('/api/auth/resolve-signin', { identifier });
  return typeof result.account === 'string' ? result.account : null;
}

export async function apiFetch(input, options = {}) {
  const isSafeMethod = !options.method || options.method === 'GET' || options.method === 'HEAD';
  const shouldRetry = options.retrySafe ?? isSafeMethod;
  const maxAttempts = shouldRetry ? 3 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, { ...options, credentials: 'same-origin' });
      if (response.status === 503 && shouldRetry && attempt < maxAttempts - 1) {
        await delay(getRetryDelay(response, attempt));
        continue;
      }
      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw error;
      }
      if (shouldRetry && attempt < maxAttempts - 1) {
        await delay(500 * (2 ** attempt));
        continue;
      }
      throw error;
    }
  }

  return fetch(input, { ...options, credentials: 'same-origin' });
}

export async function signOutFromCognito() {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `The server returned ${response.status} while ending the app session.`);
  }
  if (result.logoutUrl) {
    window.location.assign(result.logoutUrl);
  }
}
