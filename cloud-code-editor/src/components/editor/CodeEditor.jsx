import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { java } from '@codemirror/lang-java';
import { oneDark } from '@codemirror/theme-one-dark';
import './codeEditor.css';

const initialCode = `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, DevLoop!");
    }
}`;
const initialFiles = [{ name: 'Main.java', source: initialCode }];

const apiUnavailableMessage =
  'The authentication API is unavailable. Run "npm run dev:api" and make sure MongoDB is running.';

function workspaceStorageKey(userId, roomId) {
  return `devloop-workspace:${userId}:${roomId}`;
}

function loadWorkspace(userId, roomId) {
  try {
    const saved = localStorage.getItem(workspaceStorageKey(userId, roomId));
    if (!saved) {
      return { files: initialFiles, openFiles: ['Main.java'], activeFileName: 'Main.java' };
    }

    const workspace = JSON.parse(saved);
    const names = new Set();
    const validFiles = Array.isArray(workspace.files) && workspace.files.length > 0
      && workspace.files.every((file) => {
        if (
          !file ||
          typeof file.name !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/.test(file.name) ||
          typeof file.source !== 'string' ||
          names.has(file.name.toLowerCase())
        ) {
          return false;
        }
        names.add(file.name.toLowerCase());
        return true;
      });

    if (!validFiles || !workspace.files.some((file) => file.name === 'Main.java')) {
      return { files: initialFiles, openFiles: ['Main.java'], activeFileName: 'Main.java' };
    }

    const fileNames = new Set(workspace.files.map((file) => file.name));
    const openFiles = Array.isArray(workspace.openFiles)
      ? [...new Set(workspace.openFiles.filter((name) => fileNames.has(name)))]
      : ['Main.java'];
    const activeFileName = fileNames.has(workspace.activeFileName) &&
      openFiles.includes(workspace.activeFileName)
      ? workspace.activeFileName
      : openFiles[0] || null;
    return { files: workspace.files, openFiles, activeFileName };
  } catch (error) {
    console.error('Could not load the saved workspace:', error);
    return { files: initialFiles, openFiles: ['Main.java'], activeFileName: 'Main.java' };
  }
}

function getFileNameError(name, files, currentName = null) {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,59}\.java$/.test(name)) {
    return 'Use a Java filename such as Helper.java (letters, numbers, and underscores only).';
  }
  if (files.some((file) => file.name.toLowerCase() === name.toLowerCase() && file.name !== currentName)) {
    return 'A file with that name already exists.';
  }
  return '';
}

function CodeEditor({ user }) {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const [workspace, setWorkspace] = useState(() => loadWorkspace(user.id, roomId));
  const { files, openFiles, activeFileName } = workspace;
  const [fileAction, setFileAction] = useState(null);
  const [fileNameDraft, setFileNameDraft] = useState('');
  const [fileActionError, setFileActionError] = useState('');
  const [isProjectExpanded, setIsProjectExpanded] = useState(true);
  const [isOpenEditorsExpanded, setIsOpenEditorsExpanded] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isMembersOpen, setIsMembersOpen] = useState(true);
  const [members, setMembers] = useState([]);
  const [presenceError, setPresenceError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [programInput, setProgramInput] = useState('');
  const [output, setOutput] = useState('');
  const [outputKind, setOutputKind] = useState('empty');
  const [requestError, setRequestError] = useState('');

  const activeFile = files.find((file) => file.name === activeFileName);
  const isFileOpen = Boolean(activeFile && openFiles.includes(activeFileName));

  useEffect(() => {
    let isCurrent = true;
    const controller = new AbortController();

    async function refreshPresence() {
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/presence`, {
          method: 'PUT',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const result = await response.json();
        if (response.status === 401) {
          navigate('/', { replace: true, state: { notice: 'Please log in to stay in this meeting.' } });
          return;
        }
        if (!response.ok) {
          throw new Error(result.error || `The server returned ${response.status}.`);
        }
        if (isCurrent) {
          setMembers(result.members);
          setPresenceError('');
        }
      } catch (error) {
        if (isCurrent && error.name !== 'AbortError') {
          setPresenceError(`Could not update meeting members: ${error.message}`);
        }
      }
    }

    refreshPresence();
    const intervalId = window.setInterval(refreshPresence, 10_000);
    return () => {
      isCurrent = false;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [navigate, roomId]);

  useEffect(() => {
    try {
      localStorage.setItem(workspaceStorageKey(user.id, roomId), JSON.stringify(workspace));
    } catch (error) {
      console.error('Could not save the workspace locally:', error);
    }
  }, [roomId, user.id, workspace]);

  function openFile(name) {
    setWorkspace((current) => ({
      ...current,
      openFiles: current.openFiles.includes(name) ? current.openFiles : [...current.openFiles, name],
      activeFileName: name,
    }));
  }

  function closeFile(name) {
    setWorkspace((current) => {
      const nextOpenFiles = current.openFiles.filter((openName) => openName !== name);
      return {
        ...current,
        openFiles: nextOpenFiles,
        activeFileName: current.activeFileName === name
          ? nextOpenFiles[nextOpenFiles.length - 1] || null
          : current.activeFileName,
      };
    });
  }

  function startFileAction(action, name = '') {
    setFileAction({ type: action, currentName: name });
    setFileNameDraft(name);
    setFileActionError('');
  }

  function saveFileAction(event) {
    event.preventDefault();
    const name = fileNameDraft.trim();
    const error = getFileNameError(name, files, fileAction.currentName);
    if (error) {
      setFileActionError(error);
      return;
    }

    if (fileAction.type === 'create') {
      if (files.length >= 20) {
        setFileActionError('A workspace can contain up to 20 Java files.');
        return;
      }
      const className = name.slice(0, -'.java'.length);
      const newFile = {
        name,
        source: `public class ${className} {\n}\n`,
      };
      setWorkspace((current) => ({
        ...current,
        files: [...current.files, newFile],
        openFiles: [...current.openFiles, name],
        activeFileName: name,
      }));
    } else {
      const oldName = fileAction.currentName;
      setWorkspace((current) => ({
        ...current,
        files: current.files.map((file) => file.name === oldName ? { ...file, name } : file),
        openFiles: current.openFiles.map((openName) => openName === oldName ? name : openName),
        activeFileName: current.activeFileName === oldName ? name : current.activeFileName,
      }));
    }

    setFileAction(null);
    setFileNameDraft('');
    setFileActionError('');
  }

  function deleteFile(name) {
    if (name === 'Main.java') {
      return;
    }
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) {
      return;
    }

    setWorkspace((current) => {
      const nextOpenFiles = current.openFiles.filter((openName) => openName !== name);
      const nextFiles = current.files.filter((file) => file.name !== name);
      return {
        ...current,
        files: nextFiles,
        openFiles: nextOpenFiles,
        activeFileName: current.activeFileName === name
          ? nextOpenFiles[nextOpenFiles.length - 1] || 'Main.java'
          : current.activeFileName,
      };
    });
  }

  function updateSource(source) {
    setWorkspace((current) => ({
      ...current,
      files: current.files.map((file) =>
        file.name === current.activeFileName ? { ...file, source } : file,
      ),
    }));
  }

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
        body: JSON.stringify({ sourceFiles: files, input: programInput }),
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
          <button
            aria-expanded={isMembersOpen}
            className="members-toggle-button"
            onClick={() => setIsMembersOpen((open) => !open)}
            type="button"
          >
            <span aria-hidden="true" className="members-live-dot" />
            Members
            <span className="members-count">{members.length}</span>
          </button>
          <button
            className="add-member-button"
            onClick={() => navigate('/meetings', { state: { returnRoomId: roomId } })}
            type="button"
          >
            <span aria-hidden="true">+</span>
            Add member
          </button>
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
        {openFiles.map((name) => (
          <div
            className={`file-tab${name === activeFileName ? ' is-active' : ''}`}
            key={name}
          >
            <button
              aria-pressed={name === activeFileName}
              className="file-tab-select"
              onClick={() => openFile(name)}
              type="button"
            >
              <span aria-hidden="true" className="file-icon file-icon-java">J</span>
              <span className="file-tab-name">{name}</span>
            </button>
            <button
              aria-label={`Close ${name}`}
              className="file-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                closeFile(name);
              }}
              title={`Close ${name}`}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
        <span className="file-tabs-spacer" />
        <span className="save-indicator"><span /> Local workspace</span>
      </nav>

      <div className="workbench-body">
        <aside aria-label="Project files" className="file-explorer">
          <div className="panel-heading">
            <span>EXPLORER</span>
            <button
              aria-label="Create Java file"
              className="explorer-add-file"
              onClick={() => startFileAction('create')}
              title="Create Java file"
              type="button"
            >
              +
            </button>
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
              <span className="explorer-count">{openFiles.length}</span>
            </button>
            {isOpenEditorsExpanded && openFiles.map((name) => (
              <button
                className="explorer-file open-editor-file"
                key={name}
                onClick={() => openFile(name)}
                type="button"
              >
                <span aria-hidden="true" className="file-icon file-icon-java">J</span>
                <span className="explorer-file-name">{name}</span>
                <span className="explorer-file-location">java-project</span>
              </button>
            ))}
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
              <div className="project-file-list">
                {files.map((file) => (
                  <div className={`explorer-file-row${file.name === activeFileName ? ' is-selected' : ''}`} key={file.name}>
                    <button
                      aria-current={file.name === activeFileName ? 'page' : undefined}
                      className="explorer-file"
                      onClick={() => openFile(file.name)}
                      type="button"
                    >
                      <span aria-hidden="true" className="file-icon file-icon-java">J</span>
                      <span className="explorer-file-name">{file.name}</span>
                    </button>
                    {file.name !== 'Main.java' && (
                      <span className="file-row-actions">
                        <button
                          aria-label={`Rename ${file.name}`}
                          onClick={() => startFileAction('rename', file.name)}
                          title={`Rename ${file.name}`}
                          type="button"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`Delete ${file.name}`}
                          onClick={() => deleteFile(file.name)}
                          title={`Delete ${file.name}`}
                          type="button"
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                {fileAction && (
                  <form aria-label={fileAction.type === 'create' ? 'Create Java file' : 'Rename Java file'} className="file-action-form" onSubmit={saveFileAction}>
                    <input
                      aria-label="Java filename"
                      autoFocus
                      maxLength={65}
                      onChange={(event) => setFileNameDraft(event.target.value)}
                      placeholder="Helper.java"
                      required
                      value={fileNameDraft}
                    />
                    <button type="submit">{fileAction.type === 'create' ? 'Add' : 'Save'}</button>
                    <button onClick={() => setFileAction(null)} type="button">Cancel</button>
                    {fileActionError && <span className="file-action-error" role="alert">{fileActionError}</span>}
                  </form>
                )}
              </div>
            )}
          </section>
          <div className="explorer-hint">
            Files save in this browser. Main.java is the run entry point; keep its public class name in sync when renaming other files.
          </div>
        </aside>

        <section aria-label="Java workspace" className="editor-stage">
          <section aria-label="Java code editor" className="code-panel">
            <div className="panel-heading code-panel-heading">
              <span>{isFileOpen ? activeFile.name : 'No file open'}</span>
              {isFileOpen && <span className="language-label">Java</span>}
            </div>
            {isFileOpen ? (
              <div className="code-editor-wrap">
                <CodeMirror
                  aria-label={`Edit ${activeFile.name}`}
                  basicSetup={{
                    foldGutter: true,
                    highlightActiveLine: true,
                    lineNumbers: true,
                  }}
                  className="java-code-editor"
                  extensions={[java()]}
                  height="100%"
                  onChange={updateSource}
                  theme={oneDark}
                  value={activeFile.source}
                />
              </div>
            ) : (
              <div className="closed-editor-state">
                <p>No file is open.</p>
                {files.length > 0 && (
                  <button className="open-file-button" onClick={() => openFile('Main.java')} type="button">
                    Open Main.java
                  </button>
                )}
              </div>
            )}
            <div className="editor-statusbar">
              <span>Java</span>
              <span>UTF-8</span>
              <span>{activeFile ? activeFile.source.split('\n').length : 0} lines</span>
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
              {isRunning ? 'Compiling Java project…' : output || 'Run your Java program to see output here.'}
            </pre>
          </section>
          {requestError && <p className="workbench-error" role="alert">{requestError}</p>}
        </section>
        {isMembersOpen && (
          <aside aria-label="Meeting members" className="members-sidebar">
            <div className="members-sidebar-heading">
              <div>
                <span className="members-live-dot" />
                <h2>Members</h2>
                <span className="members-count">{members.length}</span>
              </div>
              <button
                aria-label="Close members sidebar"
                className="members-sidebar-close"
                onClick={() => setIsMembersOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <p className="members-room-label">IN THIS ROOM</p>
            {presenceError && <p className="members-error" role="alert">{presenceError}</p>}
            {members.length > 0 ? (
              <ul className="members-list">
                {members.map((member) => {
                  const name = member.username
                    ? `@${member.username}`
                    : `${member.firstName} ${member.lastName}`;
                  const isCurrentUser = member.id === user.id;
                  return (
                    <li className="member-item" key={member.id}>
                      <span className="member-avatar">
                        {(member.username || member.firstName || '?')[0].toUpperCase()}
                      </span>
                      <span className="member-details">
                        <span className="member-name">{name}{isCurrentUser ? ' (you)' : ''}</span>
                        <span className="member-status">Online</span>
                      </span>
                      <span aria-label="Online" className="member-online-dot" />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="members-empty">Connecting to this room…</p>
            )}
            <p className="members-sync-note">Members refresh automatically while they’re in this room.</p>
          </aside>
        )}
      </div>

      <footer className="workbench-statusbar">
        <span><span className="statusbar-check">✓</span> Ready</span>
        <span>{isFileOpen ? activeFile.name : 'No file open'}</span>
        <span>Java</span>
        <span>DevLoop Editor</span>
      </footer>
    </main>
  );
}

export default CodeEditor;
