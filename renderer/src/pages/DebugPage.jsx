import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useDesktopBridge from "../components/useDesktopBridge";

const RESOURCE_POLL_INTERVAL_MS = 5000;

function formatTimestamp(value) {
  const ts = Number(value || 0);
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  return new Date(ts).toLocaleString();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let next = value;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 100 || unitIndex === 0 ? 0 : next >= 10 ? 1 : 2;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatCpuPercent(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return "0%";
  return `${num.toFixed(num >= 10 ? 0 : 1)}%`;
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
  const [resourceUsage, setResourceUsage] = useState(null);
  const [resourceUsageBusy, setResourceUsageBusy] = useState(false);
  const [resourceUsageError, setResourceUsageError] = useState("");
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
    let pollTimer = null;

    const loadResourceUsage = async () => {
      if (!bridge?.getResourceUsage) return;
      setResourceUsageBusy(true);
      try {
        const result = await bridge.getResourceUsage();
        if (cancelled) return;
        setResourceUsage(result && typeof result === "object" ? result : {});
        setResourceUsageError(
          result?.ok === false
            ? String(result?.error || "Failed to read resource usage.")
            : "",
        );
      } catch (error) {
        if (cancelled) return;
        setResourceUsageError(String(error?.message || error));
      } finally {
        if (!cancelled) setResourceUsageBusy(false);
        if (!cancelled) {
          pollTimer = setTimeout(loadResourceUsage, RESOURCE_POLL_INTERVAL_MS);
        }
      }
    };

    void loadResourceUsage();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [bridge]);

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

  const refreshResourceUsage = async () => {
    if (!bridge?.getResourceUsage) return;
    setResourceUsageBusy(true);
    setResourceUsageError("");
    try {
      const result = await bridge.getResourceUsage();
      setResourceUsage(result && typeof result === "object" ? result : {});
      if (result?.ok === false) {
        setResourceUsageError(
          String(result?.error || "Failed to read resource usage."),
        );
      }
    } catch (error) {
      setResourceUsageError(String(error?.message || error));
    } finally {
      setResourceUsageBusy(false);
    }
  };

  const appUsage = resourceUsage?.app || {};
  const processBreakdown = Object.entries(appUsage.byType || {}).sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  );

  return (
    <section className="space-y-2">
      <div className="card gap-1.5 !p-3">
        <div className="flex items-start justify-between gap-1.5">
          <div>
            <h2 className="text-md font-normal leading-tight">
              Resource Usage
            </h2>
          </div>
          <button
            type="button"
            className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-100 hover:border-white/20 hover:bg-white/10 disabled:opacity-50"
            disabled={resourceUsageBusy || !bridge?.getResourceUsage}
            onClick={() => void refreshResourceUsage()}
          >
            {resourceUsageBusy ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div className="flex min-w-0 gap-1.5">
          <div className="min-w-0 flex-[1.25] rounded-xl border border-white/10 bg-black/20 px-1.5 py-1.5">
            <div className="truncate text-[9px] uppercase tracking-wide text-slate-400">
              App Working Set
            </div>
            <div className="mt-1 truncate text-sm leading-none text-white">
              {formatBytes(appUsage.totalWorkingSetBytes)}
            </div>
            <div className="mt-0.5 truncate text-[8px] leading-snug text-slate-300">
              {Number(appUsage.processCount || 0)} processes
            </div>
          </div>
          <div className="min-w-0 flex-[1.05] rounded-xl border border-white/10 bg-black/20 px-1.5 py-1.5">
            <div className="truncate text-[9px] uppercase tracking-wide text-slate-400">
              App CPU
            </div>
            <div className="mt-1 truncate text-sm leading-none text-white">
              {formatCpuPercent(appUsage.totalCpuPercent)}
            </div>
            <div className="mt-0.5 truncate text-[8px] leading-snug text-slate-300">
              sum across Electron processes
            </div>
          </div>
          {processBreakdown.length > 0 ? (
            processBreakdown.map(([type, stats]) => (
              <div
                key={type}
                className="min-w-0 flex-1 rounded-xl border border-white/6 bg-white/[0.02] px-1.5 py-1.5 text-[10px] leading-snug text-slate-200"
              >
                <div className="truncate text-[9px] uppercase text-slate-400">
                  {type} x{Number(stats?.count || 0)}
                </div>
                <div className="mt-0.5 truncate text-sm font-medium text-white">
                  {formatBytes(stats?.workingSetBytes)}
                </div>
                <div className="truncate text-[9px] text-slate-400">
                  {formatCpuPercent(stats?.cpuPercent)} CPU
                </div>
              </div>
            ))
          ) : (
            <div className="min-w-0 flex-1 rounded-xl border border-white/6 bg-white/[0.02] px-1.5 py-1.5 text-[8px] text-slate-400">
              No process metrics yet.
            </div>
          )}
          {resourceUsageError ? (
            <div className="min-w-0 flex-1 rounded-xl border border-amber-400/20 bg-amber-400/5 px-1.5 py-1.5 text-[8px] text-amber-300">
              {resourceUsageError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card gap-1.5 !p-3">
        <div className="flex items-start justify-between gap-1.5">
          {/* <div>
            <h2 className="text-md font-normal leading-tight">
              Throttle Debug
            </h2>
          </div> */}
          {/* <div className="flex items-center gap-3">
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
          </div> */}
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Throttle Count
            </div>
            <div className="mt-1 text-xl leading-none text-white">
              {Number(throttleDebug?.count || 0)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">
              Last Tool
            </div>
            <div className="mt-1 break-words font-mono text-[11px] leading-snug text-white">
              {throttleLabel(throttleDebug)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-2">
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

        <div
          ref={logViewportRef}
          onScroll={handleLogScroll}
          className="mt-2 overflow-x-hidden overflow-y-auto rounded-md border border-white/10 bg-black/30 p-2"
          style={{
            height: "420px",
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
    </section>
  );
}
