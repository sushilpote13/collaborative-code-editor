import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/home.jsx';
import EditorPage from './pages/editorPage.jsx';
// import './App.css'

function App() {
  return (
    <>
      <BrowserRouter>
        <Routes>
          {/* Mistake: lowercase <home /> is treated as an HTML tag, not the imported React component. */}
          <Route path="/" element={<Home />} />
          {/* Visit /editor/test to check that the editor route and its roomId parameter work. */}
          <Route path="/editor/:roomId" element={<EditorPage />} />
        </Routes>
      </BrowserRouter>
    </>
  );
}

export default App
