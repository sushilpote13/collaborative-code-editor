import {
  describeAuthError,
  isNotConfirmedError,
  isUnknownAccountError,
} from './authErrors.js';

/**
 * The screens of the authentication flow. The names are the ones the home
 * page renders.
 */
export const authScreens = {
  login: 'login',
  signup: 'signup',
  confirm: 'confirm',
  forgot: 'forgot',
  reset: 'reset',
  mfa: 'mfa',
  profile: 'profile',
};

// Failures of the DevLoop API carry a code that says what happened. Every
// code leads to the screen that can still make progress.
const apiFailures = {
  ACCOUNT_EXISTS: {
    screen: authScreens.login,
    message:
      'An account already uses that email address. Sign in with your password to continue.',
  },
  USERNAME_TAKEN: {
    screen: authScreens.signup,
    message: 'That username is already taken. Please choose another one.',
  },
  PROFILE_REQUIRED: {
    screen: authScreens.profile,
    message: 'Choose a username and display name to finish setting up your account.',
  },
  EMAIL_NOT_VERIFIED: {
    screen: authScreens.confirm,
    message:
      'Your email address is not confirmed yet. Enter the code we emailed you to finish signing up.',
  },
  COGNITO_IDENTITY_REJECTED: {
    screen: authScreens.login,
    message: 'Cognito could not confirm your identity. Please sign in again.',
  },
  ID_TOKEN_REQUIRED: {
    screen: authScreens.login,
    message: 'The sign-in could not be completed. Please try again.',
  },
};

// Failures that Amazon Cognito reports. The name of the provider error
// decides what happens next.
const cognitoFailures = {
  UserNotConfirmedException: {
    screen: authScreens.confirm,
    message:
      'Your email address is not confirmed yet. Enter the code we emailed you to finish signing up.',
  },
  CodeMismatchException: {
    message: 'That code is not correct. Check the code we emailed you and try again.',
  },
  ExpiredCodeException: {
    screen: authScreens.confirm,
    message: 'That code has expired. Send the code again and enter the new one.',
  },
  NotAuthorizedException: {
    message: 'That email address and password do not match. Please check them and try again.',
  },
  UserNotFoundException: {
    screen: authScreens.login,
    message:
      'We could not find an account with that email address. Check the address, or create an account.',
  },
  UserAlreadyExistsException: {
    screen: authScreens.login,
    message:
      'An account already uses that email address. Sign in with your password to continue.',
  },
  AliasExistsException: {
    screen: authScreens.login,
    message:
      'An account already uses that email address. Sign in with your password to continue.',
  },
  UsernameExistsException: {
    screen: authScreens.login,
    message:
      'An account already uses that email address. Sign in with your password to continue.',
  },
};

/**
 * A failure that happens while the profile is filled in belongs on the
 * profile screen, even when the message points at another screen.
 */
function resolveScreen(failure, currentScreen) {
  if (!failure.screen) {
    return currentScreen;
  }
  if (failure.screen === authScreens.signup && currentScreen === authScreens.profile) {
    return authScreens.profile;
  }
  return failure.screen;
}

/**
 * Turns a failure of the sign-in into the screen that can still make
 * progress and a message that says what to do. A person is never left on a
 * screen that cannot continue, which is what made a failed sign-up look like
 * a confirmation page that never finishes.
 *
 * @param {unknown} error the error of the API or of Amazon Cognito
 * @param {{ screen?: string, message?: string }} [options] the screen that is
 *   open while the failure happens and the message to use when the failure is
 *   not known
 */
export function describeAuthFailure(error, options = {}) {
  const currentScreen = options.screen || authScreens.login;

  const code = typeof error?.code === 'string' ? error.code : '';
  const apiFailure = apiFailures[code];
  if (apiFailure) {
    return {
      screen: resolveScreen(apiFailure, currentScreen),
      message: apiFailure.message,
    };
  }

  const name = typeof error?.name === 'string' ? error.name : '';
  const cognitoFailure = cognitoFailures[name];
  if (cognitoFailure) {
    return {
      screen: resolveScreen(cognitoFailure, currentScreen),
      message: cognitoFailure.message,
    };
  }

  return {
    screen: currentScreen,
    message: options.message || describeAuthError(error),
  };
}

/**
 * The account of Amazon Cognito already exists, so the sign-in with the
 * password that was typed decides what happens next. A failure of that
 * sign-in says which screen can still make progress.
 *
 * @param {unknown} error the failure of the sign-in
 * @param {string} account the name that Cognito knows the account by
 */
export function describeExistingAccountFailure(error, account) {
  if (isUnknownAccountError(error)) {
    // Cognito does not know an account for this email address, so the name
    // that is taken is the name that was picked inside DevLoop.
    return {
      screen: authScreens.signup,
      message: 'That username is already taken. Please choose another one.',
      identifier: null,
    };
  }

  if (isNotConfirmedError(error)) {
    return {
      screen: authScreens.confirm,
      message:
        'Your email address is not confirmed yet. Enter the code we emailed you to finish signing up.',
      identifier: account,
    };
  }

  return {
    screen: authScreens.login,
    message:
      'An account already uses that email address. Sign in with your password to continue.',
    identifier: account,
  };
}
