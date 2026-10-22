import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authScreens,
  describeAuthFailure,
  describeExistingAccountFailure,
} from '../src/lib/authFlow.js';

function apiError(code, message = 'the server refused the request') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function cognitoError(name, message = 'the request failed') {
  const error = new Error(message);
  error.name = name;
  return error;
}

test('a refused account leads to the sign-in screen', () => {
  const failure = describeAuthFailure(apiError('ACCOUNT_EXISTS'), {
    screen: authScreens.confirm,
  });

  assert.equal(failure.screen, authScreens.login);
  assert.match(failure.message, /already uses that email address/);
});

test('a name that is taken leads to the screen that can pick another one', () => {
  const failure = describeAuthFailure(apiError('USERNAME_TAKEN'), {
    screen: authScreens.signup,
  });

  assert.equal(failure.screen, authScreens.signup);
  assert.match(failure.message, /username is already taken/);
});

test('a name that is taken keeps the profile screen open', () => {
  const failure = describeAuthFailure(apiError('USERNAME_TAKEN'), {
    screen: authScreens.profile,
  });

  assert.equal(failure.screen, authScreens.profile);
});

test('a missing profile leads to the profile screen', () => {
  const failure = describeAuthFailure(apiError('PROFILE_REQUIRED'), {
    screen: authScreens.login,
  });

  assert.equal(failure.screen, authScreens.profile);
});

test('an email address that is not verified leads to the code screen', () => {
  const failure = describeAuthFailure(apiError('EMAIL_NOT_VERIFIED'), {
    screen: authScreens.login,
  });

  assert.equal(failure.screen, authScreens.confirm);
});

test('an account that already exists in Cognito leads to the sign-in screen', () => {
  const failure = describeAuthFailure(cognitoError('UsernameExistsException'), {
    screen: authScreens.signup,
  });

  assert.equal(failure.screen, authScreens.login);
  assert.match(failure.message, /already uses that email address/);
});

test('an account that is not confirmed leads to the code screen', () => {
  const failure = describeAuthFailure(cognitoError('UserNotConfirmedException'), {
    screen: authScreens.login,
  });

  assert.equal(failure.screen, authScreens.confirm);
  assert.match(failure.message, /not confirmed yet/);
});

test('a code that is wrong keeps the code screen open', () => {
  const failure = describeAuthFailure(cognitoError('CodeMismatchException'), {
    screen: authScreens.confirm,
  });

  assert.equal(failure.screen, authScreens.confirm);
  assert.match(failure.message, /code is not correct/);
});

test('a code that has expired leads to the code screen', () => {
  const failure = describeAuthFailure(cognitoError('ExpiredCodeException'), {
    screen: authScreens.confirm,
  });

  assert.equal(failure.screen, authScreens.confirm);
  assert.match(failure.message, /expired/);
});

test('a password that does not match keeps the sign-in screen open', () => {
  const failure = describeAuthFailure(cognitoError('NotAuthorizedException'), {
    screen: authScreens.login,
  });

  assert.equal(failure.screen, authScreens.login);
  assert.match(failure.message, /do not match/);
});

test('an account that Cognito does not know leads to the sign-in screen', () => {
  const failure = describeAuthFailure(cognitoError('UserNotFoundException'), {
    screen: authScreens.signup,
  });

  assert.equal(failure.screen, authScreens.login);
  assert.match(failure.message, /could not find an account/);
});

test('an unknown failure keeps the screen open and explains itself', () => {
  const failure = describeAuthFailure(new Error('the network is down'), {
    screen: authScreens.confirm,
  });

  assert.equal(failure.screen, authScreens.confirm);
  assert.match(failure.message, /the network is down/);
});

test('an unknown failure uses the message of the caller', () => {
  const failure = describeAuthFailure(new Error('the network is down'), {
    screen: authScreens.confirm,
    message: 'That code could not be confirmed.',
  });

  assert.equal(failure.screen, authScreens.confirm);
  assert.equal(failure.message, 'That code could not be confirmed.');
});

test('an account that does not exist in Cognito keeps the sign-up screen open', () => {
  const failure = describeExistingAccountFailure(
    cognitoError('UserNotFoundException'),
    'cloud@example.com',
  );

  assert.equal(failure.screen, authScreens.signup);
  assert.match(failure.message, /username is already taken/);
  assert.equal(failure.identifier, null, 'the address is not put into the sign-in screen');
});

test('an account that still has to confirm its email address leads to the code screen', () => {
  const failure = describeExistingAccountFailure(
    cognitoError('UserNotConfirmedException'),
    'cloud@example.com',
  );

  assert.equal(failure.screen, authScreens.confirm);
  assert.match(failure.message, /not confirmed yet/);
  assert.equal(failure.identifier, 'cloud@example.com');
});

test('an account that exists with another password leads to the sign-in screen', () => {
  const failure = describeExistingAccountFailure(
    cognitoError('NotAuthorizedException'),
    'cloud@example.com',
  );

  assert.equal(failure.screen, authScreens.login);
  assert.match(failure.message, /already uses that email address/);
  assert.equal(failure.identifier, 'cloud@example.com');
});
