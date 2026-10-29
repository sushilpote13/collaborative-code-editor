import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp, handleApiError } from '../server/app.js';

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

test('the API reports its degraded database status and a clear 503 for session routes', async () => {
  const server = createApp({ databaseReady: () => false }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const { port } = server.address();
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthResponse.status, 503);
    assert.deepEqual(await healthResponse.json(), {
      status: 'degraded',
      database: 'unavailable',
    });

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'valid-shaped-token' }),
    });
    assert.equal(sessionResponse.status, 503);
    assert.deepEqual(await sessionResponse.json(), {
      code: 'DATABASE_UNAVAILABLE',
      error: 'The DevLoop database is unavailable. Check the MongoDB Atlas network access list and try again.',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
