const authErrorMessages = {
  UserNotFoundException:
    'We could not find a DevLoop account with that email address. Check the address, or create an account.',
  NotAuthorizedException:
    'That email address and password do not match. Please check them and try again.',
  UserNotConfirmedException:
    'Your email address is not confirmed yet. Enter the code we emailed you to finish signing up.',
  UserAlreadyExistsException:
    'An account already exists with that email address. Sign in instead, or reset your password.',
  AliasExistsException:
    'An account already exists with that email address. Sign in instead, or reset your password.',
  // Amazon Cognito knows an account of this user pool by the email address of
  // the person, because the pool signs people in with their email address. A
  // user name that already exists is therefore an account that already
  // exists, and not a name inside DevLoop that is taken.
  UsernameExistsException:
    'An account already exists with that email address. Sign in instead, or reset your password.',
  CodeMismatchException:
    'That code is not correct. Check the code we emailed you and try again.',
  ExpiredCodeException:
    'That code has expired. Request a new code and try again.',
  InvalidPasswordException:
    'That password does not meet the password rules of this user pool.',
  InvalidParameterException:
    'Cognito did not accept the sign-in details. Check the email address of your account and try again.',
  TooManyRequestsException:
    'Too many attempts. Wait a minute and try again.',
  LimitExceededException:
    'Too many attempts. Wait a minute and try again.',
  NetworkError:
    'DevLoop could not reach the sign-in service. Check your connection and try again.',
  CognitoServiceUnavailableException:
    'The sign-in service is temporarily unavailable. Please try again in a moment.',
};

const defaultMessage = 'We could not sign you in. Please try again.';

// Errors where the detail from Cognito adds something the message above does
// not already explain.
const detailKeepsHelp = {
  InvalidPasswordException: true,
  InvalidParameterException: true,
  PasswordResetRequiredException: true,
};

function sanitizeDetail(detail) {
  return detail
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Turns the error Amazon Cognito sends into a message a person can act on.
 * The name of the provider error is kept next to the message so the cause is
 * not lost, and long values are removed because the detail may carry
 * internal identifiers.
 */
export function describeAuthError(error, fallbackMessage = defaultMessage) {
  if (!error) {
    return fallbackMessage;
  }

  const name = typeof error.name === 'string' ? error.name : '';
  const known = authErrorMessages[name];
  const detail = typeof error.message === 'string' ? sanitizeDetail(error.message) : '';

  if (!known) {
    if (!detail) {
      return fallbackMessage;
    }
    return `${fallbackMessage} (${name || 'error'}: ${detail})`;
  }

  // Cognito explains its password rules in the detail of the error, so that
  // part is worth showing. Every other message would only repeat itself.
  if (!detail || detail === known || !detailKeepsHelp[name]) {
    return known;
  }
  return `${known} (${detail})`;
}

/**
 * True when Amazon Cognito does not know an account for the email address
 * that was used to sign in.
 */
export function isUnknownAccountError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return name === 'UserNotFoundException';
}

/**
 * True when Amazon Cognito reports that the account already exists. The
 * user pool of this project signs people in with their email address, so a
 * user name that already exists belongs to an account that already exists.
 */
export function isExistingAccountError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return name === 'UserAlreadyExistsException'
    || name === 'AliasExistsException'
    || name === 'UsernameExistsException';
}

/**
 * True when Amazon Cognito reports that the account still has to confirm the
 * email address, so the code that was emailed has to be entered first.
 */
export function isNotConfirmedError(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  return name === 'UserNotConfirmedException';
}
