import { useEffect, useState } from "react";
import useDesktopBridge from "../useDesktopBridge";

function normalizeTotals(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    pbp: typeof src.pbp === "number" ? src.pbp : 0,
    tc: typeof src.tc === "number" ? src.tc : 0,
    cc: typeof src.cc === "number" ? src.cc : 0,
  };
}

function mergePersistentTotals(current, next) {
  const a = normalizeTotals(current);
  const b = normalizeTotals(next);
  return {
    pbp: Math.max(a.pbp, b.pbp),
    tc: Math.max(a.tc, b.tc),
    cc: Math.max(a.cc, b.cc),
  };
}

function normalizeBackendEvent(event) {
  if (!event || typeof event !== "object") return null;
  const typeFromEnvelope = String(event.type || "").trim();
  if (typeFromEnvelope === "pbp_event") {
    const payload =
      event.payload && typeof event.payload === "object" ? event.payload : {};
    const mappedType = String(event.event || "").trim();
    return mappedType ? { type: mappedType, ...payload } : null;
  }
  return event;
}

export default function useBackendState() {
  const bridge = useDesktopBridge();
  const [status, setStatus] = useState({
    running: false,
    pid: null,
    exitCode: null,
    exitSignal: null,
    signerLocked: null,
    signerReady: null,
    signerMode: null,
    signerWallet: null,
    signerStatus: null,
    guiMissionSlots: null,
    isAuthenticated: null,
    watcherRunning: null,
    watchLoopEnabled: null,
    currentUserDisplayName: null,
    currentUserWalletId: null,
    currentUserWalletSummary: null,
    currentMissionStats: null,
    currentMode: null,
    defaultMissionResetLevel: null,
    level20ResetEnabled: null,
    missionModeEnabled: null,
    currentMissionResetLevel: null,
    sessionRewardTotals: null,
    sessionSpendTotals: null,
    fundingWalletSummary: null,
    mcpConnection: null,
    cliWindowOpen: false,
    analytics: null,
  });
  const [logs, setLogs] = useState([]);
  const [lastEvent, setLastEvent] = useState(null);
  const [persistentRewardTotals, setPersistentRewardTotals] = useState({
    pbp: 0,
    tc: 0,
    cc: 0,
  });
  const [persistentSpendTotals, setPersistentSpendTotals] = useState({
    pbp: 0,
    tc: 0,
    cc: 0,
  });

  useEffect(() => {
    let mounted = true;
    bridge.getState().then((state) => {
      if (!mounted) return;
      setPersistentRewardTotals((current) =>
        mergePersistentTotals(current, state.status?.sessionRewardTotals),
      );
      setPersistentSpendTotals((current) =>
        mergePersistentTotals(current, state.status?.sessionSpendTotals),
      );
      setStatus(state.status);
      setLogs(state.logs);
    });

    const offStatus = bridge.onBackendStatus((nextStatus) => {
      setPersistentRewardTotals((current) =>
        mergePersistentTotals(current, nextStatus?.sessionRewardTotals),
      );
      setPersistentSpendTotals((current) =>
        mergePersistentTotals(current, nextStatus?.sessionSpendTotals),
      );
      setStatus(nextStatus);
    });
    const offOutput = bridge.onBackendOutput((entry) => {
      setLogs((current) => [...current, entry].slice(-1200));
    });
    const offEvent =
      bridge.onBackendEvent?.((event) => {
        const normalizedEvent = normalizeBackendEvent(event);
        if (normalizedEvent?.type === "cli_window_state") {
          setStatus((current) => ({
            ...current,
            cliWindowOpen: normalizedEvent.open === true,
          }));
        }
        setLastEvent(normalizedEvent);
      }) || (() => {});

    return () => {
      mounted = false;
      offStatus();
      offOutput();
      offEvent();
    };
  }, [bridge]);

  useEffect(() => {
    let cancelled = false;
    bridge.getState().then(async (state) => {
      if (cancelled) return;
      setPersistentRewardTotals((current) =>
        mergePersistentTotals(current, state.status?.sessionRewardTotals),
      );
      setPersistentSpendTotals((current) =>
        mergePersistentTotals(current, state.status?.sessionSpendTotals),
      );
      setStatus(state.status);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const effectiveStatus = {
    ...status,
    sessionRewardTotals: persistentRewardTotals,
    sessionSpendTotals: persistentSpendTotals,
  };

  return { bridge, status: effectiveStatus, logs, lastEvent };
}
