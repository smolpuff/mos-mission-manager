import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useDesktopBridge from "../components/useDesktopBridge";

function formatTimestamp(value) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleString();
}

function throttleLabel(throttleDebug) {
  if (!throttleDebug || typeof throttleDebug !== "object") return "—";
  return (
    throttleDebug.lastRequestedTool || throttleDebug.lastTriggerTool || "—"
  );
}

export default function DebugPage({
  desktopDevMode,
  throttleDebug,
  lastEvent,
}) {
  const bridge = useDesktopBridge();
  const [throttleLog, setThrottleLog] = useState("");
  const [throttleLogPath, setThrottleLogPath] = useState("");
  const [throttleLogBusy, setThrottleLogBusy] = useState(false);
  const [throttleLogError, setThrottleLogError] = useState("");
  const logViewportRef = useRef(null);
  const pinnedToBottomRef = useRef(true);
  const throttleLogAvailable =
    throttleDebug &&
    typeof throttleDebug === "object" &&
    String(throttleDebug.logPath || "").trim().length > 0;

  const handleLogScroll = () => {
    const node = logViewportRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - (node.scrollTop + node.clientHeight);
    pinnedToBottomRef.current = distanceFromBottom <= 32;
  };

  useLayoutEffect(() => {
    const node = logViewportRef.current;
    if (!node) return;
    const selection = window.getSelection ? window.getSelection() : null;
    const selectingLogText =
      Boolean(selection && !selection.isCollapsed) &&
      node.contains(selection.anchorNode);
    if (selectingLogText) return;
    if (pinnedToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [throttleLog]);

  useEffect(() => {
    let cancelled = false;
    const loadThrottleLog = async () => {
      if (!throttleLogAvailable) return;
      if (!bridge?.getThrottleDebugLog) return;
      setThrottleLogBusy(true);
      setThrottleLogError("");
      try {
        const result = await bridge.getThrottleDebugLog();
        if (cancelled) return;
        setThrottleLogPath(String(result?.path || ""));
        setThrottleLog(String(result?.text || ""));
        setThrottleLogError(
          result?.ok === false
            ? String(result?.error || "Failed to read log.")
            : "",
        );
      } catch (error) {
        if (cancelled) return;
        setThrottleLogError(String(error?.message || error));
      } finally {
        if (!cancelled) setThrottleLogBusy(false);
      }
    };
    void loadThrottleLog();
    return () => {
      cancelled = true;
    };
  }, [bridge, throttleLogAvailable]);

  useEffect(() => {
    if (lastEvent?.type !== "throttle_notice") return;
    if (!throttleLogAvailable) return;
    if (!bridge?.getThrottleDebugLog) return;
    let cancelled = false;
    const reloadThrottleLog = async () => {
      setThrottleLogBusy(true);
      try {
        const result = await bridge.getThrottleDebugLog();
        if (cancelled) return;
        setThrottleLogPath(String(result?.path || ""));
        setThrottleLog(String(result?.text || ""));
        setThrottleLogError(
          result?.ok === false
            ? String(result?.error || "Failed to read log.")
            : "",
        );
      } catch (error) {
        if (cancelled) return;
        setThrottleLogError(String(error?.message || error));
      } finally {
        if (!cancelled) setThrottleLogBusy(false);
      }
    };
    void reloadThrottleLog();
    return () => {
      cancelled = true;
    };
  }, [bridge, lastEvent, throttleLogAvailable]);

  const refreshThrottleLog = async () => {
    if (!throttleLogAvailable) return;
    if (!bridge?.getThrottleDebugLog) return;
    setThrottleLogBusy(true);
    setThrottleLogError("");
    try {
      const result = await bridge.getThrottleDebugLog();
      setThrottleLogPath(String(result?.path || ""));
      setThrottleLog(String(result?.text || ""));
      setThrottleLogError(
        result?.ok === false
          ? String(result?.error || "Failed to read log.")
          : "",
      );
    } catch (error) {
      setThrottleLogError(String(error?.message || error));
    } finally {
      setThrottleLogBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="card gap-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-normal leading-tight">Throttle Debug</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs uppercase text-slate-400">
              <div>{desktopDevMode ? ":dev active" : ":dev off"}</div>
            </div>
            <button
              type="button"
              className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-100 hover:border-white/20 hover:bg-white/10 disabled:opacity-50"
              disabled={throttleLogBusy || !throttleLogAvailable}
              onClick={() => void refreshThrottleLog()}
            >
              {throttleLogBusy ? "Refreshing..." : "Refresh Log"}
            </button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Throttle Count
            </div>
            <div className="mt-1 text-2xl leading-none text-white">
              {Number(throttleDebug?.count || 0)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Last Tool
            </div>
            <div className="mt-1 break-words font-mono text-[11px] leading-snug text-white">
              {throttleLabel(throttleDebug)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Last Throttle
            </div>
            <div className="mt-1 text-[11px] leading-snug text-white">
              {formatTimestamp(throttleDebug?.lastAt)}
            </div>
            <div className="mt-1 text-[10px] leading-snug text-slate-300">
              {throttleDebug?.lastType || "—"}
              {Number.isFinite(Number(throttleDebug?.lastWaitSeconds))
                ? ` • wait ${Number(throttleDebug.lastWaitSeconds)}s`
                : ""}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Log File
            </div>
            <div className="text-right text-[10px] leading-snug text-slate-400">
              {throttleLogPath ||
                throttleDebug?.logPath ||
                "Restart desktop process to enable log viewer"}
            </div>
          </div>
          {!throttleLogAvailable ? (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-100">
              Throttle log viewer becomes available after the Electron main
              process restarts with the new IPC handler.
            </div>
          ) : null}
          {throttleLogError ? (
            <div className="mt-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-100">
              {throttleLogError}
            </div>
          ) : null}
          <div
            ref={logViewportRef}
            onScroll={handleLogScroll}
            className="mt-2 overflow-x-hidden overflow-y-auto rounded-md border border-white/10 bg-black/30 p-2.5"
            style={{
              height: "460px",
              minHeight: "240px",
              overflowX: "hidden",
              overflowY: "auto",
            }}
          >
            <pre
              className="font-mono text-slate-100"
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                fontSize: "11px",
                lineHeight: 1.35,
              }}
            >
              {throttleLog || "No throttle log entries yet."}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
