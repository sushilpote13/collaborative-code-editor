import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApiError } from '../server/app.js';

function createResponse() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('AWS credential and service failures return a safe, actionable 503', () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const credentialsResponse = createResponse();
    handleApiError(
      Object.assign(new Error('Could not load credentials from any providers'), {
        name: 'CredentialsProviderError',
      }),
      {},
      credentialsResponse,
      assert.fail,
    );
    assert.equal(credentialsResponse.statusCode, 503);
    assert.deepEqual(credentialsResponse.body, {
      error: 'Cloud file storage is unavailable. Configure AWS credentials and S3 access for the server.',
    });

    const serviceResponse = createResponse();
    handleApiError(
      Object.assign(new Error('Access denied'), {
        $metadata: { httpStatusCode: 403 },
      }),
      {},
      serviceResponse,
      assert.fail,
    );
    assert.equal(serviceResponse.statusCode, 503);

    const applicationResponse = createResponse();
    handleApiError(new Error('Unexpected database error'), {}, applicationResponse, assert.fail);
    assert.equal(applicationResponse.statusCode, 500);
    assert.deepEqual(applicationResponse.body, { error: 'Internal server error.' });
  } finally {
    console.error = originalConsoleError;
  }
});
