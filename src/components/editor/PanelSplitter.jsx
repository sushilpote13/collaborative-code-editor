import { useRef } from 'react';

function PanelSplitter({ label, orientation, onResize }) {
  const dragState = useRef(null);
  const isVertical = orientation === 'vertical';

  function startResize(event) {
    event.preventDefault();
    dragState.current = {
      pointer: isVertical ? event.clientX : event.clientY,
      value: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event) {
    if (!dragState.current) {
      return;
    }
    const pointer = isVertical ? event.clientX : event.clientY;
    const nextValue = pointer - dragState.current.pointer;
    onResize(nextValue - dragState.current.value);
    dragState.current.value = nextValue;
  }

  function stopResize() {
    dragState.current = null;
  }

  function resizeFromKeyboard(event) {
    const negativeKey = isVertical ? 'ArrowLeft' : 'ArrowUp';
    const positiveKey = isVertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key === negativeKey || event.key === positiveKey) {
      event.preventDefault();
      onResize((event.key === negativeKey ? -1 : 1) * (event.shiftKey ? 32 : 12));
    }
  }

  return (
    <div
      aria-label={label}
      aria-orientation={orientation}
      className={`panel-splitter is-${orientation}`}
      onKeyDown={resizeFromKeyboard}
      onLostPointerCapture={stopResize}
      onPointerCancel={stopResize}
      onPointerDown={startResize}
      onPointerMove={resize}
      onPointerUp={stopResize}
      role="separator"
      tabIndex={0}
      title={`Drag to resize ${label}`}
    />
  );
}

export default PanelSplitter;
