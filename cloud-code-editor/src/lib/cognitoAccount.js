/**
 * Amazon Cognito knows every account of the DevLoop user pool by the email
 * address of the person, because the pool is set up with the email address as
 * the sign-in attribute. Every request that names an account therefore has to
 * carry the email address of that account, and the name a person picks inside
 * DevLoop travels with the account as the preferred_username attribute.
 */

/**
 * The name that Cognito signs the account in with. The address is folded to
 * lower case, because that is the form the account is registered in, and
 * Cognito compares the name it is given with the name it knows exactly.
 */
export function cognitoAccountName(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * The attributes that describe the person inside Cognito. The email
 * attribute is left out on purpose: when the email address is the name of
 * the account, Cognito fills that attribute in itself.
 */
export function cognitoUserAttributes({ username, firstName, lastName }) {
  return {
    preferred_username: typeof username === 'string' ? username.trim() : '',
    given_name: typeof firstName === 'string' ? firstName.trim() : '',
    family_name: typeof lastName === 'string' ? lastName.trim() : '',
  };
}
