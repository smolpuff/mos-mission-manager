import { useEffect, useState } from "react";
import useDesktopBridge from "../useDesktopBridge";

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
    currentMissionStats: null,
    currentMode: null,
    level20ResetEnabled: null,
    missionModeEnabled: null,
    currentMissionResetLevel: null,
    fundingWalletSummary: null,
    cliWindowOpen: false,
  });
  const [logs, setLogs] = useState([]);
  const [eventTick, setEventTick] = useState(0);

  useEffect(() => {
    let mounted = true;
    bridge.getState().then((state) => {
      if (!mounted) return;
      setStatus(state.status);
      setLogs(state.logs);
    });

    const offStatus = bridge.onBackendStatus((nextStatus) => {
      setStatus(nextStatus);
    });
    const offOutput = bridge.onBackendOutput((entry) => {
      setLogs((current) => [...current, entry].slice(-1200));
    });
    const offEvent =
      bridge.onBackendEvent?.((event) => {
        if (event?.type === "cli_window_state") {
          setStatus((current) => ({
            ...current,
            cliWindowOpen: event.open === true,
          }));
        }
        setEventTick((n) => n + 1);
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
    bridge.getState().then((state) => {
      if (cancelled) return;
      setStatus(state.status);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, eventTick]);

  return { bridge, status, logs };
}
