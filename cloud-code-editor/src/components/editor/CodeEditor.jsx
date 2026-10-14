import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { java } from '@codemirror/lang-java';
import { oneDark } from '@codemirror/theme-one-dark';
import './codeEditor.css';

const file = { id: 'java', name: 'Main.java' };
const initialCode = `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, DevLoop!");
    }
}`;

const apiUnavailableMessage =
  'The authentication API is unavailable. Run "npm run dev:api" and make sure MongoDB is running.';

function CodeEditor({ user }) {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const [source, setSource] = useState(initialCode);
  const [isFileOpen, setIsFileOpen] = useState(true);
  const [isProjectExpanded, setIsProjectExpanded] = useState(true);
  const [isOpenEditorsExpanded, setIsOpenEditorsExpanded] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [programInput, setProgramInput] = useState('');
  const [output, setOutput] = useState('');
  const [outputKind, setOutputKind] = useState('empty');
  const [requestError, setRequestError] = useState('');

  async function runCode() {
    setIsRunning(true);
    setRequestError('');
    setOutput('');
    setOutputKind('empty');

    try {
      const response = await fetch('/api/java/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ source, input: programInput }),
      });
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error(response.status === 502 || response.status === 503
          ? apiUnavailableMessage
          : `The server returned an invalid response (HTTP ${response.status}).`);
      }

      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) {
          navigate('/', { replace: true, state: { notice: 'Please log in to run Java code.' } });
          return;
        }
        throw new Error(result.error || `The server returned ${response.status}.`);
      }

      let nextOutput = '';
      if (result.stage === 'compile' && !result.timedOut && !result.outputLimitExceeded) {
        nextOutput += 'Compilation failed.\n';
      } else if (result.stage === 'run') {
        nextOutput += result.success ? 'Build successful.\n' : 'Program finished with an error.\n';
      }

      if (result.output) {
        nextOutput += `${nextOutput ? '\n' : ''}${result.output}`;
      }
      if (result.timedOut) {
        nextOutput += '\nExecution stopped: time limit exceeded.';
      }
      if (result.outputLimitExceeded) {
        nextOutput += '\nOutput truncated: output limit exceeded.';
      }
      if (result.success && !result.output) {
        nextOutput += 'Program finished successfully with no output.';
      }

      setOutput(nextOutput.trimEnd());
      setOutputKind(result.success ? 'success' : 'error');
    } catch (error) {
      const message = error instanceof TypeError ? apiUnavailableMessage : error.message;
      setOutput(message);
      setOutputKind('error');
    } finally {
      setIsRunning(false);
    }
  }

  async function handleLogout() {
    setRequestError('');

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new Error(`The server returned ${response.status}.`);
      }

      navigate('/', { replace: true });
    } catch (error) {
      setRequestError(`Could not log out: ${error.message}`);
    }
  }

  const displayName = user.username ? `@${user.username}` : `${user.firstName} ${user.lastName}`;

  return (
    <main className="workbench">
      <header className="workbench-topbar">
        <a className="workbench-brand" href="/" aria-label="DevLoop home">
          <span className="brand-mark">D</span>
          <span>DevLoop</span>
        </a>
        <div className="workspace-title">
          <span className="workspace-title-label">WORKSPACE</span>
          <strong>{roomId}</strong>
        </div>
        <div className="workbench-actions">
          <button className="run-button" disabled={isRunning} onClick={runCode} type="button">
            <span aria-hidden="true">{isRunning ? '◌' : '▶'}</span>
            {isRunning ? 'Running…' : 'Run Java'}
          </button>
          <div className="profile-menu">
            <button
              aria-expanded={isProfileOpen}
              aria-haspopup="menu"
              className="profile-trigger"
              onClick={() => setIsProfileOpen((open) => !open)}
              type="button"
            >
              <span className="profile-avatar">{(user.username || user.firstName || '?')[0].toUpperCase()}</span>
              <span className="profile-trigger-name">{displayName}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {isProfileOpen && (
              <div className="profile-popover" role="menu">
                <strong>{displayName}</strong>
                <span>{user.firstName} {user.lastName}</span>
                <span>{user.email}</span>
                <button className="profile-logout" onClick={handleLogout} role="menuitem" type="button">
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav aria-label="Open files" className="file-tabs">
        {isFileOpen && (
          <div aria-current="page" className="file-tab is-active">
            <span aria-hidden="true" className="file-icon file-icon-java">J</span>
            <span className="file-tab-name">{file.name}</span>
            <button
              aria-label="Close Main.java"
              className="file-tab-close"
              onClick={() => setIsFileOpen(false)}
              title="Close Main.java"
              type="button"
            >
              ×
            </button>
          </div>
        )}
        <span className="file-tabs-spacer" />
        <span className="save-indicator"><span /> Java</span>
      </nav>

      <div className="workbench-body">
        <aside aria-label="Project files" className="file-explorer">
          <div className="panel-heading">
            <span>EXPLORER</span>
            <span aria-hidden="true" className="explorer-more">···</span>
          </div>
          <section aria-label="Open editors" className="explorer-section">
            <button
              aria-expanded={isOpenEditorsExpanded}
              className="explorer-section-heading"
              onClick={() => setIsOpenEditorsExpanded((expanded) => !expanded)}
              type="button"
            >
              <span aria-hidden="true" className={`tree-chevron${isOpenEditorsExpanded ? ' is-expanded' : ''}`} />
              <span>OPEN EDITORS</span>
              <span className="explorer-count">{isFileOpen ? '1' : '0'}</span>
            </button>
            {isOpenEditorsExpanded && isFileOpen && (
              <button
                className="explorer-file open-editor-file"
                onClick={() => setIsFileOpen(true)}
                type="button"
              >
                <span aria-hidden="true" className="file-icon file-icon-java">J</span>
                <span className="explorer-file-name">{file.name}</span>
                <span className="explorer-file-location">java-project</span>
              </button>
            )}
          </section>
          <section aria-label="Workspace folder" className="explorer-section workspace-tree">
            <button
              aria-expanded={isProjectExpanded}
              className="project-root"
              onClick={() => setIsProjectExpanded((expanded) => !expanded)}
              type="button"
            >
              <span aria-hidden="true" className={`tree-chevron${isProjectExpanded ? ' is-expanded' : ''}`} />
              <span aria-hidden="true" className="folder-icon">▰</span>
              <span>java-project</span>
            </button>
            {isProjectExpanded && (
              <button
                aria-current={isFileOpen ? 'page' : undefined}
                className={`explorer-file${isFileOpen ? ' is-selected' : ''}`}
                onClick={() => setIsFileOpen(true)}
                type="button"
              >
                <span aria-hidden="true" className="file-icon file-icon-java">J</span>
                <span className="explorer-file-name">{file.name}</span>
              </button>
            )}
          </section>
          <div className="explorer-hint">
            Java source is compiled and run by the local backend. Program output appears below.
          </div>
        </aside>

        <section aria-label="Java workspace" className="editor-stage">
          <section aria-label="Java code editor" className="code-panel">
            <div className="panel-heading code-panel-heading">
              <span>{isFileOpen ? file.name : 'No file open'}</span>
              {isFileOpen && <span className="language-label">Java</span>}
            </div>
            {isFileOpen ? (
              <div className="code-editor-wrap">
                <CodeMirror
                  aria-label="Edit Main.java"
                  basicSetup={{
                    foldGutter: true,
                    highlightActiveLine: true,
                    lineNumbers: true,
                  }}
                  className="java-code-editor"
                  extensions={[java()]}
                  height="100%"
                  onChange={setSource}
                  theme={oneDark}
                  value={source}
                />
              </div>
            ) : (
              <div className="closed-editor-state">
                <span className="file-icon file-icon-java">J</span>
                <p>Main.java is closed.</p>
                <button className="open-file-button" onClick={() => setIsFileOpen(true)} type="button">
                  Reopen Main.java
                </button>
              </div>
            )}
            <div className="editor-statusbar">
              <span>Java</span>
              <span>UTF-8</span>
              <span>{source.split('\n').length} lines</span>
            </div>
          </section>

          <section aria-label="Program input" className="program-input-panel">
            <label htmlFor="program-input">PROGRAM INPUT <span>(optional)</span></label>
            <textarea
              id="program-input"
              onChange={(event) => setProgramInput(event.target.value)}
              placeholder="Text read by Scanner or System.in"
              value={programInput}
            />
          </section>

          <section aria-label="Program output" className="output-panel">
            <div className="panel-heading output-heading">
              <span><span className={`output-status output-status-${outputKind}`} /> OUTPUT</span>
              <div className="output-actions">
                {isRunning && <span className="running-label">Compiling and running…</span>}
                <button
                  className="clear-console"
                  disabled={isRunning || !output}
                  onClick={() => {
                    setOutput('');
                    setOutputKind('empty');
                  }}
                  type="button"
                >
                  Clear
                </button>
              </div>
            </div>
            <pre aria-live="polite" className={`program-output output-${outputKind}`}>
              {isRunning ? 'Compiling Main.java…' : output || 'Run your Java program to see output here.'}
            </pre>
          </section>
          {requestError && <p className="workbench-error" role="alert">{requestError}</p>}
        </section>
      </div>

      <footer className="workbench-statusbar">
        <span><span className="statusbar-check">✓</span> Ready</span>
        <span>{isFileOpen ? file.name : 'No file open'}</span>
        <span>Java</span>
        <span>DevLoop Editor</span>
      </footer>
    </main>
  );
}

export default CodeEditor;
