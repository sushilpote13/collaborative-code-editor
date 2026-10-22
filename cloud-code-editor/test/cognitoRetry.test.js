import assert from 'node:assert/strict';
import test from 'node:test';
import { startCognitoLogin } from '../src/lib/cognito.js';

/**
 * A Content Security Policy without "unsafe-eval" refuses to run a string as
 * code. A timer that receives something else than a function is turned into
 * a string by the browser, so every timer of the sign-in flow has to get a
 * function.
 */
function withRecordedTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const recorded = [];

  globalThis.setTimeout = (callback, milliseconds) => {
    recorded.push({ callback, milliseconds });
    queueMicrotask(() => callback());
    return 0;
  };

  return run(recorded).finally(() => {
    globalThis.setTimeout = originalSetTimeout;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a sign-in that is refused twice is tried again and ends in a link', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;

  globalThis.fetch = async () => {
    requests += 1;
    if (requests < 3) {
      return jsonResponse({ error: 'The service is busy.' }, 503);
    }
    return jsonResponse({ authorizationUrl: 'https://example.com/cognito' });
  };

  try {
    const result = await withRecordedTimers(async (timers) => {
      const value = await startCognitoLogin({
        mode: 'login',
        email: 'cloud@example.com',
        profile: {},
        returnTo: '/meetings',
      });

      assert.ok(timers.length > 0, 'the retry has to wait before it tries again');
      for (const timer of timers) {
        assert.equal(
          typeof timer.callback,
          'function',
          'a timer has to get a function, a value would be run as code',
        );
      }

      return value;
    });

    assert.equal(requests, 3);
    assert.equal(result, 'https://example.com/cognito');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a sign-in that keeps failing gives up with the message of the server', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;

  globalThis.fetch = async () => {
    requests += 1;
    return jsonResponse({ error: 'The service is busy.' }, 503);
  };

  try {
    await assert.rejects(
      () => withRecordedTimers(() => startCognitoLogin({
        mode: 'login',
        email: 'cloud@example.com',
        profile: {},
        returnTo: '/meetings',
      })),
      /The service is busy\./,
    );
    assert.equal(requests, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
