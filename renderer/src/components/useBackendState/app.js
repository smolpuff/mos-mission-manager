import { useEffect, useRef, useState } from "react";
import useDesktopBridge from "../useDesktopBridge";

function normalizeTotals(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    pbp: Number(src.pbp || 0) || 0,
    tc: Number(src.tc || 0) || 0,
    cc: Number(src.cc || 0) || 0,
  };
}

function totalsFromAnalyticsRewards(analytics) {
  const session =
    analytics?.session && typeof analytics.session === "object"
      ? analytics.session
      : {};
  const earned =
    session.currencyEarned && typeof session.currencyEarned === "object"
      ? session.currencyEarned
      : {};
  return normalizeTotals(earned);
}

function totalsFromAnalyticsSpend(analytics) {
  const session =
    analytics?.session && typeof analytics.session === "object"
      ? analytics.session
      : {};
  return normalizeTotals({
    pbp: Number(session.totalResetCostPbp || 0) || 0,
    tc: 0,
    cc: 0,
  });
}

function mergeTotalsPeak(...sources) {
  const merged = normalizeTotals();
  for (const source of sources) {
    const next = normalizeTotals(source);
    merged.pbp = Math.max(merged.pbp, next.pbp);
    merged.tc = Math.max(merged.tc, next.tc);
    merged.cc = Math.max(merged.cc, next.cc);
  }
  return merged;
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
    debugMode: null,
    nftCooldownResetEnabled: null,
    nftCooldownResetMaxPbp: null,
    currentMissionResetLevel: null,
    sessionTotalsEpoch: null,
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
  const rewardTotalsEpochRef = useRef(null);
  const spendTotalsEpochRef = useRef(null);

  const mergeRewardTotalsForStatus = (current, nextStatus) => {
    const nextEpoch = nextStatus?.sessionTotalsEpoch ?? null;
    const didEpochChange =
      nextEpoch !== null &&
      nextEpoch !== undefined &&
      rewardTotalsEpochRef.current !== null &&
      nextEpoch !== rewardTotalsEpochRef.current;
    rewardTotalsEpochRef.current =
      nextEpoch !== undefined ? nextEpoch : rewardTotalsEpochRef.current;
    const nextTotals = nextStatus?.sessionRewardTotals;
    const analyticsTotals = totalsFromAnalyticsRewards(nextStatus?.analytics);
    return didEpochChange
      ? mergeTotalsPeak(nextTotals, analyticsTotals)
      : mergeTotalsPeak(current, nextTotals, analyticsTotals);
  };

  const mergeSpendTotalsForStatus = (current, nextStatus) => {
    const nextEpoch = nextStatus?.sessionTotalsEpoch ?? null;
    const didEpochChange =
      nextEpoch !== null &&
      nextEpoch !== undefined &&
      spendTotalsEpochRef.current !== null &&
      nextEpoch !== spendTotalsEpochRef.current;
    spendTotalsEpochRef.current =
      nextEpoch !== undefined ? nextEpoch : spendTotalsEpochRef.current;
    const nextTotals = nextStatus?.sessionSpendTotals;
    const analyticsTotals = totalsFromAnalyticsSpend(nextStatus?.analytics);
    return didEpochChange
      ? mergeTotalsPeak(nextTotals, analyticsTotals)
      : mergeTotalsPeak(current, nextTotals, analyticsTotals);
  };

  useEffect(() => {
    let mounted = true;
    bridge.getState().then((state) => {
      if (!mounted) return;
      setPersistentRewardTotals((current) =>
        mergeRewardTotalsForStatus(current, state.status),
      );
      setPersistentSpendTotals((current) =>
        mergeSpendTotalsForStatus(current, state.status),
      );
      setStatus(state.status);
      setLogs(state.logs);
    });

    const offStatus = bridge.onBackendStatus((nextStatus) => {
      setPersistentRewardTotals((current) =>
        mergeRewardTotalsForStatus(current, nextStatus),
      );
      setPersistentSpendTotals((current) =>
        mergeSpendTotalsForStatus(current, nextStatus),
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
        mergeRewardTotalsForStatus(current, state.status),
      );
      setPersistentSpendTotals((current) =>
        mergeSpendTotalsForStatus(current, state.status),
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
