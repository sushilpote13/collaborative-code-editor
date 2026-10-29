import { useEffect, useRef } from 'react';

function QuickOpen({ files, onClose, onSelect, query, setQuery }) {
  const inputRef = useRef(null);
  const matches = files.filter((file) =>
    file.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      onClose();
    } else if (event.key === 'Enter' && matches[0]) {
      onSelect(matches[0].name);
    }
  }

  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <section
        aria-label="Quick open file"
        aria-modal="true"
        className="quick-open-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <label className="visually-hidden" htmlFor="quick-open-input">Search files</label>
        <input
          id="quick-open-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a file name to open…"
          ref={inputRef}
          value={query}
        />
        <div className="quick-open-results">
          {matches.length > 0 ? matches.map((file) => (
            <button key={file.name} onClick={() => onSelect(file.name)} type="button">
              <span className="file-icon file-icon-java">J</span>
              <span>{file.name}</span>
            </button>
          )) : (
            <p>No matching files</p>
          )}
        </div>
        <footer><kbd>Enter</kbd> open <kbd>Esc</kbd> close</footer>
      </section>
    </div>
  );
}

export default QuickOpen;
