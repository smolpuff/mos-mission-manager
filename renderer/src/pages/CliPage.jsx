import { useEffect, useRef, useState } from "react";
import WindowChrome from "../components/WindowChrome/app";
import useBackendState from "../components/useBackendState/app";

const debug = false;
const quickCommands = ["login", "check", "pause", "resume", "status", "r", "c"];

export default function CliPage() {
  const { bridge, status, logs } = useBackendState();
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
    await bridge.sendCommand(value);
    setCommand("");
  }

  return (
    <main className="cli-shell">
      <WindowChrome title="CLI Bridge" subtitle="Manual Control" />
      <div className="cli-drag-strip" aria-hidden="true" />

      <section className=" flex-1  ">
        <div className="space-y-4">
          <div
            className="terminal bg-black/75"
            ref={outputRef}
            style={{
              height: "460px",
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
              disabled={!status.running}
              autoFocus
            />
            <button
              className="text-sm h-full px-8"
              type="submit"
              disabled={!status.running}
            >
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
                disabled={!status.running}
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

