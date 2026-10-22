import { cognitoAccountName, cognitoUserAttributes } from './cognitoAccount.js';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

let amplify = null;

/**
 * Loads the Amazon Cognito client on demand. The sign-in screens are the
 * first thing people see, but the code that talks to the user pool is only
 * needed once somebody actually types a password, so it stays out of the
 * first bundle the browser downloads.
 */
async function loadAmplify() {
  if (amplify) {
    return amplify;
  }

  if (!userPoolId || !clientId) {
    const error = new Error('DevLoop is not configured to sign in with Amazon Cognito.');
    error.code = 'COGNITO_NOT_CONFIGURED';
    throw error;
  }

  const [core, auth] = await Promise.all([
    import('aws-amplify'),
    import('@aws-amplify/auth'),
  ]);

  // The umbrella package wires the Cognito token provider to the resource
  // configuration. Configuring only the core package leaves the token store
  // without a user pool, and every sign-in then fails with
  // "Auth User Pool not configured".
  core.Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId: clientId,
        userPoolWebClientId: clientId,
        loginWith: { email: true },
      },
    },
  });

  amplify = { core, auth };
  return amplify;
}

function signInStepOf(result) {
  return result?.nextStep?.signInStep ?? '';
}

function signUpStepOf(result) {
  return result?.nextStep?.signUpStep ?? '';
}

function needsSecondFactor(step) {
  return step === 'CONFIRM_SIGN_IN_WITH_SMS_CODE'
    || step === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE'
    || step === 'CONTINUE_SIGN_IN_WITH_MFA_CHALLENGE';
}

/**
 * Signs a person in with their user pool credentials. The password never
 * leaves the browser in a readable form: Amplify performs the secure remote
 * password verification exchange with Cognito.
 *
 * The account is named by its email address, because that is how the user
 * pool knows it.
 */
export async function signInWithPassword({ account, password }) {
  const { auth } = await loadAmplify();
  const result = await auth.signIn({ username: account, password });
  const step = signInStepOf(result);

  return {
    status: needsSecondFactor(step) ? 'mfa-required' : 'signed-in',
    account: result?.nextStep?.username ?? account,
  };
}

/**
 * Creates the Cognito account. Cognito answers with a confirmation step when
 * the pool verifies email addresses, which the app turns into a code screen.
 *
 * The email address is the name of the account inside Cognito. The name the
 * person picked for DevLoop is kept as the preferred_username attribute, so
 * it stays part of the account instead of only living in the database.
 */
export async function registerWithEmail({
  username,
  password,
  email,
  firstName,
  lastName,
}) {
  const { auth } = await loadAmplify();
  const account = cognitoAccountName(email);
  const result = await auth.signUp({
    username: account,
    password,
    options: {
      userAttributes: cognitoUserAttributes({ username, firstName, lastName }),
    },
  });

  const step = signUpStepOf(result);
  if (step === 'COMPLETE_AUTO_SIGN_IN') {
    return { status: 'signed-in', account };
  }
  return { status: 'confirm-required', account };
}

/**
 * Confirms the emailed code. Cognito usually signs the person in straight
 * away, so the identity token is read once the confirmation succeeded.
 */
export async function confirmRegistration({ account, confirmationCode }) {
  const { auth } = await loadAmplify();
  await auth.confirmSignUp({ username: account, confirmationCode });

  try {
    await auth.autoSignIn();
  } catch {
    // Some pools do not allow the automatic sign-in. The person signs in with
    // their password instead, which the sign-in screen already handles.
  }

  const session = await currentIdentityToken();
  if (session && !identityBelongsToAccount(session.claims, account)) {
    // Amplify keeps the session of the last sign-in in the browser. When that
    // session belongs to somebody else, the identity token of it must not be
    // used for this account, so the session is dropped and the person signs
    // in again.
    await forgetCognitoSession();
    return { status: 'confirm-required', account };
  }

  return {
    status: session ? 'signed-in' : 'confirm-required',
    account,
  };
}

export async function requestPasswordResetCode({ account }) {
  const { auth } = await loadAmplify();
  await auth.resetPassword({ username: account });
  return { status: 'code-sent', account };
}

export async function confirmPasswordReset({ account, confirmationCode, newPassword }) {
  const { auth } = await loadAmplify();
  await auth.confirmResetPassword({ username: account, confirmationCode, newPassword });
  return { status: 'password-reset', account };
}

export async function confirmSecondFactor({ challengeResponse }) {
  const { auth } = await loadAmplify();
  const result = await auth.confirmSignIn({ challengeResponse });
  const step = signInStepOf(result);

  return { status: needsSecondFactor(step) ? 'mfa-required' : 'signed-in' };
}

export async function resendConfirmationCode({ account }) {
  const { auth } = await loadAmplify();
  await auth.resendSignUpCode({ username: account });
  return { status: 'code-sent', account };
}

/**
 * Reads the claims of an identity token. The token is a JSON Web Token, so
 * the claims are read from the second part of it. A token that cannot be read
 * gives no claims, which leaves the checks that use them to the safe side.
 */
function decodeTokenClaims(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) {
      return null;
    }
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * True when the identity token belongs to the account that was confirmed. A
 * token without an email address cannot be checked and is therefore accepted.
 */
function identityBelongsToAccount(claims, account) {
  const email = typeof claims?.email === 'string' ? claims.email : '';
  if (!email || !account) {
    return true;
  }
  return email.trim().toLowerCase() === String(account).trim().toLowerCase();
}

async function currentIdentityToken() {
  const { core } = await loadAmplify();
  const session = await core.Amplify.fetchAuthSession();
  const token = session?.tokens?.idToken ?? null;
  if (!token) {
    return null;
  }
  const value = token.toString();
  return { token: value, claims: decodeTokenClaims(value) };
}

/**
 * Returns the identity token of the person who just signed in. The DevLoop
 * server verifies that token before it creates the application session.
 */
export async function readIdentityToken() {
  const session = await currentIdentityToken();
  if (!session) {
    const error = new Error('Cognito did not return an identity for this sign-in.');
    error.code = 'COGNITO_IDENTITY_MISSING';
    throw error;
  }
  return session.token;
}

/**
 * Drops the Cognito session that Amplify keeps in the browser. The DevLoop
 * session lives in an http-only cookie, so the tokens do not need to stay in
 * local storage once the application session exists.
 */
export async function forgetCognitoSession() {
  try {
    const { auth } = await loadAmplify();
    await auth.signOut();
  } catch {
    // There was no Amplify session to end, which is fine.
  }
}
