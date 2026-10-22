import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import devLoopLogo from '../assets/DevLoop Neon Cloud Logo.png';
import CodeForm from '../components/auth/CodeForm.jsx';
import LoginForm from '../components/auth/LoginForm.jsx';
import PasswordField from '../components/auth/PasswordField.jsx';
import ProfileForm from '../components/auth/ProfileForm.jsx';
import SignupForm from '../components/auth/SignupForm.jsx';
import {
  confirmPasswordReset,
  confirmRegistration,
  confirmSecondFactor,
  forgetCognitoSession,
  readIdentityToken,
  registerWithEmail,
  requestPasswordResetCode,
  resendConfirmationCode,
  signInWithPassword,
} from '../lib/cognitoClient.js';
import { isExistingAccountError } from '../lib/authErrors.js';
import {
  authScreens,
  describeAuthFailure,
  describeExistingAccountFailure,
} from '../lib/authFlow.js';
import { isValidEmail, isValidUsername } from '../lib/authValidation.js';
import { cognitoAccountName } from '../lib/cognitoAccount.js';
import {
  completeCognitoLogin,
  createBackendSession,
  createSessionFromIdentityToken,
  resolveSignInIdentifier,
} from '../lib/cognito.js';
import { getCognitoErrorMessage, describeCognitoProviderError } from '../lib/cognitoErrors.js';
import './home.css';

const setupSteps = [
  'Create your account',
  'Start a shared workspace',
  'Invite your collaborators',
];

const screens = {
  login: {
    eyebrow: 'Welcome back',
    heading: 'Sign in to DevLoop',
    subheading: 'Use the email address of your account and your password to continue.',
    brand: 'Welcome back. Your team is waiting in the workspace.',
  },
  signup: {
    eyebrow: 'Get started for free',
    heading: 'Create your DevLoop account',
    subheading: 'One account for every shared workspace your team builds together.',
    brand: 'Code together. Create anything.',
  },
  confirm: {
    eyebrow: 'One last step',
    heading: 'Confirm your email',
    subheading: 'We sent a six digit code to your email address. Enter it here to finish creating your account.',
    brand: 'Almost there. Confirm your email and your workspace is ready.',
  },
  forgot: {
    eyebrow: 'Password help',
    heading: 'Reset your password',
    subheading: 'Tell us the email address of your account and we will send you a code to set a new password.',
    brand: 'Back into your workspace in a moment.',
  },
  reset: {
    eyebrow: 'Password help',
    heading: 'Choose a new password',
    subheading: 'Pick a strong password you have not used before, then confirm it below.',
    brand: 'A fresh password gets you straight back in.',
  },
  mfa: {
    eyebrow: 'Security check',
    heading: 'Confirm that it is you',
    subheading: 'Enter the code from your authenticator app or the code we sent to your phone.',
    brand: 'One more check, then you are in.',
  },
  profile: {
    eyebrow: 'One last step',
    heading: 'Complete your profile',
    subheading: 'Choose the name your collaborators will see inside shared workspaces.',
    brand: 'Pick a name your team will recognise.',
  },
};

function getCallbackNotice() {
  const parameters = new URLSearchParams(window.location.search);
  const providerError = parameters.get('error');
  if (providerError) {
    return describeCognitoProviderError(providerError, parameters.get('error_description'));
  }
  const hasCode = parameters.has('code');
  const hasState = parameters.has('state');
  if (hasCode !== hasState) {
    return 'Cognito sign-in was canceled or could not be completed. Please try again.';
  }
  return '';
}

function Home() {
  const location = useLocation();
  const navigate = useNavigate();
  const callbackHandled = useRef(false);
  const returnTo = location.state?.from;
  const [screen, setScreen] = useState('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pendingAccount, setPendingAccount] = useState('');
  const [notice, setNotice] = useState(() => getCallbackNotice() || location.state?.notice || '');
  const [noticeType, setNoticeType] = useState(() => (getCallbackNotice() || location.state?.notice ? 'error' : 'info'));
  const [isSubmitting, setIsSubmitting] = useState(() => {
    const parameters = new URLSearchParams(window.location.search);
    return parameters.has('code') && parameters.has('state');
  });

  const showNotice = useCallback((message, type = 'error') => {
    setNotice(message);
    setNoticeType(type);
  }, []);

  const goToScreen = useCallback((nextScreen, message = '', type = 'info') => {
    setScreen(nextScreen);
    setCode('');
    setPassword('');
    setConfirmPassword('');
    showNotice(message, type);
  }, [showNotice]);

  const openDestination = useCallback((requestedPage) => {
    const destination = typeof requestedPage === 'string'
      && (requestedPage === '/meetings' || /^\/editor\/[A-Za-z0-9_-]{3,40}$/.test(requestedPage))
      ? requestedPage
      : '/meetings';
    navigate(destination, { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (callbackHandled.current) {
      return;
    }

    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get('code');
    const state = parameters.get('state');
    const providerError = parameters.get('error');
    if (!code && !state && !providerError) {
      return;
    }

    callbackHandled.current = true;
    window.history.replaceState({}, document.title, window.location.pathname);
    if (providerError || !code || !state) {
      return;
    }

    completeCognitoLogin(code, state)
      .then((result) => {
        if (result.profileRequired) {
          setScreen('profile');
          setEmail(result.email);
          showNotice('Choose a username and display name to finish setting up your account.');
          return;
        }
        openDestination(result.returnTo);
      })
      .catch((error) => {
        showNotice(getCognitoErrorMessage(error));
      })
      .finally(() => setIsSubmitting(false));
  }, [openDestination, showNotice]);

  /**
   * Turns the identity token Cognito issued into a DevLoop session. The
   * server verifies that token before it starts the session.
   *
   * A failure never leaves the screen that is open, because a screen that
   * cannot continue is what made a confirmed account look stuck. The failure
   * decides which screen can still make progress, and the message says what
   * to do there.
   */
  const finishSignIn = useCallback(async (profile, options = {}) => {
    const {
      screen: currentScreen = authScreens.login,
      message = '',
    } = options;

    try {
      const idToken = await readIdentityToken();
      const result = await createSessionFromIdentityToken(idToken, {
        profile,
        returnTo,
      });

      if (result.profileRequired) {
        setScreen(authScreens.profile);
        setEmail(result.email ?? email);
        showNotice('Choose a username and display name to finish setting up your account.');
        return false;
      }

      // The DevLoop session lives in an http-only cookie, so the tokens that
      // Cognito handed to the browser are not needed any more.
      await forgetCognitoSession();
      openDestination(result.returnTo);
      return true;
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: currentScreen, message });
      goToScreen(failure.screen, failure.message, 'error');
      return false;
    }
  }, [email, goToScreen, openDestination, returnTo, showNotice]);

  async function handleSignIn(event) {
    event.preventDefault();
    if (!isValidEmail(identifier)) {
      showNotice('Enter the email address of your DevLoop account.');
      return;
    }
    if (!password) {
      showNotice('Enter your password to continue.');
      return;
    }

    setIsSubmitting(true);
    try {
      const account = await resolveSignInIdentifier(identifier);
      const result = await signInWithPassword({
        account: account ?? cognitoAccountName(identifier),
        password,
      });

      if (result.status === 'mfa-required') {
        setPendingAccount(result.account);
        goToScreen('mfa');
        return;
      }
      await finishSignIn({}, { screen: authScreens.login });
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: authScreens.login });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  /**
   * The account of Amazon Cognito already exists. The password that was typed
   * decides what happens next, so the sign-in is tried with it: a person who
   * signs up a second time lands in the workspace instead of being told to
   * create an account that cannot exist.
   */
  const signInToExistingAccount = useCallback(async (profile) => {
    const account = cognitoAccountName(email);

    try {
      const result = await signInWithPassword({ account, password });

      if (result.status === 'mfa-required') {
        setPendingAccount(result.account);
        goToScreen(authScreens.mfa);
        return;
      }
      await finishSignIn(profile, { screen: authScreens.login });
    } catch (signInError) {
      const failure = describeExistingAccountFailure(signInError, account);
      if (failure.identifier) {
        setIdentifier(failure.identifier);
      }
      if (failure.screen === authScreens.confirm) {
        setPendingAccount(account);
      }
      if (failure.screen === authScreens.signup) {
        // The sign-up screen is already open, so the form keeps what was
        // typed and only the name has to be changed.
        showNotice(failure.message, 'error');
        return;
      }
      goToScreen(failure.screen, failure.message, 'error');
    }
  }, [email, finishSignIn, goToScreen, password, showNotice]);

  async function handleSignUp(event) {
    event.preventDefault();
    if (!isValidUsername(username)) {
      showNotice('Pick a username with 3 to 20 letters, numbers, or underscores.');
      return;
    }
    if (!firstName.trim() || !lastName.trim()) {
      showNotice('Tell us your first and last name.');
      return;
    }
    if (!isValidEmail(email)) {
      showNotice('Enter a valid email address.');
      return;
    }
    if (!password) {
      showNotice('Choose a password to protect your account.');
      return;
    }
    if (password !== confirmPassword) {
      showNotice('Both passwords need to be the same.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await registerWithEmail({
        username: username.trim(),
        password,
        email: email.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });

      if (result.status === 'confirm-required') {
        setPendingAccount(result.account);
        goToScreen(
          'confirm',
          `We sent a confirmation code to ${email.trim()}. Enter it below to finish creating your account.`,
          'success',
        );
        return;
      }
      await finishSignIn({ firstName, lastName, username }, { screen: authScreens.login });
    } catch (error) {
      if (isExistingAccountError(error)) {
        await signInToExistingAccount({ firstName, lastName, username });
        return;
      }
      const failure = describeAuthFailure(error, { screen: authScreens.signup });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleConfirmRegistration(event) {
    event.preventDefault();
    if (code.length !== 6) {
      showNotice('Enter the six digit code from your email.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await confirmRegistration({
        account: pendingAccount,
        confirmationCode: code,
      });

      if (result.status === 'signed-in') {
        await finishSignIn(
          { firstName, lastName, username },
          {
            screen: authScreens.login,
            message: 'Your email address is confirmed. Sign in with your password to continue.',
          },
        );
        return;
      }
      goToScreen(
        'login',
        'Your email address is confirmed. Sign in with your password to continue.',
        'success',
      );
    } catch (error) {
      const failure = describeAuthFailure(error, {
        screen: authScreens.confirm,
        message: 'That code could not be confirmed. Send the code again and enter the new one.',
      });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResendCode() {
    setIsSubmitting(true);
    try {
      await resendConfirmationCode({ account: pendingAccount });
      showNotice('We sent a new code to your email address.', 'success');
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: authScreens.confirm });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleForgotPassword(event) {
    event.preventDefault();
    if (!isValidEmail(identifier)) {
      showNotice('Enter the email address of your DevLoop account.');
      return;
    }

    setIsSubmitting(true);
    try {
      const resolvedAccount = await resolveSignInIdentifier(identifier);
      const account = resolvedAccount ?? cognitoAccountName(identifier);
      await requestPasswordResetCode({ account });
      setPendingAccount(account);
      goToScreen(
        'reset',
        `We sent a six digit code to ${identifier.trim()}. Enter it below to set a new password.`,
        'success',
      );
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: authScreens.forgot });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();
    if (code.length !== 6) {
      showNotice('Enter the six digit code from your email.');
      return;
    }
    if (!password) {
      showNotice('Choose a new password.');
      return;
    }
    if (password !== confirmPassword) {
      showNotice('Both passwords need to be the same.');
      return;
    }

    setIsSubmitting(true);
    try {
      await confirmPasswordReset({
        account: pendingAccount,
        confirmationCode: code,
        newPassword: password,
      });
      setIdentifier(pendingAccount);
      goToScreen(
        'login',
        'Your password is updated. Sign in with your new password.',
        'success',
      );
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: authScreens.reset });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSecondFactor(event) {
    event.preventDefault();
    if (!code.trim()) {
      showNotice('Enter the code from your authenticator app.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await confirmSecondFactor({ challengeResponse: code.trim() });
      if (result.status === 'mfa-required') {
        showNotice('That code was not accepted. Enter the new code we sent you.');
        setCode('');
        return;
      }
      await finishSignIn({}, { screen: authScreens.mfa });
    } catch (error) {
      const failure = describeAuthFailure(error, { screen: authScreens.mfa });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleProfile(event) {
    event.preventDefault();
    if (!isValidUsername(username)) {
      showNotice('Pick a username with 3 to 20 letters, numbers, or underscores.');
      return;
    }
    if (!firstName.trim() || !lastName.trim()) {
      showNotice('Tell us your first and last name.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createBackendSession({ firstName, lastName, username });
      openDestination(result.returnTo || location.state?.from);
    } catch (error) {
      const failure = describeAuthFailure(error, {
        screen: authScreens.profile,
        message: getCognitoErrorMessage(error),
      });
      goToScreen(failure.screen, failure.message, 'error');
    } finally {
      setIsSubmitting(false);
    }
  }

  const content = screens[screen];
  const isLogin = screen === 'login';
  const isSignup = screen === 'signup';

  function submitHandler(event) {
    if (screen === 'login') {
      handleSignIn(event);
      return;
    }
    if (screen === 'signup') {
      handleSignUp(event);
      return;
    }
    if (screen === 'confirm') {
      handleConfirmRegistration(event);
      return;
    }
    if (screen === 'forgot') {
      handleForgotPassword(event);
      return;
    }
    if (screen === 'reset') {
      handleResetPassword(event);
      return;
    }
    if (screen === 'mfa') {
      handleSecondFactor(event);
      return;
    }
    handleProfile(event);
  }

  return (
    <main className="signup-page">
      <section className="signup-card" aria-label={content.heading}>
        <aside className="signup-intro">
          <img className="signup-logo" src={devLoopLogo} alt="DevLoop collaborative code editor" />

          <div className="intro-copy">
            <span className="eyebrow">A better way to build together</span>
            <h1>{content.brand}</h1>
            <p>
              Bring your team into one shared workspace and turn good ideas into
              great software.
            </p>
          </div>

          <ol className="setup-steps" aria-label="Getting started">
            {setupSteps.map((step, index) => (
              <li className={index === 0 ? 'setup-step is-current' : 'setup-step'} key={step}>
                <span className="step-number">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <span className="intro-caption">Your next great idea starts here.</span>
        </aside>

        <section className="signup-form-panel">
          <div className="form-heading">
            <span className="eyebrow">{content.eyebrow}</span>
            <h2>{content.heading}</h2>
            <p>{content.subheading}</p>
          </div>

          <form className="signup-form" onSubmit={submitHandler}>
            {isLogin && (
              <LoginForm
                identifier={identifier}
                isSubmitting={isSubmitting}
                onForgotPassword={() => goToScreen('forgot')}
                onIdentifierChange={setIdentifier}
                onPasswordChange={setPassword}
                password={password}
              />
            )}

            {isSignup && (
              <SignupForm
                confirmPassword={confirmPassword}
                email={email}
                firstName={firstName}
                isSubmitting={isSubmitting}
                lastName={lastName}
                onConfirmPasswordChange={setConfirmPassword}
                onEmailChange={setEmail}
                onFirstNameChange={setFirstName}
                onLastNameChange={setLastName}
                onPasswordChange={setPassword}
                onUsernameChange={setUsername}
                password={password}
                username={username}
              />
            )}

            {screen === 'confirm' && (
              <CodeForm
                code={code}
                description={`Enter the code we sent to your email address.`}
                isSubmitting={isSubmitting}
                onCodeChange={setCode}
                onResend={handleResendCode}
                onSubmitLabel="Confirm my email"
                resendLabel="Send the code again"
              />
            )}

            {screen === 'forgot' && (
              <div className="form-field">
                <label htmlFor="forgot-identifier">Email address</label>
                <input
                  autoComplete="email"
                  id="forgot-identifier"
                  name="identifier"
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="you@example.com"
                  required
                  type="email"
                  value={identifier}
                />
                <button className="create-account-button" disabled={isSubmitting} type="submit">
                  {isSubmitting ? 'Sending the code...' : 'Email me a code'}
                  <span aria-hidden="true">→</span>
                </button>
                <button className="link-button" onClick={() => goToScreen('login')} type="button">
                  Back to sign in
                </button>
              </div>
            )}

            {screen === 'reset' && (
              <>
                <CodeForm
                  code={code}
                  description="Enter the code we emailed you."
                  hideSubmitButton
                  isSubmitting={isSubmitting}
                  onCodeChange={setCode}
                  onSubmitLabel="Set my new password"
                />
                <PasswordField
                  autoComplete="new-password"
                  label="New password"
                  onChange={setPassword}
                  placeholder="Create a new password"
                  showChecklist
                  value={password}
                />
                <PasswordField
                  autoComplete="new-password"
                  label="Confirm new password"
                  name="confirmPassword"
                  onChange={setConfirmPassword}
                  placeholder="Repeat your new password"
                  value={confirmPassword}
                />
                <button className="create-account-button" disabled={isSubmitting} type="submit">
                  {isSubmitting ? 'Saving your new password...' : 'Set my new password'}
                  <span aria-hidden="true">→</span>
                </button>
              </>
            )}

            {screen === 'mfa' && (
              <CodeForm
                code={code}
                description="Enter the six digit code from your authenticator app."
                isSubmitting={isSubmitting}
                onCodeChange={setCode}
                onSubmitLabel="Verify and continue"
              />
            )}

            {screen === 'profile' && (
              <ProfileForm
                firstName={firstName}
                isSubmitting={isSubmitting}
                lastName={lastName}
                onFirstNameChange={setFirstName}
                onLastNameChange={setLastName}
                onUsernameChange={setUsername}
                username={username}
              />
            )}

            <p
              aria-live="polite"
              className={noticeType === 'error' ? 'form-notice is-error' : 'form-notice is-success'}
              role="status"
            >
              {isSubmitting ? 'Talking to the sign-in service...' : notice}
            </p>
          </form>

          {(isLogin || isSignup) && (
            <div className="form-footer">
              <span>{isLogin ? "Don't have an account?" : 'Already have an account?'}</span>
              <button
                className="auth-mode-toggle"
                disabled={isSubmitting}
                onClick={() => goToScreen(isLogin ? 'signup' : 'login')}
                type="button"
              >
                {isLogin ? 'Create an account' : 'Sign in'}
              </button>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default Home;
