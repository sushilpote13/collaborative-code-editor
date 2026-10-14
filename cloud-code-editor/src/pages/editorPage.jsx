import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

const apiUnavailableMessage =
  'The authentication API is unavailable. Run "npm run dev:api" in the cloud-code-editor folder and make sure MongoDB is running.';

function EditorPage({ user }) {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const [error, setError] = useState('');

  async function handleLogout() {
    setError('');

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        if (response.status === 502 || response.status === 503) {
          throw new Error(apiUnavailableMessage);
        }
        throw new Error(`The server returned ${response.status}.`);
      }

      navigate('/', { replace: true });
    } catch (requestError) {
      const message = requestError instanceof TypeError
        ? apiUnavailableMessage
        : requestError.message;
      setError(`Could not log out: ${message}`);
    }
  }

  return (
    <div className="editor-page">
      <h1>Code Editor</h1>
      <p className="editor-user">
        Logged in as{' '}
        <strong>
          {user.username ? `@${user.username}` : `${user.firstName} ${user.lastName}`}
        </strong>
      </p>
      <p>Workspace: {roomId}</p>
      {error && <p role="alert">{error}</p>}
      <button className="auth-mode-toggle" onClick={handleLogout} type="button">
        Log out
      </button>
    </div>
  );
}

export default EditorPage;
