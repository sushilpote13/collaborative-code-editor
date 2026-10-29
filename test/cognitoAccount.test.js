import assert from 'node:assert/strict';
import test from 'node:test';
import { cognitoAccountName, cognitoUserAttributes } from '../src/lib/cognitoAccount.js';

test('the account is named by the email address of the person', () => {
  assert.equal(cognitoAccountName('cloud@example.com'), 'cloud@example.com');
  assert.equal(cognitoAccountName('  cloud@example.com  '), 'cloud@example.com');
  assert.equal(cognitoAccountName(''), '');
  assert.equal(cognitoAccountName(undefined), '');
});

test('the account name is folded to lower case so it always matches the pool', () => {
  assert.equal(cognitoAccountName('Cloud@Example.com'), 'cloud@example.com');
  assert.equal(cognitoAccountName('  CLOUD@EXAMPLE.COM  '), 'cloud@example.com');
});

test('the name inside DevLoop travels as the preferred_username attribute', () => {
  const attributes = cognitoUserAttributes({
    username: 'alex_dev',
    firstName: 'Alex',
    lastName: 'Morgan',
  });

  assert.deepEqual(attributes, {
    preferred_username: 'alex_dev',
    given_name: 'Alex',
    family_name: 'Morgan',
  });
});

test('the email attribute is left to Cognito because the address is the account name', () => {
  const attributes = cognitoUserAttributes({
    username: 'alex_dev',
    firstName: 'Alex',
    lastName: 'Morgan',
  });

  assert.equal(
    Object.hasOwn(attributes, 'email'),
    false,
    'Cognito fills the email attribute in from the account name',
  );
});

test('missing details never reach Cognito as an undefined attribute', () => {
  assert.deepEqual(cognitoUserAttributes({}), {
    preferred_username: '',
    given_name: '',
    family_name: '',
  });
});
