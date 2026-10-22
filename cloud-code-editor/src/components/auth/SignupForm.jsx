import PasswordField from './PasswordField.jsx';

function SignupForm({
  email,
  firstName,
  isSubmitting,
  lastName,
  onEmailChange,
  onFirstNameChange,
  onLastNameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onUsernameChange,
  password,
  confirmPassword,
  username,
}) {
  return (
    <>
      <div className="name-fields">
        <div className="form-field">
          <label htmlFor="signup-first-name">First name</label>
          <input
            autoComplete="given-name"
            id="signup-first-name"
            maxLength={80}
            name="firstName"
            onChange={(event) => onFirstNameChange(event.target.value)}
            placeholder="e.g. Alex"
            required
            value={firstName}
          />
        </div>
        <div className="form-field">
          <label htmlFor="signup-last-name">Last name</label>
          <input
            autoComplete="family-name"
            id="signup-last-name"
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
        <label htmlFor="signup-username">Username</label>
        <input
          autoComplete="username"
          id="signup-username"
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

      <div className="form-field">
        <label htmlFor="signup-email">Email address</label>
        <input
          autoComplete="email"
          id="signup-email"
          name="email"
          onChange={(event) => onEmailChange(event.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={email}
        />
        <small>We send a confirmation code here before the account goes live.</small>
      </div>

      <PasswordField
        autoComplete="new-password"
        label="Password"
        onChange={onPasswordChange}
        placeholder="Create a password"
        showChecklist
        value={password}
      />

      <PasswordField
        autoComplete="new-password"
        label="Confirm password"
        name="confirmPassword"
        onChange={onConfirmPasswordChange}
        placeholder="Repeat your password"
        value={confirmPassword}
      />

      <button className="create-account-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Creating your account...' : 'Create my account'}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}

export default SignupForm;
