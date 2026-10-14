function SignupForm({
  email,
  firstName,
  isSubmitting,
  lastName,
  onEmailChange,
  onFirstNameChange,
  onLastNameChange,
  onPasswordChange,
  onUsernameChange,
  password,
  username,
}) {
  return (
    <>
      <div className="name-fields">
        <label className="form-field">
          <span>First name</span>
          <input
            autoComplete="given-name"
            maxLength={80}
            name="firstName"
            onChange={(event) => onFirstNameChange(event.target.value)}
            placeholder="e.g. Alex"
            required
            value={firstName}
          />
        </label>
        <label className="form-field">
          <span>Last name</span>
          <input
            autoComplete="family-name"
            maxLength={80}
            name="lastName"
            onChange={(event) => onLastNameChange(event.target.value)}
            placeholder="e.g. Morgan"
            required
            value={lastName}
          />
        </label>
      </div>

      <label className="form-field">
        <span>Username</span>
        <input
          autoComplete="username"
          maxLength={20}
          minLength={3}
          name="username"
          onChange={(event) => onUsernameChange(event.target.value)}
          pattern="[A-Za-z][A-Za-z0-9_]{2,19}"
          placeholder="e.g. alex_dev"
          required
          value={username}
        />
        <small>Shown in your workspace. Use 3-20 letters, numbers, or underscores.</small>
      </label>

      <label className="form-field">
        <span>Email address</span>
        <input
          autoComplete="email"
          name="email"
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
      </label>

      <label className="form-field">
        <span>Password</span>
        <input
          autoComplete="new-password"
          minLength={8}
          name="password"
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="At least 8 characters"
          required
          type="password"
          value={password}
        />
        <small>Use at least 8 characters. Passwords are stored as a secure hash.</small>
      </label>

      <button className="create-account-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Creating account...' : 'Sign up'}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}

export default SignupForm;
