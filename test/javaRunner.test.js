import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { runJava } from '../server/services/javaRunner.js';
import { createSessionToken } from '../server/services/session.js';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-with-at-least-32-characters-needed';

test('Java runner executes a valid single-file program', async () => {
  const result = await runJava([
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { System.out.println("Hello DevLoop Java!"); } }',
    },
  ]);

  assert.equal(result.stage, 'run');
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Hello DevLoop Java!/);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
});

test('Java runner handles compilation errors gracefully', async () => {
  const result = await runJava([
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { int error = ; } }',
    },
  ]);

  assert.equal(result.stage, 'compile');
  assert.equal(result.success, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /error:/i);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputLimitExceeded, false);
});

test('Java runner handles runtime exceptions', async () => {
  const result = await runJava([
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { throw new ArithmeticException("Division error test"); } }',
    },
  ]);

  assert.equal(result.stage, 'run');
  assert.equal(result.success, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /ArithmeticException.*Division error test/);
});

test('Java runner supports program input (stdin)', async () => {
  const result = await runJava([
    {
      name: 'Main.java',
      source: `import java.util.Scanner;
public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        String name = scanner.nextLine();
        System.out.println("Greetings, " + name);
    }
}`,
    },
  ], 'DevLoop QA Engineer');

  assert.equal(result.success, true);
  assert.match(result.output, /Greetings, DevLoop QA Engineer/);
});

test('Java runner supports multi-file Java projects', async () => {
  const result = await runJava([
    {
      name: 'Helper.java',
      source: 'public class Helper { public static String getPlatform() { return "DevLoop MultiFile Platform"; } }',
    },
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { System.out.println("Running on: " + Helper.getPlatform()); } }',
    },
  ]);

  assert.equal(result.success, true);
  assert.match(result.output, /Running on: DevLoop MultiFile Platform/);
});

test('Java runner enforces execution timeout on infinite loops', async () => {
  const startTime = Date.now();
  const result = await runJava([
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { while (true) {} } }',
    },
  ]);
  const duration = Date.now() - startTime;

  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert(duration >= 7000, `Execution should wait for timeout (took ${duration}ms)`);
});

test('Java runner truncates unbounded output and stops execution', async () => {
  const result = await runJava([
    {
      name: 'Main.java',
      source: 'public class Main { public static void main(String[] args) { while (true) { System.out.println("DevLoop spam output line"); } } }',
    },
  ]);

  assert.equal(result.success, false);
  assert.equal(result.outputLimitExceeded, true);
  assert(result.output.length <= 64 * 1024, `Output should not exceed 64 KB (was ${result.output.length})`);
});

test('Java runner rejects oversized files and projects', async () => {
  const hugeSource = 'public class Main { /* ' + 'x'.repeat(33 * 1024) + ' */ public static void main(String[] args) {} }';

  await assert.rejects(
    async () => {
      await runJava([{ name: 'Main.java', source: hugeSource }]);
    },
    (error) => error.status === 413,
  );
});

test('POST /api/java/run requires authentication', async () => {
  const app = createApp({ databaseReady: () => true });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/java/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'public class Main { public static void main(String[] args) {} }',
      }),
    });

    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'Please log in to continue.');
  } finally {
    server.close();
  }
});

test('POST /api/java/run validates request payload', async () => {
  const app = createApp({ databaseReady: () => true });
  const server = createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const sessionToken = createSessionToken({ userId: 'test-user-id-123' });

  try {
    // Missing Main.java
    const noMainResponse = await fetch(`http://127.0.0.1:${port}/api/java/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `authToken=${sessionToken}`,
      },
      body: JSON.stringify({
        sourceFiles: [{ name: 'Helper.java', source: 'public class Helper {}' }],
      }),
    });
    assert.equal(noMainResponse.status, 400);
    const noMainBody = await noMainResponse.json();
    assert.match(noMainBody.error, /Main\.java/);

    // Empty source
    const emptyResponse = await fetch(`http://127.0.0.1:${port}/api/java/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `authToken=${sessionToken}`,
      },
      body: JSON.stringify({ source: '   ' }),
    });
    assert.equal(emptyResponse.status, 400);

    // Valid authenticated execution
    const validResponse = await fetch(`http://127.0.0.1:${port}/api/java/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `authToken=${sessionToken}`,
      },
      body: JSON.stringify({
        source: 'public class Main { public static void main(String[] args) { System.out.println("API Run Success"); } }',
      }),
    });
    assert.equal(validResponse.status, 200);
    const validBody = await validResponse.json();
    assert.equal(validBody.success, true);
    assert.match(validBody.output, /API Run Success/);
  } finally {
    server.close();
  }
});

