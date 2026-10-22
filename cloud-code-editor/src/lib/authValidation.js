export const passwordRequirements = [
  { id: 'length', label: 'At least 8 characters', test: (value) => value.length >= 8 },
  { id: 'uppercase', label: 'One uppercase letter', test: (value) => /[A-Z]/.test(value) },
  { id: 'lowercase', label: 'One lowercase letter', test: (value) => /[a-z]/.test(value) },
  { id: 'number', label: 'One number', test: (value) => /\d/.test(value) },
  { id: 'symbol', label: 'One symbol', test: (value) => /[^A-Za-z0-9]/.test(value) },
];

export const usernamePattern = /^[a-z][a-z0-9_]{2,19}$/i;
export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns the requirements a password still misses. Amazon Cognito applies a
 * password policy to every new account, and this mirrors the policy the
 * DevLoop user pool uses so people see what is missing before they submit.
 */
export function getPasswordIssues(password) {
  const value = typeof password === 'string' ? password : '';
  return passwordRequirements
    .filter((requirement) => !requirement.test(value))
    .map((requirement) => requirement.label);
}

export function isPasswordAcceptable(password) {
  return getPasswordIssues(password).length === 0;
}

export function isValidEmail(value) {
  return typeof value === 'string' && emailPattern.test(value.trim());
}

export function isValidUsername(value) {
  return typeof value === 'string' && usernamePattern.test(value.trim());
}

/**
 * Cognito sends a numeric code to the email address of the account. The
 * screen keeps the field numeric and asks for the exact number of digits.
 */
export function isValidConfirmationCode(value) {
  return typeof value === 'string' && /^\d{6}$/.test(value.trim());
}

export function sanitizeCode(value) {
  return typeof value === 'string' ? value.replace(/\D/g, '').slice(0, 6) : '';
}
