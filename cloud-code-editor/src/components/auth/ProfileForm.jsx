function ProfileForm({
  firstName,
  isSubmitting,
  lastName,
  onFirstNameChange,
  onLastNameChange,
  onUsernameChange,
  username,
}) {
  return (
    <>
      <div className="name-fields">
        <div className="form-field">
          <label htmlFor="profile-first-name">First name</label>
          <input
            autoComplete="given-name"
            id="profile-first-name"
            maxLength={80}
            name="firstName"
            onChange={(event) => onFirstNameChange(event.target.value)}
            placeholder="e.g. Alex"
            required
            value={firstName}
          />
        </div>
        <div className="form-field">
          <label htmlFor="profile-last-name">Last name</label>
          <input
            autoComplete="family-name"
            id="profile-last-name"
            maxLength={80}
            name="lastName"
            onChange={(event) => onLastNameChange(event.target.value)}
            placeholder="e.g. Morgan"
            required
            value={lastName}
          />
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="profile-username">Username</label>
        <input
          autoComplete="username"
          id="profile-username"
          maxLength={20}
          minLength={3}
          name="username"
          onChange={(event) => onUsernameChange(event.target.value)}
          pattern="[A-Za-z][A-Za-z0-9_]{2,19}"
          placeholder="e.g. alex_dev"
          required
          value={username}
        />
        <small>Your name inside shared workspaces. Letters, numbers, and underscores.</small>
      </div>

      <button className="create-account-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Saving...' : 'Finish setting up my account'}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}

export default ProfileForm;
