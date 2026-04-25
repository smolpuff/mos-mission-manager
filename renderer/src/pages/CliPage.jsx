import { useEffect, useLayoutEffect, useRef, useState } from "react";
import WindowChrome from "../components/WindowChrome/app";
import useBackendState from "../components/useBackendState/app";

const debug = false;
const quickCommands = ["login", "logout", "check", "pause", "resume", "status", "r", "c"];

export default function CliPage() {
  const { bridge, status, logs } = useBackendState();
  const [command, setCommand] = useState("");
  const outputRef = useRef(null);
  const pinnedToBottomRef = useRef(true);
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
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    return () => {
      const state = dragStateRef.current;
      state.active = false;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      window.removeEventListener("mousemove", onTopBarDragMove, true);
      window.removeEventListener("mouseup", onTopBarDragEnd, true);
      window.removeEventListener("blur", onTopBarDragEnd, true);
    };
  }, []);

  const handleOutputScroll = () => {
    const node = outputRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - (node.scrollTop + node.clientHeight);
    pinnedToBottomRef.current = distanceFromBottom <= 32;
  };

  useLayoutEffect(() => {
    const node = outputRef.current;
    if (!node) return;
    const selection = window.getSelection ? window.getSelection() : null;
    const selectingTerminalText =
      Boolean(selection && !selection.isCollapsed) &&
      node.contains(selection.anchorNode);
    if (selectingTerminalText) return;
    if (pinnedToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logs]);

  async function submitCommand(nextCommand) {
    const value = String(nextCommand || command).trim();
    if (!value) return;
    await bridge.sendCommand(value);
    setCommand("");
  }

  const flushTopBarDrag = () => {
    const state = dragStateRef.current;
    state.rafId = 0;
    if (!state.active) return;
    void bridge?.setWindowPosition?.(state.nextX, state.nextY);
  };

  const onTopBarDragMove = (event) => {
    const state = dragStateRef.current;
    if (!state.active) return;
    const dx = event.screenX - state.pointerStartX;
    const dy = event.screenY - state.pointerStartY;
    state.nextX = Math.round(state.windowStartX + dx);
    state.nextY = Math.round(state.windowStartY + dy);
    if (!state.rafId) {
      state.rafId = requestAnimationFrame(flushTopBarDrag);
    }
  };

  const onTopBarDragEnd = () => {
    const state = dragStateRef.current;
    if (!state.active) return;
    state.active = false;
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
    window.removeEventListener("mousemove", onTopBarDragMove, true);
    window.removeEventListener("mouseup", onTopBarDragEnd, true);
    window.removeEventListener("blur", onTopBarDragEnd, true);
  };

  const onTopBarMouseDown = async (event) => {
    if (event.button !== 0) return;
    if (!bridge?.getWindowPosition || !bridge?.setWindowPosition) return;
    const interactive = event.target?.closest?.(
      "button,input,textarea,select,a,label",
    );
    if (interactive) return;
    const topBarHeight = 56;
    if (event.clientY > topBarHeight) return;
    event.preventDefault();
    try {
      const [windowX, windowY] = await bridge.getWindowPosition();
      const state = dragStateRef.current;
      state.active = true;
      state.pointerStartX = event.screenX;
      state.pointerStartY = event.screenY;
      state.windowStartX = Number(windowX) || 0;
      state.windowStartY = Number(windowY) || 0;
      state.nextX = state.windowStartX;
      state.nextY = state.windowStartY;
      window.addEventListener("mousemove", onTopBarDragMove, true);
      window.addEventListener("mouseup", onTopBarDragEnd, true);
      window.addEventListener("blur", onTopBarDragEnd, true);
    } catch {
      onTopBarDragEnd();
    }
  };

  return (
    <main
      className="cli-shell"
      onMouseDown={onTopBarMouseDown}
      style={{
        height: "100vh",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <WindowChrome title="CLI Bridge" subtitle="Manual Control" />
      <div className="cli-drag-strip z-10" aria-hidden="true" />

      <section className="flex-1" style={{ minHeight: 0, overflow: "hidden" }}>
        <div
          className="space-y-4"
          style={{
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            height: "100%",
          }}
        >
          <div
            className="terminal bg-black/75"
            ref={outputRef}
            onScroll={handleOutputScroll}
            style={{
              flex: 1,
              minHeight: "120px",
              overflowY: "auto",
            }}
          >
            {logs.length === 0 ? (
              <p className="text-gray-400">No backend output yet.</p>
            ) : (
              logs.map((entry, index) => (
                <pre
                  className={`log-line ${entry.stream}`}
                  key={`${entry.at}-${index}`}
                >
                  {entry.text}
                </pre>
              ))
            )}
          </div>
          <form
            className="command-form flex gap-4 bg-black/75 h-12 rounded-md"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCommand();
            }}
          >
            <input
              className="flex-1 px-4 py-0.5  overflow-visible text-sm placeholder:text-sm placeholder:font-normal"
              placeholder="Type any existing CLI command..."
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              autoFocus
            />
            <button className="text-sm h-full px-8" type="submit">
              Send
            </button>
          </form>
        </div>
      </section>

      {debug && (
        <section className="panel">
          <div className="panel-header">
            <h2>Quick Commands</h2>
            <span className="badge badge-outline">Raw stdin</span>
          </div>
          <div className="quick-row">
            {quickCommands.map((item) => (
              <button
                className="btn btn-sm btn-ghost"
                key={item}
                onClick={() => submitCommand(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
