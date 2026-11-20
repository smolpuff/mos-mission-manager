import { useEffect, useRef } from "react";
import useDesktopBridge from "../useDesktopBridge";

export default function WindowChrome({ title, styling }) {
  const bridge = useDesktopBridge();
  const isWindows = bridge?.platform === "win32";
  const useNativeDrag = bridge?.platform === "linux";
  const dragStateRef = useRef({
    active: false,
    ready: false,
    requestId: 0,
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
    if ((moveEvent.buttons & 1) === 0) {
      onUp();
      return;
    }
    if (!state.ready) return;
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
    if (useNativeDrag) return;
    if (event.button !== 0) return;
    const interactive = event.target?.closest?.("button, input, textarea, select, a");
    if (interactive) return;
    if (!bridge?.getWindowPosition || !bridge?.setWindowPosition) return;
    event.preventDefault();
    const state = dragStateRef.current;
    onUp();
    const requestId = ++state.requestId;
    state.active = true;
    state.ready = false;
    state.pointerStartX = event.screenX;
    state.pointerStartY = event.screenY;
    // Observe releases before the asynchronous position lookup can complete.
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("blur", onUp, true);
    try {
      const [startX, startY] = await bridge.getWindowPosition();
      if (!state.active || state.requestId !== requestId) return;
      state.windowStartX = Number(startX) || 0;
      state.windowStartY = Number(startY) || 0;
      state.nextX = state.windowStartX;
      state.nextY = state.windowStartY;
      state.ready = true;
    } catch {
      if (state.requestId === requestId) onUp();
    }
  };

  return (
    <header
      className={`window-chrome ${isWindows ? "window-chrome--windows" : ""} ${useNativeDrag ? "window-chrome--native-drag" : ""} ${styling || ""}`}
      onMouseDown={onHeaderMouseDown}
    >
      {!isWindows ? (
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
      ) : (
        <div className="window-actions-spacer" />
      )}
      <div className="window-drag">
        <div className="window-title-wrap">
          <h1 className="chrome-title">{title}</h1>
        </div>
      </div>
      {isWindows ? (
        <div className="window-actions window-actions--windows">
          <button
            className="window-button window-button-min window-button--windows"
            type="button"
            aria-label="Minimize window"
            onClick={() => bridge.minimizeWindow()}
          >
            <span />
          </button>
          <button
            className="window-button window-button-close window-button--windows"
            type="button"
            aria-label="Close window"
            onClick={() => bridge.closeWindow()}
          >
            <span />
          </button>
        </div>
      ) : (
        <div className="window-actions-spacer" />
      )}
    </header>
  );
}
