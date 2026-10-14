function LoginForm({
  email,
  isSubmitting,
  onEmailChange,
  onPasswordChange,
  password,
}) {
  return (
    <>
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
          autoComplete="current-password"
          minLength={8}
          name="password"
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="Your password"
          required
          type="password"
          value={password}
        />
      </label>

      <button className="create-account-button" disabled={isSubmitting} type="submit">
        {isSubmitting ? 'Checking...' : 'Log in'}
        <span aria-hidden="true">→</span>
      </button>
    </>
  );
}

export default LoginForm;
