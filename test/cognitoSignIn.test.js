import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAlreadyAuthenticatedError,
  signInWithSessionRecovery,
} from '../src/lib/cognitoSignIn.js';

function alreadyAuthenticatedError() {
  const error = new Error('There is already a signed in user.');
  error.name = 'UserAlreadyAuthenticatedException';
  return error;
}

test('an existing Amplify session is cleared before the sign-in is tried again', async () => {
  const calls = [];
  let attempts = 0;

  const result = await signInWithSessionRecovery({
    account: 'cloud@example.com',
    password: 'correct-password',
    async signIn(account, password) {
      calls.push({ account, password });
      attempts += 1;
      if (attempts === 1) {
        throw alreadyAuthenticatedError();
      }
      return { isSignedIn: true };
    },
    async clearExistingSession() {
      calls.push('clear-session');
    },
  });

  assert.deepEqual(result, { isSignedIn: true });
  assert.deepEqual(calls, [
    { account: 'cloud@example.com', password: 'correct-password' },
    'clear-session',
    { account: 'cloud@example.com', password: 'correct-password' },
  ]);
});

test('a different sign-in failure is not hidden and leaves the session alone', async () => {
  let cleared = false;

  await assert.rejects(
    () => signInWithSessionRecovery({
      account: 'cloud@example.com',
      password: 'wrong-password',
      async signIn() {
        const error = new Error('Incorrect username or password.');
        error.name = 'NotAuthorizedException';
        throw error;
      },
      async clearExistingSession() {
        cleared = true;
      },
    }),
    /Incorrect username or password/,
  );

  assert.equal(cleared, false);
});

test('the already-authenticated error is recognised by its Amplify name', () => {
  assert.equal(isAlreadyAuthenticatedError(alreadyAuthenticatedError()), true);
  assert.equal(isAlreadyAuthenticatedError(new Error('other')), false);
  assert.equal(isAlreadyAuthenticatedError(null), false);
});
