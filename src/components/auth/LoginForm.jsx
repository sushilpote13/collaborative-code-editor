import PasswordField from './PasswordField.jsx';

function LoginForm({
  identifier,
  isSubmitting,
  onIdentifierChange,
  onPasswordChange,
  onForgotPassword,
  password,
}) {
  return (
    <>
      <div className="form-field">
        <label htmlFor="login-identifier">Email address</label>
        <input
          autoComplete="email"
          id="login-identifier"
          name="identifier"
          onChange={(event) => onIdentifierChange(event.target.value)}
          placeholder="you@example.com"
          required
          type="email"
          value={identifier}
        />
      </div>

      <PasswordField
        autoComplete="current-password"
        onChange={onPasswordChange}
        value={password}
      />

      <button className="link-button" onClick={onForgotPassword} type="button">
        Forgot your password?
      </button>

      <button className="create-account-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Signing in...' : 'Sign in to DevLoop'}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}

export default LoginForm;
