import { cognitoAccountName, cognitoUserAttributes } from './cognitoAccount.js';
import { signInWithSessionRecovery } from './cognitoSignIn.js';
import { Amplify } from 'aws-amplify';
import {
  autoSignIn,
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from '@aws-amplify/auth';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

let isConfigured = false;

/**
 * Configures Amazon Cognito once. Keeping the SDK imports static avoids
 * loading Vite's optimized aws-amplify module only after a person submits a
 * form, where a stale optimized bundle can interrupt the auth flow before
 * the app can show its next step.
 */
function configureAmplify() {
  if (isConfigured) {
    return;
  }

  if (!userPoolId || !clientId) {
    const error = new Error('DevLoop is not configured to sign in with Amazon Cognito.');
    error.code = 'COGNITO_NOT_CONFIGURED';
    throw error;
  }

  // The umbrella package wires the Cognito token provider to the resource
  // configuration. Configuring only the core package leaves the token store
  // without a user pool, and every sign-in then fails with
  // "Auth User Pool not configured".
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId: clientId,
        userPoolWebClientId: clientId,
        loginWith: { email: true },
      },
    },
  });

  isConfigured = true;
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
  configureAmplify();
  const result = await signInWithSessionRecovery({
    account,
    password,
    signIn: (username, credentials) => signIn({ username, password: credentials }),
    clearExistingSession: forgetCognitoSession,
  });
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
  configureAmplify();
  const account = cognitoAccountName(email);
  const result = await signUp({
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
  configureAmplify();
  await confirmSignUp({ username: account, confirmationCode });

  try {
    await autoSignIn();
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
  configureAmplify();
  await resetPassword({ username: account });
  return { status: 'code-sent', account };
}

export async function confirmPasswordReset({ account, confirmationCode, newPassword }) {
  configureAmplify();
  await confirmResetPassword({ username: account, confirmationCode, newPassword });
  return { status: 'password-reset', account };
}

export async function confirmSecondFactor({ challengeResponse }) {
  configureAmplify();
  const result = await confirmSignIn({ challengeResponse });
  const step = signInStepOf(result);

  return { status: needsSecondFactor(step) ? 'mfa-required' : 'signed-in' };
}

export async function resendConfirmationCode({ account }) {
  configureAmplify();
  await resendSignUpCode({ username: account });
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
  configureAmplify();
  const session = await fetchAuthSession();
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
    configureAmplify();
    await signOut();
  } catch {
    // There was no Amplify session to end, which is fine.
  }
}
