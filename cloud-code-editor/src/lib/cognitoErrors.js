const providerErrorMessages = {
  access_denied: 'Cognito sign-in was cancelled. Please start again when you are ready.',
  invalid_request: 'Cognito rejected the sign-in request. Please start again.',
  invalid_scope:
    'This DevLoop build asked Cognito for a scope the user pool does not allow. Please contact an administrator.',
  unauthorized_client:
    'The Cognito app client is not allowed to start a sign-in. Please contact an administrator.',
  invalid_client: 'The DevLoop server is not allowed to start a sign-in with this Cognito app client.',
  server_error: 'Cognito could not start the sign-in. Please try again in a moment.',
  temporarily_unavailable: 'Cognito is temporarily unavailable. Please try again in a moment.',
};

function sanitizeDetail(detail) {
  return detail
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Turns the error that Amazon Cognito sends back to the redirect URI into a
 * message that explains what happened. The provider code is kept next to the
 * message so the cause is not lost, and long values are removed because the
 * description may carry internal identifiers.
 */
export function describeCognitoProviderError(code, description) {
  const providerCode = typeof code === 'string' ? code.trim() : '';
  const base = providerErrorMessages[providerCode]
    ?? 'Cognito could not complete the sign-in. Please try again.';

  const detail = typeof description === 'string' ? sanitizeDetail(description) : '';
  if (!detail) {
    return base;
  }
  return `${base} (${providerCode || 'error'}: ${detail})`;
}

export function getCognitoErrorMessage(error) {
  const message = error instanceof Error ? error.message : '';
  return message || 'Authentication failed. Please try again.';
}
