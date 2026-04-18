import React, { useEffect, useRef, useState } from "react";
import WindowChrome from "../WindowChrome/app";
import StatusBadge from "../StatusBadge/app";

/**
 * CLI Bridge component for manual backend control.
 *
 * Props:
 * - bridge: backend bridge object (required)
 * - status: backend status object (required)
 * - logs: array of log entries (required)
 * - quickCommands: array of quick command strings (optional)
 * - onSendCommand: function to send a command (optional, default: bridge.sendCommand)
 */
export default function CliView({
  bridge,
  status,
  logs,
  quickCommands = ["login", "check", "pause", "resume", "status", "r", "c"],
  onSendCommand,
}) {
  const [command, setCommand] = useState("");
  const outputRef = useRef(null);

  useEffect(() => {
    const node = outputRef.current;
    if (!node) return;
    const selection = window.getSelection ? window.getSelection() : null;
    const selectingTerminalText =
      Boolean(selection && !selection.isCollapsed) &&
      node.contains(selection.anchorNode);
    if (selectingTerminalText) return;
    const distanceFromBottom =
      node.scrollHeight - (node.scrollTop + node.clientHeight);
    const shouldAutoScroll = distanceFromBottom <= 32;
    if (shouldAutoScroll) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logs]);

  async function submitCommand(nextCommand) {
    const value = String(nextCommand || command).trim();
    if (!value) return;
    if (onSendCommand) {
      await onSendCommand(value);
    } else if (bridge?.sendCommand) {
      await bridge.sendCommand(value);
    }
    setCommand("");
  }

  return (
    <main className="cli-shell">
      <WindowChrome title="CLI Bridge" subtitle="Manual Control" />
      <div className="cli-drag-strip" aria-hidden="true" />
      <header className="cli-toolbar">
        <div>
          <h1 className="cli-title">CLI Bridge</h1>
        </div>
        <div className="toolbar-actions">
          <StatusBadge running={status.running} />
          <button
            className="btn btn-sm btn-outline"
            onClick={() => bridge.startBackend()}
          >
            Start
          </button>
          <button
            className="btn btn-sm btn-outline"
            onClick={() => bridge.stopBackend()}
          >
            Stop
          </button>
        </div>
      </header>

      <section className="panel flex-1 overflow-hidden">
        <div className="panel-header">
          <h2>Output</h2>
          <span className="badge badge-outline">stdin bridge</span>
        </div>
        <div
          className="terminal"
          ref={outputRef}
          style={{
            height: "320px",
            minHeight: "120px",
            overflowY: "auto",
          }}
        >
          {logs.length === 0 ? (
            <p className="muted">No backend output yet.</p>
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
      </section>

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
              disabled={!status.running}
            >
              {item}
            </button>
          ))}
        </div>
        <form
          className="command-form flex gap-4 "
          onSubmit={(event) => {
            event.preventDefault();
            void submitCommand();
          }}
        >
          <input
            className="input flex-1 input-bordered "
            placeholder="Type any existing CLI command..."
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={!status.running}
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!status.running}
          >
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
