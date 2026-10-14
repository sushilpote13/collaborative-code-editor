import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

function RequireAuth({ children }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState('checking');
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);

  useEffect(() => {
    const controller = new AbortController();

    async function verifySession() {
      try {
        const response = await fetch('/api/auth/me', {
          credentials: 'same-origin',
          signal: controller.signal,
        });

        if (response.status === 401) {
          navigate('/', {
            replace: true,
            state: { notice: 'Please log in to open the editor.' },
          });
          return;
        }

        if (!response.ok) {
          throw new Error(`The server returned ${response.status}.`);
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
  }, [navigate]);

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
            <Link className="auth-mode-toggle" to="/">Return to login</Link>
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
