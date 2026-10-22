import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from '../../lib/cognito.js';

function RequireAuth({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);

  const [retryIndex, setRetryIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function verifySession() {
      try {
        const response = await apiFetch('/api/auth/me', {
          signal: controller.signal,
        });

        if (response.status === 401) {
          navigate('/', {
            replace: true,
            state: {
              notice: 'Please log in to open this page.',
              from: location.pathname,
            },
          });
          return;
        }

        if (!response.ok) {
          const message = response.status === 503
            ? 'The DevLoop authentication service is temporarily unavailable. Please try again.'
            : `The server returned ${response.status}.`;
          throw new Error(message);
        }

        const result = await response.json();
        setUser(result.user);
        setStatus('authenticated');
      } catch (requestError) {
        if (requestError.name !== 'AbortError') {
          setError(`Could not verify your login: ${requestError.message}`);
          setStatus('error');
        }
      }
    }

    verifySession();
    return () => controller.abort();
  }, [location.pathname, navigate, retryIndex]);

  if (status === 'authenticated') {
    return <>{children(user)}</>;
  }

  if (status === 'error') {
    return (
      <main className="signup-page">
        <section className="signup-card auth-error-card">
          <div className="signup-form-panel">
            <h1>Could not verify login</h1>
            <p className="form-notice" role="alert">{error}</p>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', alignItems: 'center' }}>
              <button
                type="button"
                className="submit-button"
                style={{ width: 'auto', padding: '0.6rem 1.2rem' }}
                onClick={() => {
                  setError('');
                  setStatus('checking');
                  setRetryIndex((count) => count + 1);
                }}
              >
                Retry
              </button>
              <Link className="auth-mode-toggle" to="/">Return to login</Link>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="signup-page">
      <p role="status">Verifying your login...</p>
    </main>
  );
}

export default RequireAuth;
