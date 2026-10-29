import { useId, useState } from 'react';
import { getPasswordIssues, passwordRequirements } from '../../lib/authValidation.js';

function PasswordField({
  autoComplete = 'current-password',
  label = 'Password',
  name = 'password',
  onChange,
  placeholder = 'Your password',
  showChecklist = false,
  value = '',
}) {
  const fieldId = useId();
  const [isVisible, setIsVisible] = useState(false);
  const issues = showChecklist ? getPasswordIssues(value) : [];

  return (
    <div className="form-field">
      <label htmlFor={fieldId}>{label}</label>
      <div className="password-input">
        <input
          autoComplete={autoComplete}
          id={fieldId}
          name={name}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required
          type={isVisible ? 'text' : 'password'}
          value={value}
        />
        <button
          aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="password-toggle"
          onClick={() => setIsVisible((current) => !current)}
          type="button"
        >
          {isVisible ? 'Hide' : 'Show'}
        </button>
      </div>
      {showChecklist && (
        <ul className="password-requirements">
          {passwordRequirements.map((requirement) => {
            const isMet = !issues.includes(requirement.label);
            return (
              <li className={isMet ? 'requirement is-met' : 'requirement'} key={requirement.id}>
                <span aria-hidden="true">{isMet ? '✓' : '•'}</span>
                {requirement.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default PasswordField;
