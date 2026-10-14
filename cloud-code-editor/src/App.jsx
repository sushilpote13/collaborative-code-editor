import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/home.jsx';
import EditorPage from './pages/editorPage.jsx';
import RequireAuth from './components/auth/RequireAuth.jsx';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/editor/:roomId"
          element={
            <RequireAuth>
              {(user) => <EditorPage user={user} />}
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
