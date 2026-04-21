import React, { useEffect, useRef } from "react";
import useDesktopBridge from "../useDesktopBridge";

export default function WindowChrome({ title, subtitle, styling }) {
  const bridge = useDesktopBridge();
  const dragStateRef = useRef({
    active: false,
    pointerStartX: 0,
    pointerStartY: 0,
    windowStartX: 0,
    windowStartY: 0,
    nextX: 0,
    nextY: 0,
    rafId: 0,
  });

  useEffect(() => {
    return () => {
      const state = dragStateRef.current;
      state.active = false;
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = 0;
      }
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onUp, true);
    };
  }, []);

  const flushMove = () => {
    const state = dragStateRef.current;
    state.rafId = 0;
    if (!state.active) return;
    void bridge?.setWindowPosition?.(state.nextX, state.nextY);
  };

  const onMove = (moveEvent) => {
    const state = dragStateRef.current;
    if (!state.active) return;
    const dx = moveEvent.screenX - state.pointerStartX;
    const dy = moveEvent.screenY - state.pointerStartY;
    state.nextX = Math.round(state.windowStartX + dx);
    state.nextY = Math.round(state.windowStartY + dy);
    if (!state.rafId) {
      state.rafId = requestAnimationFrame(flushMove);
    }
  };

  const onUp = () => {
    const state = dragStateRef.current;
    if (!state.active) return;
    state.active = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("blur", onUp, true);
  };

  const onHeaderMouseDown = async (event) => {
    if (event.button !== 0) return;
    const interactive = event.target?.closest?.("button, input, textarea, select, a");
    if (interactive) return;
    if (!bridge?.getWindowPosition || !bridge?.setWindowPosition) return;
    event.preventDefault();
    try {
      const [startX, startY] = await bridge.getWindowPosition();
      const state = dragStateRef.current;
      state.active = true;
      state.pointerStartX = event.screenX;
      state.pointerStartY = event.screenY;
      state.windowStartX = Number(startX) || 0;
      state.windowStartY = Number(startY) || 0;
      state.nextX = state.windowStartX;
      state.nextY = state.windowStartY;
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      window.addEventListener("blur", onUp, true);
    } catch {
      onUp();
    }
  };

  return (
    <header className={`window-chrome ${styling}`} onMouseDown={onHeaderMouseDown}>
      <div className="window-actions">
        <button
          className="window-button window-button-close"
          type="button"
          aria-label="Close window"
          onClick={() => bridge.closeWindow()}
        >
          <span />
        </button>
        <button
          className="window-button window-button-min"
          type="button"
          aria-label="Minimize window"
          onClick={() => bridge.minimizeWindow()}
        >
          <span />
        </button>
      </div>
      <div className="window-drag">
        <div className="window-title-wrap">
          <h1 className="chrome-title">{title}</h1>
        </div>
      </div>
      <div className="window-actions-spacer" />
    </header>
  );
}
