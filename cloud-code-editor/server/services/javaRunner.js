import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const maxSourceBytes = 32 * 1024;
const maxOutputBytes = 64 * 1024;
const compileTimeoutMs = 15_000;
const runTimeoutMs = 8_000;

function javaEnvironment() {
  const keys = ['PATH', 'JAVA_HOME', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
  return Object.fromEntries(
    keys
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
}

function runProcess(command, args, cwd, timeoutMs, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: javaEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdin.on('error', () => {});
    child.stdin.end(input);

    function capture(stream, chunk) {
      if (outputBytes >= maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
        return;
      }

      const remainingBytes = maxOutputBytes - outputBytes;
      const accepted = chunk.subarray(0, remainingBytes);
      const text = accepted.toString('utf8');
      outputBytes += accepted.length;
      if (stream === 'stdout') {
        stdout += text;
      } else {
        stderr += text;
      }

      if (accepted.length < chunk.length || outputBytes === maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill();
      }
    }

    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once('close', (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
      });
    });
  });
}

export async function runJava(sourceFiles, input = '') {
  const sourceBytes = sourceFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.source, 'utf8'),
    0,
  );
  if (sourceBytes > maxSourceBytes * 4) {
    const error = new Error('The Java project must be no larger than 128 KB.');
    error.status = 413;
    throw error;
  }
  for (const file of sourceFiles) {
    if (Buffer.byteLength(file.source, 'utf8') > maxSourceBytes) {
      const error = new Error(`${file.name} must be no larger than ${maxSourceBytes / 1024} KB.`);
      error.status = 413;
      throw error;
    }
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'devloop-java-'));
  const sourcePaths = sourceFiles.map((file) => path.join(workspace, file.name));

  try {
    await Promise.all(sourceFiles.map((file, index) =>
      writeFile(sourcePaths[index], file.source, { encoding: 'utf8', flag: 'wx' }),
    ));

    let compilation;
    try {
      compilation = await runProcess(
        'javac',
        ['-J-Xmx256m', '-encoding', 'UTF-8', '-d', workspace, ...sourcePaths],
        workspace,
        compileTimeoutMs,
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        const compilerError = new Error('Java compiler not found. Install a JDK and add javac to PATH.');
        compilerError.status = 503;
        throw compilerError;
      }
      throw error;
    }

    if (compilation.exitCode !== 0 || compilation.timedOut || compilation.outputLimitExceeded) {
      return {
        stage: 'compile',
        success: false,
        exitCode: compilation.exitCode,
        output: [compilation.stdout, compilation.stderr].filter(Boolean).join(''),
        timedOut: compilation.timedOut,
        outputLimitExceeded: compilation.outputLimitExceeded,
      };
    }

    let execution;
    try {
      execution = await runProcess(
        'java',
        [
          '-Xms16m',
          '-Xmx128m',
          '-XX:MaxMetaspaceSize=128m',
          '-XX:ActiveProcessorCount=2',
          '-cp',
          workspace,
          'Main',
        ],
        workspace,
        runTimeoutMs,
        input,
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        const runtimeError = new Error('Java runtime not found. Install a JDK and add java to PATH.');
        runtimeError.status = 503;
        throw runtimeError;
      }
      throw error;
    }

    return {
      stage: 'run',
      success: execution.exitCode === 0 && !execution.timedOut && !execution.outputLimitExceeded,
      exitCode: execution.exitCode,
      output: [execution.stdout, execution.stderr].filter(Boolean).join(''),
      timedOut: execution.timedOut,
      outputLimitExceeded: execution.outputLimitExceeded,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
