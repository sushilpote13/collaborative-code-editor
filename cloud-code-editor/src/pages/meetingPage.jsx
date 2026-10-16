import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import './meetingPage.css';

function MeetingPage({ user }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState('');
  const displayName = user.username ? `@${user.username}` : `${user.firstName} ${user.lastName}`;
  const returnRoomId = location.state?.returnRoomId;

  function joinMeeting(event) {
    event.preventDefault();
    const room = roomId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(room)) {
      setError('Enter a room ID using 3-40 letters, numbers, hyphens, or underscores.');
      return;
    }

    navigate(`/editor/${encodeURIComponent(room)}`);
  }

  function createMeeting() {
    setRoomId(uuidv4());
    setError('');
  }

  return (
    <main className="meeting-page">
      <header className="meeting-topbar">
        <Link aria-label="DevLoop home" className="meeting-brand" to="/">
          <span className="meeting-brand-mark">D</span>
          <span>DevLoop</span>
        </Link>
        <span className="meeting-user">{displayName}</span>
      </header>

      <section aria-labelledby="meeting-title" className="meeting-content">
        <div className="meeting-card">
          <div className="meeting-heading">
            <span className="meeting-eyebrow">COLLABORATE</span>
            <h1 id="meeting-title">Join or create a meeting</h1>
            <p>Enter a room ID to join your team, or start a new workspace.</p>
          </div>

          <form className="meeting-join-form" onSubmit={joinMeeting}>
            <label htmlFor="meeting-room-id">Room ID</label>
            <input
              autoComplete="off"
              autoFocus
              id="meeting-room-id"
              maxLength={40}
              onChange={(event) => {
                setRoomId(event.target.value);
                setError('');
              }}
              placeholder="Enter the room ID"
              value={roomId}
            />
            <div className="meeting-identity">
              <span className="meeting-identity-avatar">
                {(user.username || user.firstName || '?')[0].toUpperCase()}
              </span>
              <span>Joining as <strong>{displayName}</strong></span>
            </div>
            <button className="meeting-join-button" type="submit">Join meeting</button>
          </form>

          {error && <p className="meeting-error" role="alert">{error}</p>}

          <div aria-hidden="true" className="meeting-divider"><span>OR</span></div>

          <div className="meeting-create">
            <div>
              <h2>Start a new meeting</h2>
              <p>Create a fresh room and invite your collaborators.</p>
            </div>
            <button className="meeting-create-button" onClick={createMeeting} type="button">
              <span aria-hidden="true">+</span>
              Create new meeting
            </button>
          </div>
        </div>

        {returnRoomId && (
          <Link className="meeting-back-link" to={`/editor/${encodeURIComponent(returnRoomId)}`}>
            ← Back to {returnRoomId}
          </Link>
        )}
      </section>
    </main>
  );
}

export default MeetingPage;
