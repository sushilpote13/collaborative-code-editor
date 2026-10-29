import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeCognitoProviderError,
  getCognitoErrorMessage,
} from '../src/lib/cognitoErrors.js';

test('other Cognito errors preserve their original actionable message', () => {
  assert.equal(
    getCognitoErrorMessage(new Error('Incorrect username or password.')),
    'Incorrect username or password.',
  );
});

test('an error without a message still produces a readable fallback', () => {
  assert.equal(getCognitoErrorMessage(new Error('')), 'Authentication failed. Please try again.');
});

test('a cancelled sign-in is reported as a cancellation instead of a silent failure', () => {
  const message = describeCognitoProviderError('access_denied');
  assert.match(message, /cancelled/i);
  assert.doesNotMatch(message, /could not be verified/i);
});

test('a provider error keeps the Cognito error code and its description', () => {
  const message = describeCognitoProviderError(
    'invalid_request',
    'Redirect URI mismatch. The redirect URI does not match any of the registered URIs.',
  );
  assert.match(message, /invalid_request/);
  assert.match(message, /redirect uri mismatch/i);
});

test('an unknown provider error still explains that the sign-in failed', () => {
  const message = describeCognitoProviderError('something_new');
  assert.match(message, /could not complete the sign-in/i);
});

test('a provider description cannot smuggle long tokens into the page', () => {
  const message = describeCognitoProviderError(
    'invalid_request',
    `token ${'A'.repeat(64)} was rejected`,
  );
  assert.doesNotMatch(message, /A{64}/);
  assert.match(message, /\[redacted\]/);
});
