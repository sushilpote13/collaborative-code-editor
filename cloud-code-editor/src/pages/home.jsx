import { useState } from 'react';
import { Link } from 'react-router-dom';
import devLoopLogo from '../assets/DevLoop Neon Cloud Logo.png';
import './home.css';

const setupSteps = [
  'Create your account',
  'Start a shared workspace',
  'Invite your collaborators',
];

function Home() {
  const [notice, setNotice] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setNotice('Sending your details for verification...');

    const formData = new FormData(event.currentTarget);
    const details = {
      firstName: formData.get('firstName'),
      lastName: formData.get('lastName'),
      email: formData.get('email'),
    };

    try {
      const response = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(details),
      });

      if (!response.ok) {
        throw new Error(`The server returned ${response.status}.`);
      }

      setNotice('Your name and email were sent to the server terminal for verification.');
    } catch (error) {
      setNotice(`Could not send your details: ${error.message}`);
    }
  }

  return (
    <main className="signup-page">
      <section className="signup-card" aria-label="Create a DevLoop account">
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
            <span className="eyebrow">Get started for free</span>
            <h2>Create your account</h2>
            <p>Set up your DevLoop account to start collaborating.</p>
          </div>

          <form className="signup-form" onSubmit={handleSubmit}>
            <div className="name-fields">
              <label className="form-field">
                <span>First name</span>
                <input
                  autoComplete="given-name"
                  name="firstName"
                  placeholder="e.g. Alex"
                  required
                />
              </label>
              <label className="form-field">
                <span>Last name</span>
                <input
                  autoComplete="family-name"
                  name="lastName"
                  placeholder="e.g. Morgan"
                  required
                />
              </label>
            </div>

            <label className="form-field">
              <span>Email address</span>
              <input
                autoComplete="email"
                name="email"
                placeholder="you@example.com"
                required
                type="email"
              />
            </label>

            <label className="form-field">
              <span>Password</span>
              <input
                autoComplete="new-password"
                minLength={8}
                name="password"
                placeholder="At least 8 characters"
                required
                type="password"
              />
              <small>Use at least 8 characters.</small>
            </label>

            <button className="create-account-button" type="submit">
              Create account
              <span aria-hidden="true">→</span>
            </button>

            <p aria-live="polite" className="form-notice">
              {notice}
            </p>
          </form>

          <div className="form-footer">
            <span>Already have a workspace?</span>
            <Link to="/editor/demo-room">Open the editor</Link>
          </div>
        </section>
      </section>
    </main>
  );
}

export default Home;
