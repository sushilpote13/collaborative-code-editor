import assert from 'node:assert/strict';
import test from 'node:test';
import { CognitoConfigurationError } from '../server/services/cognito.js';
import {
  createCognitoLogoutUrl,
  getCognitoOAuthConfiguration,
} from '../server/services/cognitoOAuth.js';

const validEnvironment = {
  VITE_AWS_REGION: 'ap-southeast-2',
  VITE_COGNITO_USER_POOL_ID: 'ap-southeast-2_apx0fB6sK',
  VITE_COGNITO_CLIENT_ID: 'h0e203t4q7bnq6744m8j8om39D',
  COGNITO_DOMAIN: 'https://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com',
  COGNITO_CALLBACK_URL: 'http://localhost:5173/',
  COGNITO_LOGOUT_URL: 'http://localhost:5173/',
  COGNITO_CLIENT_SECRET: '',
};

function environmentWith(overrides = {}) {
  const environment = { ...validEnvironment, ...overrides };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) {
      delete environment[key];
    }
  }
  return environment;
}

function withProcessEnvironment(environment, run) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('VITE_COGNITO') || key.startsWith('COGNITO_') || key === 'VITE_AWS_REGION') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, environment);
  try {
    return run();
  } finally {
    process.env = previous;
  }
}

test('a complete public-client configuration is accepted', () => {
  const configuration = getCognitoOAuthConfiguration(environmentWith());

  assert.equal(configuration.region, 'ap-southeast-2');
  assert.equal(configuration.userPoolId, 'ap-southeast-2_apx0fB6sK');
  assert.equal(configuration.clientId, 'h0e203t4q7bnq6744m8j8om39D');
  assert.equal(configuration.clientSecret, '');
  assert.equal(configuration.callbackUrl, 'http://localhost:5173/');
  assert.equal(
    configuration.domain,
    'https://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com',
  );
});

test('missing settings are reported by name', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({ VITE_COGNITO_CLIENT_ID: undefined })),
    (error) => {
      assert.ok(error instanceof CognitoConfigurationError);
      assert.match(error.message, /VITE_COGNITO_CLIENT_ID/);
      return true;
    },
  );

  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({ COGNITO_DOMAIN: undefined })),
    (error) => {
      assert.match(error.message, /COGNITO_DOMAIN/);
      return true;
    },
  );

  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({ COGNITO_CALLBACK_URL: undefined })),
    (error) => {
      assert.match(error.message, /COGNITO_CALLBACK_URL/);
      return true;
    },
  );
});

test('a duplicate app client id definition is rejected', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_CLIENT_ID: 'h0e203t4q7bnq6744m8j8om39D',
    })),
    (error) => {
      assert.ok(error instanceof CognitoConfigurationError);
      assert.match(error.message, /duplicate/i);
      return true;
    },
  );
});

test('the Cognito domain must be a bare HTTPS URL', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_DOMAIN: 'http://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com',
    })),
    CognitoConfigurationError,
  );

  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_DOMAIN: 'https://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com/login',
    })),
    CognitoConfigurationError,
  );

  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_DOMAIN: 'https://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com?x=1',
    })),
    CognitoConfigurationError,
  );
});

test('a Cognito domain from another region is rejected', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_DOMAIN: 'https://example.auth.us-east-1.amazoncognito.com',
    })),
    CognitoConfigurationError,
  );
});

test('a custom Cognito domain is accepted', () => {
  const configuration = getCognitoOAuthConfiguration(environmentWith({
    COGNITO_DOMAIN: 'https://login.devloop.example',
  }));
  assert.equal(configuration.domain, 'https://login.devloop.example');
});

test('a user pool from another region is rejected', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      VITE_COGNITO_USER_POOL_ID: 'us-east-1_apx0fB6sK',
    })),
    CognitoConfigurationError,
  );
});

test('a non-local callback URL must use HTTPS', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_CALLBACK_URL: 'http://app.devloop.example/',
    })),
    CognitoConfigurationError,
  );

  const configuration = getCognitoOAuthConfiguration(environmentWith({
    COGNITO_CALLBACK_URL: 'https://app.devloop.example/',
  }));
  assert.equal(configuration.callbackUrl, 'https://app.devloop.example/');
});

test('a callback URL that is not an absolute URL is rejected', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_CALLBACK_URL: '/callback',
    })),
    CognitoConfigurationError,
  );
});

test('a non-local sign-out URL must use HTTPS', () => {
  assert.throws(
    () => getCognitoOAuthConfiguration(environmentWith({
      COGNITO_LOGOUT_URL: 'http://app.devloop.example/',
    })),
    CognitoConfigurationError,
  );
});

test('the sign-out URL points at the Cognito logout endpoint', () => {
  withProcessEnvironment(environmentWith(), () => {
    const logoutUrl = new URL(createCognitoLogoutUrl());
    assert.equal(logoutUrl.origin, 'https://ap-southeast-2apx0fb6sk.auth.ap-southeast-2.amazoncognito.com');
    assert.equal(logoutUrl.pathname, '/logout');
    assert.equal(logoutUrl.searchParams.get('client_id'), 'h0e203t4q7bnq6744m8j8om39D');
    assert.equal(logoutUrl.searchParams.get('logout_uri'), 'http://localhost:5173/');
  });
});

test('no sign-out URL is produced when none is configured', () => {
  withProcessEnvironment(environmentWith({ COGNITO_LOGOUT_URL: undefined }), () => {
    assert.equal(createCognitoLogoutUrl(), null);
  });
});

test('a broken configuration does not throw while building the sign-out URL', () => {
  withProcessEnvironment(environmentWith({ COGNITO_DOMAIN: undefined }), () => {
    assert.equal(createCognitoLogoutUrl(), null);
  });
});
