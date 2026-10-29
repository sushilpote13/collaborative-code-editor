import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { closeBrackets } from '@codemirror/autocomplete';
import { java } from '@codemirror/lang-java';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, ySyncAnnotation } from 'y-codemirror.next';
import * as Y from 'yjs';
import { createInitialCode, initialCode } from '../../../shared/initialWorkspace.js';
import { useCollaborativeRoom } from '../../hooks/useCollaborativeRoom.js';
import EditorToolbarButton from './EditorToolbarButton.jsx';
import PanelSplitter from './PanelSplitter.jsx';
import QuickOpen from './QuickOpen.jsx';
import { apiFetch, signOutFromCognito } from '../../lib/cognito.js';
import './codeEditor.css';

const initialFiles = [{ name: 'Main.java', source: initialCode }];

const apiUnavailableMessage =
  'The API is unavailable. Run "npm run dev" and make sure MongoDB is running.';

function workspaceStorageKey(userId, roomId) {
  return `devloop-workspace:${userId}:${roomId}`;
}

function readSharedFiles(document, fallbackFiles) {
  if (!document) {
    return fallbackFiles;
  }
  return [...document.getMap('files').entries()]
    .filter((entry) => entry[1] instanceof Y.Text)
    .map(([name, text]) => ({ name, source: text.toString() }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function readLegacyWorkspace(userId, roomId) {
  try {
    const saved = localStorage.getItem(workspaceStorageKey(userId, roomId));
    if (!saved) {
      return null;
    }

    const workspace = JSON.parse(saved);
    const names = new Set();
    const validFiles = Array.isArray(workspace.files) && workspace.files.length > 0
      && workspace.files.length <= 20
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
        if (new TextEncoder().encode(file.source).byteLength > 32 * 1024) {
          return false;
        }
        names.add(file.name.toLowerCase());
        return true;
      });

    const totalBytes = validFiles
      ? workspace.files.reduce((total, file) => total + new TextEncoder().encode(file.source).byteLength, 0)
      : Infinity;
    if (
      !validFiles ||
      totalBytes > 128 * 1024 ||
      !workspace.files.some((file) => file.name === 'Main.java')
    ) {
      throw new Error('The saved browser workspace is invalid or exceeds project limits.');
    }

    return workspace.files;
  } catch (error) {
    console.error('Could not migrate the saved browser workspace:', error);
    throw error;
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
  const [workspace, setWorkspace] = useState({
    files: initialFiles,
    openFiles: ['Main.java'],
    activeFileName: 'Main.java',
  });
  const collaboration = useCollaborativeRoom(roomId, user);
  const { files, openFiles, activeFileName } = workspace;
  const [fileAction, setFileAction] = useState(null);
  const [fileNameDraft, setFileNameDraft] = useState('');
  const [fileActionError, setFileActionError] = useState('');
  const [isProjectExpanded, setIsProjectExpanded] = useState(true);
  const [isOpenEditorsExpanded, setIsOpenEditorsExpanded] = useState(true);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isMembersOpen, setIsMembersOpen] = useState(() => window.innerWidth > 700);
  const [isExplorerOpen, setIsExplorerOpen] = useState(() => window.innerWidth > 700);
  const [isConsoleOpen, setIsConsoleOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(242);
  const [membersWidth, setMembersWidth] = useState(264);
  const [outputHeight, setOutputHeight] = useState(190);
  const [isDarkTheme, setIsDarkTheme] = useState(true);
  const [editorZoom, setEditorZoom] = useState(13);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickOpenQuery, setQuickOpenQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTarget, setSearchTarget] = useState(null);
  const [dirtyFiles, setDirtyFiles] = useState(() => new Set());
  const [toast, setToast] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isCloudFileActionPending, setIsCloudFileActionPending] = useState(false);
  const [programInput, setProgramInput] = useState('');
  const [output, setOutput] = useState('');
  const [outputKind, setOutputKind] = useState('empty');
  const [requestError, setRequestError] = useState('');
  const editorRef = useRef(null);
  const appliedSearchTarget = useRef(null);
  const toastTimer = useRef(null);
  const cursorTimer = useRef(null);
  const workspaceSyncTimer = useRef(null);
  const workspaceRef = useRef(workspace);
  const migratedLegacyWorkspace = useRef(null);

  const activeFile = files.find((file) => file.name === activeFileName);
  const isFileOpen = Boolean(activeFile && openFiles.includes(activeFileName));
  const members = collaboration.members;
  const presenceError = collaboration.error;
  const sharedFiles = collaboration.document?.getMap('files');
  const activeSharedText = activeFile && sharedFiles?.get(activeFile.name);
  const editorExtensions = useMemo(() => {
    if (!(activeSharedText instanceof Y.Text) || !collaboration.awareness) {
      return [java(), closeBrackets(), indentOnInput(), bracketMatching()];
    }
    return [
      java(),
      closeBrackets(),
      indentOnInput(),
      bracketMatching(),
      yCollab(activeSharedText, collaboration.awareness),
    ];
  }, [activeSharedText, collaboration.awareness]);
  const lightEditorTheme = useMemo(() => EditorView.theme({
    '&': { color: '#282536', backgroundColor: '#fbfaff' },
    '.cm-content': { caretColor: '#6d28d9' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#6d28d9' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#ddd0f8',
    },
    '.cm-gutters': { color: '#858092', backgroundColor: '#f1eff6', borderRight: '1px solid #e0dce9' },
    '.cm-activeLine': { backgroundColor: '#f3effb' },
    '.cm-activeLineGutter': { color: '#4b4658', backgroundColor: '#ebe5f6' },
  }, { dark: false }), []);
  const searchResults = useMemo(() => {
    const term = searchQuery.trim().toLowerCase();
    if (!term) {
      return [];
    }
    return files.flatMap((file) => file.source.split('\n').flatMap((line, index) => {
      const column = line.toLowerCase().indexOf(term);
      return column < 0
        ? []
        : [{ fileName: file.name, line: index + 1, column, text: line.trim() }];
    }));
  }, [files, searchQuery]);

  const showToast = useCallback((message) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 2400);
  }, []);

  const saveWorkspaceToS3 = useCallback(async () => {
    if (collaboration.status !== 'connected' || !collaboration.document) {
      setRequestError('Wait for the room to connect before saving the project to S3.');
      return;
    }
    setIsCloudFileActionPending(true);
    setRequestError('');
    try {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(roomId)}/files`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: readSharedFiles(collaboration.document, workspaceRef.current.files),
          }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `The server returned ${response.status}.`);
      }
      setDirtyFiles(new Set());
      showToast(`Workspace saved to S3. ${result.files.length} Java files are available across devices.`);
    } catch (error) {
      setRequestError(`Could not save the workspace to S3: ${error.message}`);
    } finally {
      setIsCloudFileActionPending(false);
    }
  }, [collaboration.document, collaboration.status, roomId, showToast]);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const resizeExplorer = useCallback((delta) => {
    setExplorerWidth((width) => Math.max(180, Math.min(420, width + delta)));
  }, []);
  const resizeMembers = useCallback((delta) => {
    setMembersWidth((width) => Math.max(210, Math.min(420, width - delta)));
  }, []);
  const resizeOutput = useCallback((delta) => {
    setOutputHeight((height) => Math.max(110, Math.min(460, height - delta)));
  }, []);

  useEffect(() => {
    if (collaboration.status !== 'connected' || !collaboration.document) {
      return undefined;
    }

    const document = collaboration.document;
    const roomFiles = document.getMap('files');
    const synchronizeWorkspace = () => {
      window.clearTimeout(workspaceSyncTimer.current);
      if (roomFiles.size === 0) {
        document.transact(() => {
          for (const file of workspaceRef.current.files) {
            const text = new Y.Text();
            text.insert(0, file.source);
            roomFiles.set(file.name, text);
          }
        });
        return;
      }

      const nextFiles = [...roomFiles.entries()]
        .filter((entry) => entry[1] instanceof Y.Text)
        .map(([name, text]) => ({ name, source: text.toString() }))
        .sort((first, second) => first.name.localeCompare(second.name));
      if (nextFiles.length === 0) {
        return;
      }

      setWorkspace((current) => {
        const availableNames = new Set(nextFiles.map((file) => file.name));
        const nextOpenFiles = current.openFiles.filter((name) => availableNames.has(name));
        if (nextOpenFiles.length === 0) {
          nextOpenFiles.push('Main.java');
        }
        const nextActiveFileName = availableNames.has(current.activeFileName) &&
          nextOpenFiles.includes(current.activeFileName)
          ? current.activeFileName
          : nextOpenFiles[0];
        const filesUnchanged = current.files.length === nextFiles.length &&
          current.files.every((file, index) =>
            file.name === nextFiles[index].name && file.source === nextFiles[index].source,
          );
        const openFilesUnchanged = current.openFiles.length === nextOpenFiles.length &&
          current.openFiles.every((name, index) => name === nextOpenFiles[index]);
        if (
          filesUnchanged &&
          openFilesUnchanged &&
          current.activeFileName === nextActiveFileName
        ) {
          return current;
        }

        return {
          files: nextFiles,
          openFiles: nextOpenFiles,
          activeFileName: nextActiveFileName,
        };
      });
    };

    const scheduleWorkspaceSync = () => {
      window.clearTimeout(workspaceSyncTimer.current);
      workspaceSyncTimer.current = window.setTimeout(synchronizeWorkspace, 180);
    };

    document.on('update', scheduleWorkspaceSync);
    roomFiles.observe(synchronizeWorkspace);
    synchronizeWorkspace();
    return () => {
      document.off('update', scheduleWorkspaceSync);
      roomFiles.unobserve(synchronizeWorkspace);
      window.clearTimeout(workspaceSyncTimer.current);
    };
  }, [collaboration.document, collaboration.status]);

  useEffect(() => {
    function handleShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        void saveWorkspaceToS3();
      } else if (key === 'p' && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen(true);
        setQuickOpenQuery('');
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        setSearchOpen(true);
        setIsExplorerOpen(true);
      }
    }

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [saveWorkspaceToS3]);

  useEffect(() => {
    if (collaboration.status !== 'connected' || !collaboration.document) {
      return;
    }

    const migrationKey = `${user.id}:${roomId}`;
    if (migratedLegacyWorkspace.current === migrationKey) {
      return;
    }
    migratedLegacyWorkspace.current = migrationKey;

    async function migrateLegacyWorkspace() {
      const storageKey = workspaceStorageKey(user.id, roomId);
      let legacyFiles;
      try {
        legacyFiles = readLegacyWorkspace(user.id, roomId);
      } catch (error) {
        setRequestError(`Could not migrate this browser's saved workspace: ${error.message}`);
        return;
      }
      if (!legacyFiles) {
        return;
      }

      const baseUrl = `/api/projects/${encodeURIComponent(roomId)}/files`;
      let replaceConflicts = null;
      let hasConflicts = false;
      try {
        const listResponse = await apiFetch(baseUrl);
        const listResult = await listResponse.json();
        if (!listResponse.ok) {
          throw new Error(listResult.error || `The server returned ${listResponse.status}.`);
        }
        const cloudNames = new Set(listResult.files.map((file) => file.name));

        for (const file of legacyFiles) {
          const fileUrl = `${baseUrl}/${encodeURIComponent(file.name)}`;
          let cloudSource = null;
          if (cloudNames.has(file.name)) {
            const loadResponse = await apiFetch(fileUrl);
            const loadedFile = await loadResponse.json();
            if (!loadResponse.ok) {
              throw new Error(loadedFile.error || `The server returned ${loadResponse.status}.`);
            }
            cloudSource = loadedFile.source;
          }

          if (cloudSource !== null && cloudSource !== file.source) {
            if (replaceConflicts === null) {
              replaceConflicts = window.confirm(
                'This browser has saved Java files that differ from S3. Replace the matching S3 files with this browser backup? The backup will be kept unless every file is verified.',
              );
            }
            if (!replaceConflicts) {
              hasConflicts = true;
              continue;
            }
          }
          if (cloudSource !== file.source) {
            const saveResponse = await apiFetch(fileUrl, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: file.source }),
            });
            const saveResult = await saveResponse.json();
            if (!saveResponse.ok) {
              throw new Error(saveResult.error || `The server returned ${saveResponse.status}.`);
            }
            const verifyResponse = await apiFetch(fileUrl);
            const verifiedFile = await verifyResponse.json();
            if (!verifyResponse.ok || verifiedFile.source !== file.source) {
              throw new Error(`S3 verification failed for ${file.name}.`);
            }
          }

          const roomFiles = collaboration.document.getMap('files');
          const sharedText = roomFiles.get(file.name);
          if (sharedText instanceof Y.Text) {
            if (sharedText.toString() !== file.source) {
              sharedText.delete(0, sharedText.length);
              if (file.source) {
                sharedText.insert(0, file.source);
              }
            }
          } else {
            const text = new Y.Text();
            text.insert(0, file.source);
            roomFiles.set(file.name, text);
          }
        }

        if (hasConflicts) {
          setRequestError('Some browser backup files differ from S3 and were not migrated. The backup remains on this device.');
          return;
        }
        localStorage.removeItem(storageKey);
        showToast('The previous browser workspace was verified in S3 and removed from this device.');
      } catch (error) {
        setRequestError(`Could not migrate the browser workspace to S3: ${error.message}`);
      }
    }

    void migrateLegacyWorkspace();
  }, [collaboration.document, collaboration.status, roomId, showToast, user.id]);

  useEffect(() => () => {
    window.clearTimeout(toastTimer.current);
    window.clearTimeout(cursorTimer.current);
    window.clearTimeout(workspaceSyncTimer.current);
  }, []);

  useEffect(() => {
    if (
      !searchTarget ||
      searchTarget.fileName !== activeFileName ||
      appliedSearchTarget.current === searchTarget
    ) {
      return;
    }
    const view = editorRef.current?.view;
    if (!view) {
      return;
    }
    const targetFile = files.find((file) => file.name === searchTarget.fileName);
    if (!targetFile) {
      return;
    }
    const position = targetFile.source.split('\n')
      .slice(0, searchTarget.line - 1)
      .reduce((length, line) => length + line.length + 1, 0) + searchTarget.column;
    view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
    view.focus();
    appliedSearchTarget.current = searchTarget;
  }, [activeFileName, files, searchTarget]);

  function openFile(name) {
    setWorkspace((current) => ({
      ...current,
      openFiles: current.openFiles.includes(name) ? current.openFiles : [...current.openFiles, name],
      activeFileName: name,
    }));
  }

  async function refreshWorkspace() {
    if (!collaboration.document) {
      return;
    }
    const nextFiles = [...collaboration.document.getMap('files').entries()]
      .filter((entry) => entry[1] instanceof Y.Text)
      .map(([name, text]) => ({ name, source: text.toString() }))
      .sort((first, second) => first.name.localeCompare(second.name));
    if (nextFiles.length === 0) {
      setRequestError('The shared workspace does not contain any Java files.');
      return;
    }
    setWorkspace((current) => {
      const availableNames = new Set(nextFiles.map((file) => file.name));
      const nextOpenFiles = current.openFiles.filter((name) => availableNames.has(name));
      const nextActiveFileName = availableNames.has(current.activeFileName)
        ? current.activeFileName
        : nextOpenFiles[nextOpenFiles.length - 1] || 'Main.java';
      return { files: nextFiles, openFiles: nextOpenFiles, activeFileName: nextActiveFileName };
    });
    try {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(roomId)}/files`,
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `The server returned ${response.status}.`);
      }
      showToast(`File list refreshed. ${result.files.length} project files are saved in S3.`);
    } catch (error) {
      setRequestError(`Could not refresh the S3 file list: ${error.message}`);
    }
  }

  function handleEditorChange(_source, viewUpdate) {
    const isRemoteChange = viewUpdate.transactions.some(
      (transaction) => transaction.annotation(ySyncAnnotation) !== undefined,
    );
    if (isRemoteChange || !activeFileName) {
      return;
    }
    setDirtyFiles((current) => {
      if (current.has(activeFileName)) {
        return current;
      }
      return new Set(current).add(activeFileName);
    });
  }

  function handleEditorUpdate(viewUpdate) {
    if (!viewUpdate.selectionSet) {
      return;
    }
    const position = viewUpdate.state.selection.main.head;
    const line = viewUpdate.state.doc.lineAt(position);
    const nextPosition = { line: line.number, column: position - line.from + 1 };
    window.clearTimeout(cursorTimer.current);
    cursorTimer.current = window.setTimeout(() => {
      setCursorPosition((current) =>
        current.line === nextPosition.line && current.column === nextPosition.column
          ? current
          : nextPosition,
      );
    }, 100);
  }

  function selectSearchResult(result) {
    openFile(result.fileName);
    setSearchTarget(result);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      setRequestError(`Could not change fullscreen mode: ${error.message}`);
    }
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
    if (collaboration.status !== 'connected' || !collaboration.document) {
      setFileActionError('Wait for the room to connect before changing files.');
      return;
    }
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
        source: createInitialCode(className),
      };
      const sharedText = new Y.Text();
      sharedText.insert(0, newFile.source);
      collaboration.document.getMap('files').set(name, sharedText);
      setWorkspace((current) => ({
        ...current,
        openFiles: current.openFiles.includes(name)
          ? current.openFiles
          : [...current.openFiles, name],
        activeFileName: name,
      }));
    } else {
      const oldName = fileAction.currentName;
      const oldText = collaboration.document.getMap('files').get(oldName);
      const renamedText = new Y.Text();
      renamedText.insert(0, oldText.toString());
      collaboration.document.transact(() => {
        collaboration.document.getMap('files').delete(oldName);
        collaboration.document.getMap('files').set(name, renamedText);
      });
      setWorkspace((current) => ({
        ...current,
        openFiles: current.openFiles.map((openName) => openName === oldName ? name : openName),
        activeFileName: current.activeFileName === oldName ? name : current.activeFileName,
      }));
      setDirtyFiles((current) => {
        if (!current.has(oldName)) {
          return current;
        }
        const next = new Set(current);
        next.delete(oldName);
        next.add(name);
        return next;
      });
    }

    setFileAction(null);
    setFileNameDraft('');
    setFileActionError('');
  }

  function deleteFile(name) {
    if (name === 'Main.java') {
      return;
    }
    if (collaboration.status !== 'connected' || !collaboration.document) {
      setFileActionError('Wait for the room to connect before changing files.');
      return;
    }
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) {
      return;
    }

    void (async () => {
      try {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(roomId)}/files/${encodeURIComponent(name)}`,
          { method: 'DELETE' },
        );
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error || `The server returned ${response.status}.`);
        }
        setWorkspace((current) => {
          const nextOpenFiles = current.openFiles.filter((openName) => openName !== name);
          return {
            ...current,
            openFiles: nextOpenFiles,
            activeFileName: current.activeFileName === name
              ? nextOpenFiles[nextOpenFiles.length - 1] || 'Main.java'
              : current.activeFileName,
          };
        });
        setDirtyFiles((current) => {
          if (!current.has(name)) {
            return current;
          }
          const next = new Set(current);
          next.delete(name);
          return next;
        });
        collaboration.document.getMap('files').delete(name);
      } catch (error) {
        setRequestError(`Could not delete ${name}: ${error.message}`);
      }
    })();
  }

  async function loadActiveFileFromS3() {
    if (!activeFile || !(activeSharedText instanceof Y.Text)) {
      return;
    }

    setIsCloudFileActionPending(true);
    setRequestError('');
    try {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(roomId)}/files/${encodeURIComponent(activeFile.name)}`,
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `The server returned ${response.status}.`);
      }
      if (typeof result.source !== 'string') {
        throw new Error('The saved project file response is invalid.');
      }
      if (!window.confirm(`Load ${activeFile.name} from S3 and replace its shared contents?`)) {
        return;
      }

      collaboration.document.transact(() => {
        activeSharedText.delete(0, activeSharedText.length);
        if (result.source.length > 0) {
          activeSharedText.insert(0, result.source);
        }
      });
      showToast(`${activeFile.name} loaded from S3 and synced to the room.`);
    } catch (error) {
      setRequestError(`Could not load ${activeFile.name} from S3: ${error.message}`);
    } finally {
      setIsCloudFileActionPending(false);
    }
  }

  async function runCode() {
    setIsRunning(true);
    setRequestError('');
    setOutput('');
    setOutputKind('empty');

    try {
      const response = await apiFetch('/api/java/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceFiles: readSharedFiles(collaboration.document, files),
          input: programInput,
        }),
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
      await signOutFromCognito();
      navigate('/', { replace: true });
    } catch (error) {
      setRequestError(`Could not log out: ${error.message}`);
    }
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch (error) {
      setRequestError(`Could not copy the invite link: ${error.message}`);
    }
  }

  const displayName = user.username ? `@${user.username}` : `${user.firstName} ${user.lastName}`;

  return (
    <main className={`workbench${isDarkTheme ? '' : ' theme-light'}`}>
      <header className="workbench-topbar">
        <a className="workbench-brand" href="/" aria-label="DevLoop home">
          <span className="brand-mark">D</span>
          <span>DevLoop</span>
        </a>
        <div className="layout-actions" aria-label="Workspace panels">
          <EditorToolbarButton
            active={isExplorerOpen}
            icon="explorer"
            label={`${isExplorerOpen ? 'Hide' : 'Show'} file explorer`}
            onClick={() => setIsExplorerOpen((open) => !open)}
          />
          <EditorToolbarButton
            active={searchOpen}
            icon="search"
            label="Search across files (Ctrl+Shift+F)"
            onClick={() => {
              setSearchOpen((open) => !open);
              setIsExplorerOpen(true);
            }}
          />
        </div>
        <div className="workspace-title">
          <span className="workspace-title-label">WORKSPACE</span>
          <strong>{roomId}</strong>
        </div>
        <span className={`room-connection-status is-${collaboration.status}`} role="status">
          {collaboration.status === 'connected' ? 'Live' : collaboration.status}
        </span>
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
          <EditorToolbarButton
            active={isConsoleOpen}
            icon="terminal"
            label={`${isConsoleOpen ? 'Hide' : 'Show'} output console`}
            onClick={() => setIsConsoleOpen((open) => !open)}
          />
          <EditorToolbarButton
            icon={isDarkTheme ? 'sun' : 'moon'}
            label={`Switch to ${isDarkTheme ? 'light' : 'dark'} theme`}
            onClick={() => setIsDarkTheme((dark) => !dark)}
          />
          <EditorToolbarButton
            icon="fullscreen"
            label="Toggle fullscreen"
            onClick={toggleFullscreen}
          />
          <button
            className="add-member-button"
            onClick={() => navigate('/meetings', { state: { returnRoomId: roomId } })}
            type="button"
          >
            <span aria-hidden="true">+</span>
            Add member
          </button>
          <button className="invite-link-button" onClick={copyInviteLink} type="button">
            {inviteCopied ? 'Link copied' : 'Copy invite link'}
          </button>
          <button
            className="run-button"
            disabled={isRunning || collaboration.status !== 'connected'}
            onClick={runCode}
            type="button"
          >
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
              {dirtyFiles.has(name) && (
                <span aria-label="Unsaved changes" className="file-tab-dirty" title="Unsaved changes" />
              )}
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
        <span className="save-indicator">
          <span />{collaboration.status === 'connected' ? 'Synced to room' : 'Connecting to room'}
        </span>
      </nav>

      <div
        className="workbench-body"
        style={{
          '--explorer-width': `${explorerWidth}px`,
          '--members-width': `${membersWidth}px`,
          '--output-height': `${outputHeight}px`,
          '--editor-font-size': `${editorZoom}px`,
        }}
      >
        {isExplorerOpen && (
          <>
        <aside aria-label="Project files" className="file-explorer">
          <div className="panel-heading">
            <span>EXPLORER</span>
            <div className="explorer-toolbar">
              <EditorToolbarButton
                disabled={collaboration.status !== 'connected'}
                icon="refresh"
                label="Refresh file list"
                onClick={refreshWorkspace}
              />
              <button
                aria-label="Create Java file"
                className="explorer-add-file"
                onClick={() => startFileAction('create')}
                title="Create Java file"
                disabled={collaboration.status !== 'connected'}
                type="button"
              >
                +
              </button>
            </div>
          </div>
          {searchOpen && (
            <section aria-label="Search across files" className="workspace-search">
              <label className="visually-hidden" htmlFor="workspace-search-input">Search in files</label>
              <input
                id="workspace-search-input"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search in files…"
                value={searchQuery}
              />
              <span className="search-result-count">{searchResults.length} results</span>
              <div className="workspace-search-results">
                {searchResults.map((result) => (
                  <button
                    key={`${result.fileName}:${result.line}:${result.column}`}
                    onClick={() => selectSearchResult(result)}
                    type="button"
                  >
                    <strong>{result.fileName}:{result.line}</strong>
                    <span>{result.text}</span>
                  </button>
                ))}
                {searchQuery && searchResults.length === 0 && <p>No matches found.</p>}
              </div>
            </section>
          )}
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
                          disabled={collaboration.status !== 'connected'}
                          type="button"
                        >
                          ✎
                        </button>
                        <button
                          aria-label={`Delete ${file.name}`}
                          onClick={() => deleteFile(file.name)}
                          title={`Delete ${file.name}`}
                          disabled={collaboration.status !== 'connected'}
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
            Ctrl+P opens files · Ctrl+Shift+F searches the workspace
          </div>
        </aside>
        <PanelSplitter label="file explorer width" onResize={resizeExplorer} orientation="vertical" />
          </>
        )}

        <section aria-label="Java workspace" className="editor-stage">
          <section aria-label="Java code editor" className="code-panel">
            <div className="panel-heading code-panel-heading">
              <div className="editor-file-heading">
                <span>{isFileOpen ? activeFile.name : 'No file open'}</span>
                {isFileOpen && <span className="language-label">Java</span>}
              </div>
              <div className="editor-tools" aria-label="Editor controls">
                <span className="editor-zoom-label">Zoom</span>
                <EditorToolbarButton
                  icon="minus"
                  label="Decrease editor text size"
                  onClick={() => setEditorZoom((zoom) => Math.max(10, zoom - 1))}
                />
                <span className="editor-zoom-value">{editorZoom}px</span>
                <EditorToolbarButton
                  icon="plus"
                  label="Increase editor text size"
                  onClick={() => setEditorZoom((zoom) => Math.min(22, zoom + 1))}
                />
                <EditorToolbarButton
                  icon="save"
                  label="Save workspace to S3 (Ctrl+S)"
                  disabled={collaboration.status !== 'connected' || isCloudFileActionPending}
                  onClick={saveWorkspaceToS3}
                />
                <EditorToolbarButton
                  disabled={!isFileOpen || collaboration.status !== 'connected' || isCloudFileActionPending}
                  icon="download"
                  label="Load active file from S3"
                  onClick={loadActiveFileFromS3}
                />
              </div>
            </div>
            {isFileOpen && collaboration.status === 'connected' && activeSharedText instanceof Y.Text ? (
              <div className="code-editor-wrap">
                <CodeMirror
                  aria-label={`Edit ${activeFile.name}`}
                  basicSetup={{
                    foldGutter: true,
                    highlightActiveLine: true,
                    lineNumbers: true,
                  }}
                  className="java-code-editor"
                  extensions={editorExtensions}
                  height="100%"
                  key={activeFile.name}
                  onChange={handleEditorChange}
                  onUpdate={handleEditorUpdate}
                  ref={editorRef}
                  theme={isDarkTheme ? oneDark : lightEditorTheme}
                  value={activeSharedText.toString()}
                />
              </div>
            ) : collaboration.status !== 'connected' ? (
              <div className="closed-editor-state">
                <p>{presenceError || 'Connecting to the shared workspace…'}</p>
                {collaboration.status === 'error' && (
                  <button className="open-file-button" onClick={() => navigate('/meetings')} type="button">
                    Choose another room
                  </button>
                )}
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
              <span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
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

          {isConsoleOpen && (
            <>
          <PanelSplitter label="output console height" onResize={resizeOutput} orientation="horizontal" />
          <section aria-label="Program output" className="output-panel">
            <div className="panel-heading output-heading">
              <span><span className={`output-status output-status-${outputKind}`} /> OUTPUT</span>
              <div className="output-actions">
                {isRunning && <span className="running-label">Compiling and running…</span>}
                <button
                  className="clear-console"
                  disabled={isRunning || !output}
                  onClick={runCode}
                  title="Run Java again"
                  type="button"
                >
                  Rerun
                </button>
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
            </>
          )}
          {requestError && <p className="workbench-error" role="alert">{requestError}</p>}
        </section>
        {isMembersOpen && (
          <>
          <PanelSplitter label="members panel width" onResize={resizeMembers} orientation="vertical" />
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
            {collaboration.activity && (
              <p aria-live="polite" className="members-activity">{collaboration.activity}</p>
            )}
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
            <p className="members-sync-note">Members and code sync live while they’re in this room.</p>
          </aside>
          </>
        )}
      </div>

      <footer className="workbench-statusbar">
        <span>
          <span className="statusbar-check">{collaboration.status === 'connected' ? '✓' : '◌'}</span>
          {collaboration.status === 'connected' ? 'Connected' : 'Connecting'}
        </span>
        <span>{isFileOpen ? activeFile.name : 'No file open'}</span>
        <span>Java</span>
        <span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
        <span className={collaboration.status === 'connected' ? 'statusbar-sync is-synced' : 'statusbar-sync'}>
          {collaboration.status === 'connected' ? 'Synced' : collaboration.status}
        </span>
        <span>DevLoop Editor</span>
      </footer>
      {quickOpen && (
        <QuickOpen
          files={files}
          onClose={() => setQuickOpen(false)}
          onSelect={(name) => {
            openFile(name);
            setQuickOpen(false);
          }}
          query={quickOpenQuery}
          setQuery={setQuickOpenQuery}
        />
      )}
      {toast && <div aria-live="polite" className="workspace-toast" role="status">{toast}</div>}
    </main>
  );
}

export default CodeEditor;
