import { lazy, Suspense } from 'react';

const CodeEditor = lazy(() => import('../components/editor/CodeEditor.jsx'));

function EditorPage({ user }) {
  return (
    <Suspense fallback={<main className="editor-loading">Loading Java editor…</main>}>
      <CodeEditor user={user} />
    </Suspense>
  );
}

export default EditorPage;
