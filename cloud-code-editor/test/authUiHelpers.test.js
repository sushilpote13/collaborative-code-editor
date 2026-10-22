import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeAuthError,
  isExistingAccountError,
  isNotConfirmedError,
  isUnknownAccountError,
} from '../src/lib/authErrors.js';
import {
  getPasswordIssues,
  isPasswordAcceptable,
  isValidConfirmationCode,
  isValidEmail,
  isValidUsername,
  sanitizeCode,
} from '../src/lib/authValidation.js';

test('the password rules match the policy of the Cognito user pool', () => {
  assert.deepEqual(getPasswordIssues('Sh1!A'), ['At least 8 characters']);
  assert.deepEqual(getPasswordIssues('longenough1'), [
    'One uppercase letter',
    'One symbol',
  ]);
  assert.deepEqual(getPasswordIssues('Longenough1!'), []);
  assert.equal(isPasswordAcceptable('Longenough1!'), true);
  assert.equal(isPasswordAcceptable('longenough1!'), false);
  assert.equal(isPasswordAcceptable(''), false);
});

test('usernames follow the rules of a DevLoop profile', () => {
  assert.equal(isValidUsername('alex_dev'), true);
  assert.equal(isValidUsername('Alex2'), true);
  assert.equal(isValidUsername('ab'), false);
  assert.equal(isValidUsername('2alex'), false);
  assert.equal(isValidUsername('alex dev'), false);
  assert.equal(isValidUsername(''), false);
});

test('email addresses are checked before they are sent to Cognito', () => {
  assert.equal(isValidEmail('person@example.com'), true);
  assert.equal(isValidEmail('person@example'), false);
  assert.equal(isValidEmail('person.example.com'), false);
  assert.equal(isValidEmail(''), false);
});

test('a confirmation code is six digits', () => {
  assert.equal(isValidConfirmationCode('123456'), true);
  assert.equal(isValidConfirmationCode('12345'), false);
  assert.equal(isValidConfirmationCode('12345a'), false);
  assert.equal(sanitizeCode('12a34 56789'), '123456');
  assert.equal(sanitizeCode('abc'), '');
});

test('the Cognito errors become messages a person can act on', () => {
  const error = new Error('Incorrect username or password.');
  error.name = 'NotAuthorizedException';
  assert.equal(
    describeAuthError(error),
    'That email address and password do not match. Please check them and try again.',
  );

  const unknown = new Error('Something went wrong.');
  unknown.name = 'UnexpectedError';
  assert.match(describeAuthError(unknown), /Something went wrong/);
});

test('the details of a password error are kept because Cognito explains the rules', () => {
  const error = new Error('Password must have uppercase characters.');
  error.name = 'InvalidPasswordException';
  assert.match(describeAuthError(error), /uppercase characters/);
});

test('long values in an error are removed before they are shown', () => {
  const error = new Error(`token ${'a'.repeat(60)}`);
  error.name = 'UnexpectedError';
  assert.doesNotMatch(describeAuthError(error), /a{60}/);
});

test('an account that already exists is recognised', () => {
  const error = new Error('An account with the given email already exists.');
  error.name = 'AliasExistsException';
  assert.equal(isExistingAccountError(error), true);

  const other = new Error('nope');
  other.name = 'NotAuthorizedException';
  assert.equal(isExistingAccountError(other), false);
});

test('a user name that exists is an account that already exists', () => {
  const error = new Error('User already exists.');
  error.name = 'UsernameExistsException';
  assert.equal(isExistingAccountError(error), true);
  assert.match(describeAuthError(error), /already exists with that email address/);
});

test('an account that Cognito does not know is recognised', () => {
  const error = new Error('User does not exist.');
  error.name = 'UserNotFoundException';
  assert.equal(isUnknownAccountError(error), true);

  const existing = new Error('An account with the given email already exists.');
  existing.name = 'AliasExistsException';
  assert.equal(isUnknownAccountError(existing), false);
});

test('an account that still has to confirm its email address is recognised', () => {
  const error = new Error('User is not confirmed.');
  error.name = 'UserNotConfirmedException';
  assert.equal(isNotConfirmedError(error), true);

  const other = new Error('nope');
  other.name = 'NotAuthorizedException';
  assert.equal(isNotConfirmedError(other), false);
});
