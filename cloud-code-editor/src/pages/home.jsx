import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import devLoopLogo from '../assets/DevLoop Neon Cloud Logo.png';
import LoginForm from '../components/auth/LoginForm.jsx';
import SignupForm from '../components/auth/SignupForm.jsx';
import './home.css';

const setupSteps = [
  'Create your account',
  'Start a shared workspace',
  'Invite your collaborators',
];

function Home() {
  const location = useLocation();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState(location.state?.notice ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function switchMode(nextMode) {
    setMode(nextMode);
    setPassword('');
    setNotice('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setIsSubmitting(true);
    setNotice('');

    const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    const payload = mode === 'login'
      ? { email, password }
      : { firstName, lastName, username, email, password };

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(`The authentication server returned an invalid response (HTTP ${response.status}).`);
      }
      const result = await response.json();

      if (!response.ok) {
        if (mode === 'login' && result.code === 'ACCOUNT_NOT_FOUND') {
          setMode('signup');
          setPassword('');
          setNotice('No account uses this email yet. Add your name and create a password to sign up.');
          return;
        }

        if (mode === 'signup' && result.code === 'ACCOUNT_EXISTS') {
          setMode('login');
          setPassword('');
        }

        setNotice(result.error || 'Authentication failed. Please try again.');
        return;
      }

      const requestedPage = location.state?.from;
      const destination = typeof requestedPage === 'string' && requestedPage.startsWith('/editor/')
        ? requestedPage
        : '/meetings';
      navigate(destination, { replace: true });
    } catch (error) {
      setNotice(`Could not reach the authentication server: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="signup-page">
      <section className="signup-card" aria-label={mode === 'login' ? 'Log in to DevLoop' : 'Create a DevLoop account'}>
        <aside className="signup-intro">
          <img className="signup-logo" src={devLoopLogo} alt="DevLoop collaborative code editor" />

          <div className="intro-copy">
            <span className="eyebrow">A better way to build together</span>
            <h1>Code together. Create anything.</h1>
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
            <span className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Get started for free'}</span>
            <h2>{mode === 'login' ? 'Log in to DevLoop' : 'Create your account'}</h2>
            <p>
              {mode === 'login'
                ? 'Enter your account details to continue.'
                : 'Set up your DevLoop account to start collaborating.'}
            </p>
          </div>

          <form className="signup-form" onSubmit={handleSubmit}>
            {mode === 'login' ? (
              <LoginForm
                email={email}
                isSubmitting={isSubmitting}
                onEmailChange={setEmail}
                onPasswordChange={setPassword}
                password={password}
              />
            ) : (
              <SignupForm
                email={email}
                firstName={firstName}
                isSubmitting={isSubmitting}
                lastName={lastName}
                onEmailChange={setEmail}
                onFirstNameChange={setFirstName}
                onLastNameChange={setLastName}
                onPasswordChange={setPassword}
                onUsernameChange={setUsername}
                password={password}
                username={username}
              />
            )}

            <p aria-live="polite" className="form-notice" role="status">
              {notice}
            </p>
          </form>

          <div className="form-footer">
            <span>{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}</span>
            <button
              className="auth-mode-toggle"
              disabled={isSubmitting}
              onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
              type="button"
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}

export default Home;
