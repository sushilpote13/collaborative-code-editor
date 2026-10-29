import { sanitizeCode } from '../../lib/authValidation.js';

function CodeForm({
  code,
  description,
  hideSubmitButton = false,
  isSubmitting,
  onCodeChange,
  onResend,
  onSubmitLabel,
  resendLabel,
}) {
  return (
    <>
      <div className="form-field">
        <label htmlFor="confirmation-code">Confirmation code</label>
        <input
          autoComplete="one-time-code"
          className="code-input"
          id="confirmation-code"
          inputMode="numeric"
          maxLength={6}
          name="code"
          onChange={(event) => onCodeChange(sanitizeCode(event.target.value))}
          pattern="\d{6}"
          placeholder="000000"
          required
          value={code}
        />
        <small>{description}</small>
      </div>

      {!hideSubmitButton && (
        <button className="create-account-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Checking the code...' : onSubmitLabel}
          <span aria-hidden="true">→</span>
        </button>
      )}

      {onResend && (
        <button className="link-button" disabled={isSubmitting} onClick={onResend} type="button">
          {resendLabel}
        </button>
      )}
    </>
  );
}

export default CodeForm;
