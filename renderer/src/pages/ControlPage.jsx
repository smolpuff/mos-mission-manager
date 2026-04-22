import NavMain from "../components/nav/app";
import { useEffect, useMemo, useRef, useState } from "react";
import WindowChrome from "../components/WindowChrome/app";
import HeaderUser from "../components/HeaderUser/app";
import useBackendState from "../components/useBackendState/app";
import ToggleSwitch from "../components/ToggleSwitch/app";
import CompetitionPage from "./CompetitionPage";
import SettingsPage from "./SettingsPage";

import pbpIcon from "../img/icon_pbp.webp";
import solIcon from "../img/icon-sm__sol.svg";
import ccIcon from "../img/icon_cc.webp";
import tcIcon from "../img/icon_tc.webp";
import backImg from "../img/back.png";
const debug = false;

const quickCommands = ["login", "check", "pause", "resume", "status", "r", "c"];

function useDesktopBridge() {
  return window.missionsDesktop;
}

function MissionSlotImage({ src }) {
  const [activeSrc, setActiveSrc] = useState(src || null);
  const [outgoingSrc, setOutgoingSrc] = useState(null);

  useEffect(() => {
    if (src === activeSrc) return;
    setOutgoingSrc(activeSrc);
    setActiveSrc(src || null);
    const timer = setTimeout(() => setOutgoingSrc(null), 320);
    return () => clearTimeout(timer);
  }, [src, activeSrc]);

  return (
    <>
      {outgoingSrc ? (
        <img
          key={`out-${outgoingSrc}`}
          src={outgoingSrc}
          alt=""
          className="mission-image mission-image--out"
        />
      ) : null}
      {activeSrc ? (
        <img
          key={`in-${activeSrc}`}
          src={activeSrc}
          alt=""
          className="mission-image mission-image--in"
        />
      ) : null}
    </>
  );
}

function SlideNumber({ value }) {
  const [current, setCurrent] = useState(Number(value) || 0);
  const [outgoing, setOutgoing] = useState(null);
  const [direction, setDirection] = useState("up");

  useEffect(() => {
    const next = Number(value) || 0;
    if (next === current) return;
    setDirection(next > current ? "up" : "down");
    setOutgoing(current);
    setCurrent(next);
    const timer = setTimeout(() => setOutgoing(null), 260);
    return () => clearTimeout(timer);
  }, [value, current]);

  return (
    <span className="num-ticker" aria-live="polite">
      {outgoing !== null ? (
        <span
          className={`num-ticker__item num-ticker__item--out ${
            direction === "up"
              ? "num-ticker__item--out-up"
              : "num-ticker__item--out-down"
          }`}
        >
          {outgoing}
        </span>
      ) : null}
      <span
        className={`num-ticker__item num-ticker__item--in ${
          direction === "up"
            ? "num-ticker__item--in-up"
            : "num-ticker__item--in-down"
        }`}
      >
        {current}
      </span>
    </span>
  );
}

function parseDisplayNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  // Handle values like "1,234.56" coming from displayBalance fields.
  const cleaned = value.replace(/[, _]/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function missionKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
}

function SlideNumberFormatted({ value, format }) {
  const formatFn = typeof format === "function" ? format : (n) => String(n);
  const [current, setCurrent] = useState(Number(value) || 0);
  const [outgoing, setOutgoing] = useState(null);
  const [direction, setDirection] = useState("up");

  useEffect(() => {
    const next = Number(value) || 0;
    if (next === current) return;
    setDirection(next > current ? "up" : "down");
    setOutgoing(current);
    setCurrent(next);
    const timer = setTimeout(() => setOutgoing(null), 260);
    return () => clearTimeout(timer);
  }, [value, current]);

  return (
    <span className="num-ticker" aria-live="polite">
      {outgoing !== null ? (
        <span
          className={`num-ticker__item num-ticker__item--out ${
            direction === "up"
              ? "num-ticker__item--out-up"
              : "num-ticker__item--out-down"
          }`}
        >
          {formatFn(outgoing)}
        </span>
      ) : null}
      <span
        className={`num-ticker__item num-ticker__item--in ${
          direction === "up"
            ? "num-ticker__item--in-up"
            : "num-ticker__item--in-down"
        }`}
      >
        {formatFn(current)}
      </span>
    </span>
  );
}

function ControlView() {
  const { bridge, status, logs, lastEvent } = useBackendState();
  const [currentPage, setCurrentPage] = useState("missions");
  const [isCliActive, setIsCliActive] = useState(false);
  const [fundingSource, setFundingSource] = useState("browser");
  const [fundingEnabled, setFundingEnabled] = useState(true);
  const [resetEnabled, setResetEnabled] = useState(
    status.level20ResetEnabled === true,
  );
  const [modeSelection, setModeSelection] = useState(
    status.missionModeEnabled === true ? "mission" : "normal",
  );
  const [latestCompetition, setLatestCompetition] = useState(null);
  const [latestCompetitionBusy, setLatestCompetitionBusy] = useState(false);
  const [latestCompetitionError, setLatestCompetitionError] = useState(null);
  const [createWalletOpen, setCreateWalletOpen] = useState(false);
  const [createWalletOnboarding, setCreateWalletOnboarding] = useState(false);
  const [createWalletConfirm, setCreateWalletConfirm] = useState(false);
  const [createWalletBusy, setCreateWalletBusy] = useState(false);
  const [createWalletError, setCreateWalletError] = useState(null);
  const [createWalletResult, setCreateWalletResult] = useState(null);
  const [createWalletRevealed, setCreateWalletRevealed] = useState(false);
  const [createCopiedPhraseLabel, setCreateCopiedPhraseLabel] = useState(null);
  const [createCopiedAddrLabel, setCreateCopiedAddrLabel] = useState(null);
  const [slotResetErrors, setSlotResetErrors] = useState({});
  const [resetErrorModal, setResetErrorModal] = useState(null);
  const [slotUnlockModalOpen, setSlotUnlockModalOpen] = useState(false);
  const [slotUnlockBusy, setSlotUnlockBusy] = useState(false);
  const [slotUnlockError, setSlotUnlockError] = useState(null);
  const [slotUnlockResult, setSlotUnlockResult] = useState(null);
  const [lowBalanceModal, setLowBalanceModal] = useState(null);
  const [lowBalanceThresholds, setLowBalanceThresholds] = useState({
    pbp: 1000,
    sol: 0.01,
  });
  const lowBalanceArmedRef = useRef({ pbp: false, sol: false });
  const isMissionMode = modeSelection === "mission";
  const isNormalMode = !isMissionMode;
  const applyConfigPatch = async (patch) => {
    if (bridge?.updateConfig) {
      await bridge.updateConfig(patch);
    }
  };
  const setSignerMode = async (mode) => {
    const next =
      mode === "browser_wallet" ? "manual" : String(mode || "").trim();
    if (!next) return;
    // Persist the choice even if the backend isn't running yet.
    await applyConfigPatch({ signerMode: next });
    // Also apply live if possible (this is the "real" app behavior).
    if (status.running && bridge?.sendCommand) {
      await bridge.sendCommand(`signer ${next}`);
    }
    if (next === "app_wallet" && bridge?.refreshWalletSummary) {
      try {
        await bridge.refreshWalletSummary();
      } catch {}
    }
    if (next === "app_wallet") {
      const signerWallet = String(status.signerWallet || "").trim();
      const fundingAddress = String(
        status.fundingWalletSummary?.address || "",
      ).trim();
      const hasWalletByStatus =
        status.signerStatus === "app_wallet_locked" ||
        status.signerStatus === "app_wallet_unlocked";
      const hasWallet = Boolean(
        signerWallet || fundingAddress || hasWalletByStatus,
      );
      const missingWallet =
        status.signerStatus === "app_wallet_not_imported" || !hasWallet;
      if (missingWallet) {
        setCreateWalletOnboarding(true);
        setCreateWalletOpen(true);
        setCreateWalletConfirm(false);
        setCreateWalletBusy(false);
        setCreateWalletError(null);
        setCreateWalletResult(null);
        setCreateWalletRevealed(false);
        setCreateCopiedPhraseLabel(null);
        setCreateCopiedAddrLabel(null);
      }
    }
  };
  const runModeCommand = async (commands) => {
    const list = Array.isArray(commands) ? commands : [commands];
    if (!status.running) return;
    for (const command of list) {
      if (!command) continue;
      await bridge.sendCommand(command);
    }
  };
  useEffect(() => {
    if (typeof status.level20ResetEnabled === "boolean") {
      setResetEnabled(status.level20ResetEnabled);
    }
  }, [status.level20ResetEnabled]);

  useEffect(() => {
    if (typeof status.missionModeEnabled === "boolean") {
      setModeSelection(status.missionModeEnabled ? "mission" : "normal");
    }
  }, [status.missionModeEnabled]);

  useEffect(() => {
    let cancelled = false;
    if (!bridge?.getConfig) return undefined;
    bridge.getConfig().then((response) => {
      if (cancelled) return;
      const config = response?.config || {};
      if (typeof config.level20ResetEnabled === "boolean") {
        setResetEnabled(config.level20ResetEnabled);
      }
      if (typeof config.missionModeEnabled === "boolean") {
        setModeSelection(config.missionModeEnabled ? "mission" : "normal");
      }
      const configuredPbp = Number(
        config?.lowBalanceThresholds?.pbp ?? config?.lowBalancePbpThreshold,
      );
      const configuredSol = Number(
        config?.lowBalanceThresholds?.sol ?? config?.lowBalanceSolThreshold,
      );
      setLowBalanceThresholds({
        pbp:
          Number.isFinite(configuredPbp) && configuredPbp >= 0
            ? configuredPbp
            : 1000,
        sol:
          Number.isFinite(configuredSol) && configuredSol >= 0
            ? configuredSol
            : 0.01,
      });
      if (config.firstRunOnboardingCompleted !== true) {
        setOnboardingPreviewOnly(false);
        setOnboardingOpen(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const refreshLatestCompetition = async () => {
    if (!bridge?.getLatestCompetition) {
      setLatestCompetitionError(
        "Desktop bridge missing getLatestCompetition()",
      );
      return;
    }
    setLatestCompetitionBusy(true);
    setLatestCompetitionError(null);
    try {
      const res = await bridge.getLatestCompetition({});
      if (!res?.ok) throw new Error(res?.error || "Scrape failed.");
      setLatestCompetition(res.competition || null);
    } catch (e) {
      setLatestCompetitionError(String(e?.message || e));
    } finally {
      setLatestCompetitionBusy(false);
    }
  };

  useEffect(() => {
    if (currentPage !== "mish_tish") return;
    if (latestCompetition || latestCompetitionBusy || latestCompetitionError)
      return;
    void refreshLatestCompetition();
  }, [
    currentPage,
    latestCompetition,
    latestCompetitionBusy,
    latestCompetitionError,
  ]);

  const setMissionResetEnabled = async (enabled) => {
    setResetEnabled(enabled);
    await applyConfigPatch({ level20ResetEnabled: enabled });
    await runModeCommand(enabled ? "20r on" : "20r off");
  };
  const activateNormalMode = async () => {
    setModeSelection("normal");
    setResetEnabled(true);
    await applyConfigPatch({
      missionModeEnabled: false,
      missionResetLevel: "20",
      level20ResetEnabled: true,
    });
    await runModeCommand(["mm off", "20r on"]);
  };
  const activateMissionMode = async () => {
    setModeSelection("mission");
    setResetEnabled(false);
    await applyConfigPatch({
      missionModeEnabled: true,
      missionResetLevel: "6",
      level20ResetEnabled: false,
    });
    await runModeCommand(["mm 6"]);
  };
  const normalizeImageUrl = (raw) => {
    const value = String(raw || "").trim();
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (/^\/\//.test(value)) return `https:${value}`;
    if (/^gateway\.irys\.xyz\//i.test(value)) return `https://${value}`;
    if (/^ipfs:\/\//i.test(value)) {
      const cid = value.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
      return cid ? `https://ipfs.io/ipfs/${cid}` : null;
    }
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[0-9a-z]{20,})$/i.test(value)) {
      return `https://ipfs.io/ipfs/${value}`;
    }
    return null;
  };
  const pickSlotImage = (entry) => {
    const candidates = [
      entry?.nftImage,
      entry?.assignedNftImage,
      entry?.image,
      entry?.imageUrl,
      entry?.image_url,
      entry?.thumbnail,
      entry?.thumbnailUrl,
      entry?.thumbnail_url,
      entry?.assignedNft?.image,
      entry?.assignedNft?.imageUrl,
      entry?.assignedNft?.image_url,
      entry?.assignedNft?.thumbnail,
      entry?.assignedNft?.thumbnailUrl,
      entry?.assignedNft?.thumbnail_url,
      entry?.currentAssignedNFT?.image,
      entry?.currentAssignedNFT?.imageUrl,
      entry?.currentAssignedNFT?.image_url,
      entry?.currentAssignedNft?.image,
      entry?.currentAssignedNft?.imageUrl,
      entry?.currentAssignedNft?.image_url,
    ];
    for (const candidate of candidates) {
      const url = normalizeImageUrl(candidate);
      if (url) return url;
    }
    return null;
  };
  const latestLog = useMemo(() => {
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      if (typeof logs[i]?.text === "string" && logs[i].text.trim())
        return logs[i];
    }
    return null;
  }, [logs]);
  const walletTiles = useMemo(() => {
    const balances = Array.isArray(status.currentUserWalletSummary?.balances)
      ? status.currentUserWalletSummary.balances
      : [];
    const byKey = new Map();
    for (const entry of balances) {
      if (!entry || typeof entry !== "object") continue;
      const key = String(entry.key || entry.symbol || entry.name || "")
        .trim()
        .toLowerCase();
      if (!key) continue;
      byKey.set(key, entry);
    }
    const rewardTotals = status.sessionRewardTotals || {};
    const spendTotals = status.sessionSpendTotals || {};
    const signerMode = String(status.signerMode || "").trim();
    const applyMainWalletSpend = signerMode !== "app_wallet";
    const effectiveSpendTotals = applyMainWalletSpend
      ? spendTotals
      : { pbp: 0, cc: 0, tc: 0 };
    const formatWalletAmount = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return "0";
      return n.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      });
    };
    return [
      {
        key: "sol",
        label: "Solana",
        icon: solIcon,
        balance:
          byKey.get("sol")?.displayBalance ?? byKey.get("sol")?.balance ?? 0,
        earned: 0,
        earnedVisible: false,
      },
      {
        key: "pbp",
        label: "PBP Token",
        icon: pbpIcon,
        balance:
          byKey.get("pbp")?.displayBalance ?? byKey.get("pbp")?.balance ?? 0,
        earned: (rewardTotals.pbp ?? 0) - (effectiveSpendTotals.pbp ?? 0),
        earnedVisible: true,
      },
      {
        key: "cc",
        label: "Community Coins",
        icon: ccIcon,
        balance:
          byKey.get("cc")?.displayBalance ??
          byKey.get("cc")?.balance ??
          byKey.get("community_coins")?.displayBalance ??
          byKey.get("community_coins")?.balance ??
          0,
        earned: (rewardTotals.cc ?? 0) - (effectiveSpendTotals.cc ?? 0),
        earnedVisible: true,
      },
      {
        key: "tc",
        label: "Tournament Coins",
        icon: tcIcon,
        balance:
          byKey.get("tc")?.displayBalance ??
          byKey.get("tc")?.balance ??
          byKey.get("tournament_coins")?.displayBalance ??
          byKey.get("tournament_coins")?.balance ??
          0,
        earned: (rewardTotals.tc ?? 0) - (effectiveSpendTotals.tc ?? 0),
        earnedVisible: true,
      },
    ].map((tile) => ({
      ...tile,
      balanceNumber: parseDisplayNumber(tile.balance),
      balanceLabel:
        typeof tile.balance === "string"
          ? tile.balance
          : formatWalletAmount(tile.balance),
      earnedNumber: Math.abs(parseDisplayNumber(tile.earned)),
      earnedLabel: formatWalletAmount(Math.abs(tile.earned)),
      earnedDirection: Number(tile.earned || 0) < 0 ? "-" : "+",
      earnedClass:
        Number(tile.earned || 0) > 0
          ? "text-success"
          : Number(tile.earned || 0) < 0
            ? "text-error"
            : "text-slate-400",
    }));
  }, [
    status.currentUserWalletSummary,
    status.signerMode,
    status.sessionRewardTotals,
    status.sessionSpendTotals,
  ]);
  const lockLabel =
    status.signerLocked === true
      ? "Locked"
      : status.signerLocked === false
        ? "Unlocked"
        : "";
  const slots = Array.isArray(status.guiMissionSlots)
    ? status.guiMissionSlots
    : [];
  const slotUnlockSummary =
    status.slotUnlockSummary && typeof status.slotUnlockSummary === "object"
      ? status.slotUnlockSummary
      : null;
  const slotUnlockCost = Number(
    slotUnlockSummary?.unlockCost ?? slotUnlockSummary?.raw?.unlockCost ?? 2500,
  );
  const normalizedSlotUnlockCost =
    Number.isFinite(slotUnlockCost) && slotUnlockCost > 0
      ? Math.floor(slotUnlockCost)
      : 2500;
  const canUnlockSlot4 =
    slotUnlockSummary?.canUnlockMore === true &&
    Number(slotUnlockSummary?.nextUnlockSlot) === 4;
  const missionStats = status.currentMissionStats || {};
  const fundingWalletSummary =
    status.fundingWalletSummary?.status === "ok"
      ? status.fundingWalletSummary
      : null;
  const appWalletAddress = String(
    fundingWalletSummary?.address || status.signerWallet || "",
  ).trim();
  const normalizeCompetitionName = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9._-]/g, "");
  const currentCompetitionUserKeys = [
    normalizeCompetitionName(status.currentUserDisplayName),
    normalizeCompetitionName(status.currentUserWalletId),
  ].filter(Boolean);
  const isCurrentCompetitionRow = (playerValue) => {
    const rowKey = normalizeCompetitionName(playerValue);
    if (!rowKey || !currentCompetitionUserKeys.length) return false;
    return currentCompetitionUserKeys.some(
      (key) => rowKey === key || rowKey.includes(key) || key.includes(rowKey),
    );
  };
  const isWatching = status.watcherRunning === true;
  const isStarting = status.running && !isWatching;
  const [activityLabel, setActivityLabel] = useState(null);
  const [manualCheckBusy, setManualCheckBusy] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState(null);
  const [secretModalOpen, setSecretModalOpen] = useState(false);
  const [secretModalBusy, setSecretModalBusy] = useState(false);
  const [secretModalError, setSecretModalError] = useState(null);
  const [secretModalBackup, setSecretModalBackup] = useState(null);
  const [secretModalRevealed, setSecretModalRevealed] = useState(false);
  const [secretCopiedPhraseLabel, setSecretCopiedPhraseLabel] = useState(null);
  const [secretCopiedAddrLabel, setSecretCopiedAddrLabel] = useState(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState(null);
  const [onboardingSignerMode, setOnboardingSignerMode] = useState("");
  const [onboardingAppWalletBusy, setOnboardingAppWalletBusy] = useState(false);
  const [onboardingAppWalletError, setOnboardingAppWalletError] =
    useState(null);
  const [onboardingAppWalletAddress, setOnboardingAppWalletAddress] =
    useState("");
  const [onboardingWhoami, setOnboardingWhoami] = useState(null);
  const [onboardingMissions, setOnboardingMissions] = useState([]);
  const [onboardingMissionCatalog, setOnboardingMissionCatalog] = useState([]);
  const [onboardingOwnedCollections, setOnboardingOwnedCollections] = useState(
    new Set(),
  );
  const [onboardingSelectedMissions, setOnboardingSelectedMissions] = useState(
    new Set(),
  );
  const [onboardingPreviewOnly, setOnboardingPreviewOnly] = useState(false);
  const [onboardingDataLoading, setOnboardingDataLoading] = useState(false);
  const [onboardingBodyHeight, setOnboardingBodyHeight] = useState(null);
  const onboardingBodyRef = useRef(null);
  const onboardingCatalogByName = useMemo(() => {
    const map = new Map();
    for (const mission of onboardingMissionCatalog) {
      const key = missionKey(mission?.name);
      if (!key || map.has(key)) continue;
      map.set(key, mission);
    }
    return map;
  }, [onboardingMissionCatalog]);
  const onboardingCatalogById = useMemo(() => {
    const map = new Map();
    for (const mission of onboardingMissionCatalog) {
      const key = String(mission?.id || "").trim();
      if (!key || map.has(key)) continue;
      map.set(key, mission);
    }
    return map;
  }, [onboardingMissionCatalog]);

  const mainStatusLabel = activityLabel
    ? activityLabel
    : status.running
      ? isWatching
        ? "Watching missions..."
        : "Starting up..."
      : "Stopped";

  useEffect(() => {
    if (status.running) return;
    setActivityLabel(null);
    setManualCheckBusy(false);
  }, [status.running]);

  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== "object") return;
    const type = String(lastEvent.type || "").trim();
    if (type === "assigning") {
      const state = String(lastEvent.state || "").trim();
      if (state === "start") setManualCheckBusy(true);
      if (state === "done" || state === "error") setManualCheckBusy(false);
    }
    if (type === "claiming") {
      const state = String(lastEvent.state || "").trim();
      if (state === "start") setManualCheckBusy(true);
      if (state === "done" || state === "error") setManualCheckBusy(false);
    }
    if (type === "claimed" || type === "assigned") {
      setManualCheckBusy(false);
    }
    let next = null;
    let resetToWatchingMs = null;
    if (type === "claimed") {
      const logLabel = String(lastEvent.logLabel || "").trim();
      next = logLabel ? `✅ ${logLabel}` : "✅ Claimed mission";
      resetToWatchingMs = 2200;
    } else if (type === "assigning") {
      const state = String(lastEvent.state || "").trim();
      if (state === "start") {
        next = "🚀 Starting mission...";
      } else if (state === "done") {
        const count = Number(lastEvent.assigned || 0);
        next = count > 0 ? "✅ Started mission" : "Watching missions...";
        if (count > 0) resetToWatchingMs = 2200;
      } else if (state === "error") {
        next = "❌ Start failed";
        resetToWatchingMs = 3200;
      }
    } else if (type === "assigned") {
      next = "✅ Started mission";
      resetToWatchingMs = 2200;
    } else if (type === "claiming") {
      const state = String(lastEvent.state || "").trim();
      if (state === "start") {
        next = "⏳ Claiming mission...";
      } else if (state === "done") {
        const count = Number(lastEvent.claimed || 0);
        next = count > 0 ? `✅ Claimed ${count}` : "Watching missions...";
        if (count > 0) resetToWatchingMs = 2200;
      } else if (state === "error") {
        next = "❌ Claim failed";
        resetToWatchingMs = 3200;
      }
    } else if (type === "tick" && isWatching) {
      const current = String(activityLabel || "").toLowerCase();
      if (
        current.includes("claiming mission") ||
        current.includes("starting mission")
      ) {
        next = "Watching missions...";
      }
    }
    if (!next) return;
    setActivityLabel(next);
    if (
      !Number.isFinite(Number(resetToWatchingMs)) ||
      Number(resetToWatchingMs) <= 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      setActivityLabel((current) => {
        if (!status.running) return null;
        if (status.watcherRunning === true) return "Watching missions...";
        return current === next ? null : current;
      });
    }, Number(resetToWatchingMs));
    return () => clearTimeout(timer);
  }, [
    lastEvent,
    isWatching,
    activityLabel,
    status.running,
    status.watcherRunning,
  ]);

  useEffect(() => {
    if (!lastEvent || typeof lastEvent !== "object") return;
    const type = String(lastEvent.type || "").trim();
    if (type === "reset_error") {
      const slot = Number(lastEvent.slot);
      const slotKey =
        Number.isFinite(slot) && slot >= 1 && slot <= 4
          ? String(slot)
          : String(
              lastEvent.assignedMissionId ||
                lastEvent.missionName ||
                Date.now(),
            );
      const nextError = {
        slot: Number.isFinite(slot) ? slot : null,
        assignedMissionId:
          String(lastEvent.assignedMissionId || "").trim() || null,
        missionName:
          String(lastEvent.missionName || "").trim() || "Unknown mission",
        actionName: String(lastEvent.actionName || "").trim() || "reset",
        error: String(lastEvent.error || "Reset failed."),
        bridgeUrl: String(lastEvent.bridgeUrl || "").trim() || null,
        at: Date.now(),
      };
      setSlotResetErrors((current) => ({
        ...current,
        [slotKey]: nextError,
      }));
      setResetErrorModal(nextError);
      return;
    }
    if (type === "reset_error_cleared") {
      const slot = Number(lastEvent.slot);
      const slotKey =
        Number.isFinite(slot) && slot >= 1 && slot <= 4
          ? String(slot)
          : String(lastEvent.assignedMissionId || "").trim();
      if (!slotKey) return;
      setSlotResetErrors((current) => {
        if (!Object.prototype.hasOwnProperty.call(current, slotKey))
          return current;
        const next = { ...current };
        delete next[slotKey];
        return next;
      });
      setResetErrorModal((current) => {
        if (!current || String(current.assignedMissionId || "") !== slotKey) {
          if (current && Number.isFinite(slot) && Number(current.slot) === slot)
            return null;
          return current;
        }
        return null;
      });
    }
  }, [lastEvent]);

  useEffect(() => {
    setIsCliActive(status.cliWindowOpen === true);
  }, [status.cliWindowOpen]);

  useEffect(() => {
    const mode = String(status.signerMode || "").trim();
    if (!mode) return;
    const enabled = mode !== "manual";
    setFundingEnabled(enabled);
    setFundingSource(mode === "app_wallet" ? "app_wallet" : "browser");
  }, [status.signerMode]);

  useEffect(() => {
    // When switching into app_wallet mode, the backend may write signer wallet
    // address to config asynchronously. Do one delayed refresh so the balance
    // populates without polling.
    const mode = String(status.signerMode || "").trim();
    if (mode !== "app_wallet") return;
    if (status.fundingWalletSummary?.status === "ok") return;
    if (!bridge?.refreshWalletSummary) return;
    const timer = setTimeout(() => {
      void bridge.refreshWalletSummary();
    }, 400);
    return () => clearTimeout(timer);
  }, [bridge, status.signerMode, status.fundingWalletSummary?.status]);

  useEffect(() => {
    if (!fundingWalletSummary) return;
    const pbp = parseDisplayNumber(fundingWalletSummary?.pbp);
    const sol = parseDisplayNumber(fundingWalletSummary?.sol);
    const pbpThreshold = Number(lowBalanceThresholds?.pbp ?? 1000);
    const solThreshold = Number(lowBalanceThresholds?.sol ?? 0.01);
    const armed = lowBalanceArmedRef.current;

    if (Number.isFinite(pbp) && pbp >= pbpThreshold) {
      armed.pbp = true;
    }
    if (Number.isFinite(sol) && sol >= solThreshold) {
      armed.sol = true;
    }

    const reasons = [];
    if (Number.isFinite(pbp) && pbp < pbpThreshold && armed.pbp) {
      reasons.push(
        `PBP balance dropped below ${pbpThreshold.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}.`,
      );
      armed.pbp = false;
    }
    if (Number.isFinite(sol) && sol < solThreshold && armed.sol) {
      reasons.push(
        `SOL balance dropped below ${solThreshold.toLocaleString(undefined, {
          maximumFractionDigits: 4,
        })}.`,
      );
      armed.sol = false;
    }
    if (reasons.length === 0) return;

    setLowBalanceModal({
      reasons,
      pbp,
      sol,
      address: String(
        fundingWalletSummary?.address || status.signerWallet || "",
      ).trim(),
      at: Date.now(),
    });
  }, [fundingWalletSummary, status.signerWallet, lowBalanceThresholds]);

  useEffect(() => {
    if (!status.running) return;
    if (isWatching) {
      setActivityLabel((current) => current || "Watching missions...");
      return;
    }
    setActivityLabel((current) => current || "Starting up...");
  }, [status.running, isWatching]);

  useEffect(() => {
    if (!onboardingOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOnboardingOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onboardingOpen]);

  useEffect(() => {
    if (!onboardingOpen) {
      setOnboardingBodyHeight(null);
      return;
    }
    const body = onboardingBodyRef.current;
    if (!body) return;
    const next = body.scrollHeight;
    setOnboardingBodyHeight((prev) => (prev == null ? next : prev));
    const raf = requestAnimationFrame(() => {
      setOnboardingBodyHeight(next);
    });
    return () => cancelAnimationFrame(raf);
  }, [
    onboardingOpen,
    onboardingStep,
    onboardingBusy,
    onboardingDataLoading,
    onboardingError,
    onboardingMissionCatalog.length,
    onboardingMissions.length,
  ]);

  useEffect(() => {
    if (!onboardingOpen) return undefined;
    const body = onboardingBodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setOnboardingBodyHeight(body.scrollHeight);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [onboardingOpen]);

  const openCliWindow = () => {
    setIsCliActive(true);
    void bridge.openCliWindow();
  };

  const copyText = async (text) => {
    const value = String(text || "").trim();
    if (!value) return false;
    try {
      if (bridge?.copyToClipboard) {
        await bridge.copyToClipboard(value);
        return true;
      }
    } catch {}
    try {
      await navigator.clipboard?.writeText?.(value);
      return true;
    } catch {
      return false;
    }
  };
  const openExternalUrl = async (url) => {
    const target = String(url || "").trim();
    if (!target) return false;
    if (bridge?.openExternal) {
      try {
        await bridge.openExternal(target);
        return true;
      } catch {}
    }
    try {
      window.open(target, "_blank", "noopener,noreferrer");
      return true;
    } catch {
      return false;
    }
  };
  const confirmUnlockSlot4 = async () => {
    if (!bridge?.prepareSlot4Unlock) {
      setSlotUnlockError("Unlock flow is not available in this build.");
      return;
    }
    if (!status.running) {
      setSlotUnlockError(
        "Start missions first so backend can prepare the unlock.",
      );
      return;
    }
    setSlotUnlockBusy(true);
    setSlotUnlockError(null);
    setSlotUnlockResult(null);
    try {
      const res = await bridge.prepareSlot4Unlock();
      if (!res?.ok) throw new Error(res?.error || "Unlock preparation failed.");
      const prepared = res.prepared || null;
      setSlotUnlockResult(prepared);
      if (!prepared?.ok) {
        throw new Error(prepared?.reason || "Unlock preparation failed.");
      }
      if (prepared?.reason === "no_more_to_unlock") {
        setSlotUnlockError("No more slots to unlock.");
      }
    } catch (e) {
      setSlotUnlockError(String(e?.message || e));
    } finally {
      setSlotUnlockBusy(false);
    }
  };
  const startMissions = async () => {
    const applyPersistedModeToBackend = async () => {
      if (!bridge?.sendCommand) return;
      if (isMissionMode) {
        const resetLevel = String(
          status.currentMissionResetLevel || "6",
        ).trim();
        const levelNumber = Number(resetLevel);
        const safeLevel =
          Number.isFinite(levelNumber) && levelNumber > 0
            ? Math.floor(levelNumber)
            : 6;
        await bridge.sendCommand(`mm ${safeLevel}`);
        return;
      }
      if (resetEnabled) {
        await bridge.sendCommand("mm off");
        await bridge.sendCommand("20r on");
        return;
      }
      await bridge.sendCommand("mm off");
      await bridge.sendCommand("20r off");
    };

    if (!status.running) {
      await bridge.startBackend();
    }
    await applyPersistedModeToBackend();
    await bridge.sendCommand("resume");
  };

  const openSecretModal = async () => {
    setSecretModalOpen(true);
    setSecretModalError(null);
    setSecretModalRevealed(false);
    setSecretCopiedPhraseLabel(null);
    setSecretCopiedAddrLabel(null);
    if (secretModalBackup) return;
    if (!bridge?.revealSignerBackup) {
      setSecretModalError("Secret key view is not available in this build.");
      return;
    }
    setSecretModalBusy(true);
    try {
      const res = await bridge.revealSignerBackup();
      if (!res?.ok) {
        throw new Error(res?.error || "Failed to load recovery phrase.");
      }
      setSecretModalBackup(res.backup || null);
    } catch (e) {
      setSecretModalError(String(e?.message || e));
    } finally {
      setSecretModalBusy(false);
    }
  };

  const openCreateWalletModal = ({ onboarding = false } = {}) => {
    setCreateWalletOpen(true);
    setCreateWalletOnboarding(onboarding);
    setCreateWalletConfirm(false);
    setCreateWalletBusy(false);
    setCreateWalletError(null);
    setCreateWalletResult(null);
    setCreateWalletRevealed(false);
    setCreateCopiedPhraseLabel(null);
    setCreateCopiedAddrLabel(null);
  };

  const runCreateWallet = async () => {
    if (!createWalletOnboarding && !createWalletConfirm) return;
    if (!bridge?.createGeneratedWallet) {
      setCreateWalletError("Wallet creation is not available in this build.");
      return;
    }
    if (!status.running) {
      setCreateWalletError(
        "Wallet creation requires the backend to be running. Start missions first, then try again.",
      );
      return;
    }
    setCreateWalletBusy(true);
    setCreateWalletError(null);
    try {
      const res = await bridge.createGeneratedWallet();
      if (!res?.ok) throw new Error(res?.error || "Wallet creation failed.");
      setCreateWalletResult(res.created || null);
      setCreateWalletRevealed(false);
      await applyConfigPatch({ signerMode: "app_wallet" });
      if (bridge?.refreshWalletSummary) {
        void bridge.refreshWalletSummary();
      }
    } catch (e) {
      setCreateWalletError(String(e?.message || e));
    } finally {
      setCreateWalletBusy(false);
    }
  };

  const toggleOnboardingMission = (name) => {
    const key = String(name || "").trim();
    if (!key) return;
    setOnboardingSelectedMissions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const missionCollectionsLabel = (
    mission,
    catalogLookupByName = null,
    catalogLookupById = null,
  ) => {
    const direct = Array.isArray(mission?.collections)
      ? mission.collections
      : [];
    if (direct.length > 0) return direct.join(", ");
    if (
      catalogLookupById instanceof Map ||
      catalogLookupByName instanceof Map
    ) {
      const idKey = String(
        mission?.catalogMissionId || mission?.missionId || mission?.id || "",
      ).trim();
      const byId =
        idKey && catalogLookupById instanceof Map
          ? catalogLookupById.get(idKey)
          : null;
      const nameKey = missionKey(mission?.name);
      const byName =
        nameKey && catalogLookupByName instanceof Map
          ? catalogLookupByName.get(nameKey)
          : null;
      const fromCatalog = byId || byName || null;
      const values = Array.isArray(fromCatalog?.collections)
        ? fromCatalog.collections
        : [];
      if (values.length > 0) return values.join(", ");
    }
    return "Collection requirements unavailable";
  };
  const normalizeCollectionKey = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 ]/g, "");
  const resolveMissionCollections = (mission) => {
    const toEntry = (entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        const name = entry.trim();
        return name ? { name, image: null } : null;
      }
      const name = String(
        entry?.name || entry?.title || entry?.collection || entry?.symbol || "",
      ).trim();
      if (!name) return null;
      const image = String(
        entry?.image ||
          entry?.imageUrl ||
          entry?.image_url ||
          entry?.logo ||
          "",
      ).trim();
      return { name, image: image || null };
    };
    const direct = Array.isArray(mission?.collections)
      ? mission.collections.map(toEntry).filter(Boolean)
      : [];
    if (direct.length > 0) return direct;
    const idKey = String(
      mission?.catalogMissionId || mission?.missionId || mission?.id || "",
    ).trim();
    const fromId = idKey ? onboardingCatalogById.get(idKey) : null;
    const fromName = onboardingCatalogByName.get(missionKey(mission?.name));
    const fallback = fromId || fromName || null;
    const fallbackCollections = Array.isArray(fallback?.collections)
      ? fallback.collections.map(toEntry).filter(Boolean)
      : [];
    return fallbackCollections;
  };

  const ensureOnboardingAppWallet = async ({
    generateIfMissing = true,
  } = {}) => {
    const signerWallet = String(status.signerWallet || "").trim();
    const fundingAddress = String(
      status.fundingWalletSummary?.address || "",
    ).trim();
    const hasWalletByStatus =
      status.signerStatus === "app_wallet_locked" ||
      status.signerStatus === "app_wallet_unlocked";
    let resolvedAddress = signerWallet || fundingAddress || "";

    if (!resolvedAddress && bridge?.refreshWalletSummary) {
      try {
        const refreshed = await bridge.refreshWalletSummary();
        const refreshedAddress = String(
          refreshed?.fundingWalletSummary?.address || refreshed?.walletId || "",
        ).trim();
        if (refreshedAddress) resolvedAddress = refreshedAddress;
      } catch {}
    }

    const hasWallet = Boolean(
      resolvedAddress || onboardingAppWalletAddress || hasWalletByStatus,
    );
    if (hasWallet) {
      setOnboardingAppWalletAddress(
        resolvedAddress || onboardingAppWalletAddress,
      );
      setOnboardingAppWalletError(null);
      return true;
    }

    if (!generateIfMissing) return false;
    if (!bridge?.createGeneratedWallet) {
      setOnboardingAppWalletError(
        "Wallet creation is not available in this build.",
      );
      return false;
    }

    setOnboardingBusy(true);
    setOnboardingAppWalletBusy(true);
    setOnboardingAppWalletError(null);
    try {
      if (!status.running && bridge?.startBackend) {
        await bridge.startBackend();
      }
      const created = await bridge.createGeneratedWallet();
      if (!created?.ok) {
        throw new Error(created?.error || "Wallet creation failed.");
      }
      const walletAddress = String(
        created?.created?.walletAddress || "",
      ).trim();
      if (walletAddress) setOnboardingAppWalletAddress(walletAddress);
      if (bridge?.refreshWalletSummary) {
        void bridge.refreshWalletSummary();
      }
      return true;
    } catch (error) {
      setOnboardingAppWalletError(String(error?.message || error));
      return false;
    } finally {
      setOnboardingBusy(false);
      setOnboardingAppWalletBusy(false);
    }
  };

  const continueOnboarding = async () => {
    if (onboardingStep === 1) {
      const selectedMode = String(onboardingSignerMode || "").trim();
      if (!selectedMode) {
        setOnboardingError("Select a funding type to continue.");
        return;
      }
      if (selectedMode === "app_wallet") {
        const ok = await ensureOnboardingAppWallet({ generateIfMissing: true });
        if (!ok) return;
      }
    }
    if (onboardingPreviewOnly) {
      if (onboardingStep === 1) {
        setOnboardingWhoami(null);
        setOnboardingMissions([]);
        setOnboardingMissionCatalog([]);
        setOnboardingOwnedCollections(new Set());
        setOnboardingSelectedMissions(new Set());
        setOnboardingStep(2);
      }
      if (onboardingStep === 1 || onboardingStep === 2) {
        if (!bridge?.fetchOnboardingAccount) {
          setOnboardingError(
            "Onboarding fetch is not available in this build.",
          );
          return;
        }
        setOnboardingBusy(true);
        setOnboardingDataLoading(true);
        setOnboardingError(null);
        try {
          const response = await Promise.race([
            bridge.fetchOnboardingAccount(),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Step 2 timed out. Please retry.")),
                45000,
              ),
            ),
          ]);
          if (!response?.ok) {
            throw new Error(response?.error || "Failed to load account info.");
          }
          const missions = Array.isArray(response.missions)
            ? response.missions
            : [];
          const catalog = Array.isArray(response.missionCatalog)
            ? response.missionCatalog
            : [];
          const seeded = new Set(
            missions
              .map((mission) => String(mission?.name || "").trim())
              .filter(Boolean),
          );
          setOnboardingWhoami(response.whoami || null);
          setOnboardingMissions(missions);
          setOnboardingMissionCatalog(catalog);
          setOnboardingOwnedCollections(
            new Set(
              (Array.isArray(response.ownedCollections)
                ? response.ownedCollections
                : []
              )
                .map((entry) => normalizeCollectionKey(entry))
                .filter(Boolean),
            ),
          );
          setOnboardingSelectedMissions(seeded);
          setOnboardingStep(2);
        } catch (error) {
          setOnboardingError(String(error?.message || error));
          setOnboardingStep(2);
        } finally {
          setOnboardingBusy(false);
          setOnboardingDataLoading(false);
        }
      }
      return;
    }
    if (!bridge?.fetchOnboardingAccount) {
      setOnboardingError("Onboarding fetch is not available in this build.");
      return;
    }
    setOnboardingWhoami(null);
    setOnboardingMissions([]);
    setOnboardingMissionCatalog([]);
    setOnboardingOwnedCollections(new Set());
    setOnboardingSelectedMissions(new Set());
    setOnboardingStep(2);
    setOnboardingBusy(true);
    setOnboardingDataLoading(true);
    setOnboardingError(null);
    try {
      const response = await Promise.race([
        bridge.fetchOnboardingAccount(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Step 2 timed out. Please retry.")),
            45000,
          ),
        ),
      ]);
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to load account info.");
      }
      const missions = Array.isArray(response.missions)
        ? response.missions
        : [];
      const catalog = Array.isArray(response.missionCatalog)
        ? response.missionCatalog
        : [];
      const seeded = new Set(
        missions
          .map((mission) => String(mission?.name || "").trim())
          .filter(Boolean),
      );
      setOnboardingWhoami(response.whoami || null);
      setOnboardingMissions(missions);
      setOnboardingMissionCatalog(catalog);
      setOnboardingOwnedCollections(
        new Set(
          (Array.isArray(response.ownedCollections)
            ? response.ownedCollections
            : []
          )
            .map((entry) => normalizeCollectionKey(entry))
            .filter(Boolean),
        ),
      );
      setOnboardingSelectedMissions(seeded);
      setOnboardingStep(2);
    } catch (error) {
      setOnboardingError(String(error?.message || error));
      setOnboardingStep(2);
    } finally {
      setOnboardingBusy(false);
      setOnboardingDataLoading(false);
    }
  };

  const applyOnboarding = async () => {
    if (onboardingPreviewOnly) {
      setOnboardingOpen(false);
      return;
    }
    const selectedMissionNames = Array.from(onboardingSelectedMissions)
      .map((name) => String(name || "").trim())
      .filter(Boolean);
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      await applyConfigPatch({
        signerMode: onboardingSignerMode,
        targetMissions:
          selectedMissionNames.length > 0 ? selectedMissionNames : undefined,
        firstRunOnboardingCompleted: true,
      });
      if (bridge?.applyOnboardingSelection) {
        const response = await bridge.applyOnboardingSelection({
          signerMode: onboardingSignerMode,
          targetMissions:
            selectedMissionNames.length > 0 ? selectedMissionNames : undefined,
        });
        if (!response?.ok) {
          throw new Error(response?.error || "Failed to apply onboarding.");
        }
      }
      setOnboardingOpen(false);
    } catch (error) {
      setOnboardingError(String(error?.message || error));
    } finally {
      setOnboardingBusy(false);
    }
  };

  return (
    <main className="shell">
      <WindowChrome
        title="missions-v3-mcp"
        subtitle="vibed by a tiny giraffe"
        styling="min-w-full"
      />

      <div className="flex gap-0 w-full h-full" id="main-window">
        {" "}
        <NavMain
          onOpenCli={openCliWindow}
          onNavigate={setCurrentPage}
          currentPage={currentPage}
          isCliActive={isCliActive || status.cliWindowOpen === true}
        />
        <div className="main-wrapper  h-full">
          <HeaderUser
            lockLabel={lockLabel}
            status={status}
            debug={debug}
            isAuthenticated={status.isAuthenticated}
            manualCheckBusy={manualCheckBusy}
            onManualClaim={() => {
              if (!status.running) return;
              setManualCheckBusy(true);
              bridge?.sendCommand?.("c");
            }}
          />
          {currentPage === "settings" ? (
            <SettingsPage
              fundingEnabled={fundingEnabled}
              fundingSource={fundingSource}
              setFundingSource={setFundingSource}
              setSignerMode={setSignerMode}
              appWalletAddress={appWalletAddress}
              copyText={copyText}
              setCopiedLabel={setCopiedLabel}
              openExternalUrl={openExternalUrl}
              lockLabel={lockLabel}
              fundingWalletSummary={fundingWalletSummary}
              SlideNumberFormatted={SlideNumberFormatted}
              openSecretModal={openSecretModal}
              openCreateWalletModal={openCreateWalletModal}
            />
          ) : null}
          {onboardingOpen ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
            >
              <div
                className="p-4  w-full rounded-xl shadow-2xl shadow-black/95 space-y-4 z-10 border-2 border-[#1D1C27]  transition-all duration-250 ease-out"
                style={{
                  maxWidth: onboardingStep === 2 ? "680px" : "680px",
                  backgroundImage: `url(${backImg})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold">
                    {onboardingStep == 2
                      ? "Assigned Mission Setup"
                      : "Funding Source Setup"}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-xs text-slate-400">
                      Step {onboardingStep}/2
                    </div>
                    <button
                      type="button"
                      className="btn btn-clear btn-sm "
                      onClick={() => setOnboardingOpen(false)}
                      title="Close"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div
                  className="overflow-hidden transition-[height] duration-250 ease-out"
                  style={{
                    height:
                      onboardingBodyHeight == null
                        ? "auto"
                        : `${onboardingBodyHeight}px`,
                  }}
                >
                  <div ref={onboardingBodyRef} className="space-y-3">
                    {onboardingStep === 1 ? (
                      <div className="space-y-4">
                        <div className="text-sm text-slate-300">
                          Choose wallet funding type.
                        </div>
                        <div className="signer-type flex-col">
                          {[
                            [
                              "app_wallet",
                              "App Wallet",
                              "A dedicated, self-custodial in-app burner wallet for automated signing.",
                            ],

                            [
                              "dapp",
                              "Browse Wallet",
                              "You must approve each transaction in your browser when the browser window opens.",
                            ],
                            [
                              "manual",
                              "Manual",
                              "A browser window will open for you to mauanlly reset.",
                            ],
                          ].map(([value, title, desc]) => (
                            <label
                              key={value}
                              className="signer-type__app items-start"
                            >
                              <input
                                type="radio"
                                name="onboarding_signer_mode"
                                value={value}
                                className="fake-checkbox-radio"
                                checked={onboardingSignerMode === value}
                                onChange={() => {
                                  setOnboardingSignerMode(value);
                                  setOnboardingError(null);
                                  if (value === "app_wallet") {
                                    void ensureOnboardingAppWallet({
                                      generateIfMissing: true,
                                    });
                                  } else {
                                    setOnboardingAppWalletError(null);
                                    setOnboardingAppWalletAddress("");
                                  }
                                }}
                              />
                              <div className="space-y-1 w-full">
                                <div className="flex gap-2 items-center w-full justify-between">
                                  <div className="text-base text-white">
                                    {title}
                                  </div>
                                  {value === "app_wallet" ? (
                                    <span className="badge h-min uppercase border-transparent bg-white text-black text-[11px] place-self-center ">
                                      Full Automation
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-xs text-slate-300">
                                  {desc}
                                </div>
                                {value === "app_wallet" ? (
                                  <div className="flex font-semibold gap-2 mt-3  text-slate-300">
                                    <img
                                      src={solIcon}
                                      className="w-4 h-4"
                                      alt="Solana logo"
                                    />{" "}
                                    Requires PBP & small SOL amount for
                                    transactions. Address found in settings.
                                  </div>
                                ) : null}
                                {value === "app_wallet" &&
                                onboardingSignerMode === "app_wallet" ? (
                                  <div className="rounded-md border border-white/10 bg-black/30 p-3 space-y-0.5 mt-2">
                                    <div className="text-xs text-slate-300">
                                      {onboardingAppWalletBusy
                                        ? "Generating app wallet..."
                                        : onboardingAppWalletAddress
                                          ? "Wallet Address"
                                          : "Wallet will be generated when you continue."}
                                    </div>
                                    {onboardingAppWalletAddress ? (
                                      <div className="flex items-center gap-4 flex-wrap">
                                        <div className="text-sm text-slate-100 break-all">
                                          {onboardingAppWalletAddress}
                                        </div>
                                        <button
                                          type="button"
                                          className="fill-white flex items-center gap-1 font-normal text-xs px-0 py-0 h-min btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                                          onClick={() => {
                                            const value =
                                              onboardingAppWalletAddress;
                                            if (!value) return;
                                            void copyText(value).then((ok) => {
                                              setCopiedLabel(
                                                ok ? "Copied" : "Copy failed",
                                              );
                                              setTimeout(
                                                () => setCopiedLabel(null),
                                                1200,
                                              );
                                            });
                                          }}
                                        >
                                          <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            viewBox="0 0 640 640"
                                            className="w-4 h-4"
                                          >
                                            <path d="M352 544L128 544C110.3 544 96 529.7 96 512L96 288C96 270.3 110.3 256 128 256L176 256L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L384 464L384 512C384 529.7 369.7 544 352 544zM288 384C270.3 384 256 369.7 256 352L256 128C256 110.3 270.3 96 288 96L512 96C529.7 96 544 110.3 544 128L544 352C544 369.7 529.7 384 512 384L288 384zM224 352C224 387.3 252.7 416 288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352z" />
                                          </svg>
                                          Copy
                                        </button>
                                      </div>
                                    ) : null}
                                    <div className="text-[11px] text-slate-400">
                                      Recovery keys are available in Settings.
                                    </div>
                                    {onboardingAppWalletError ? (
                                      <div className="text-xs text-error">
                                        {onboardingAppWalletError}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </label>
                          ))}
                        </div>

                        <div className="flex justify-end">
                          <button
                            type="button"
                            className="btn btn-gradient btn-sm text-shadow-sm text-shadow-black/40"
                            onClick={() => void continueOnboarding()}
                            disabled={
                              onboardingBusy ||
                              !String(onboardingSignerMode || "").trim()
                            }
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {onboardingStep === 2 ? (
                      <div className="space-y-4">
                        <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-slate-200 flex gap-2">
                          <div>
                            Make sure these are the active you to watch and they
                            are assigned. If not, change them on the{" "}
                            <a
                              href="https://www.pixelbypixel.studio"
                              className="text-accent underline"
                              onClick={(event) => {
                                event.preventDefault();
                                void openExternalUrl(
                                  "https://www.pixelbypixel.studio",
                                );
                              }}
                            >
                              Pixel by Pixel Studios Missions Page
                            </a>
                            , then click{" "}
                            <span className="font-semibold">
                              Refresh mission status
                            </span>{" "}
                            before clicking done .
                          </div>
                        </div>

                        <div className="grid grid-cols-4 gap-2">
                          {[1, 2, 3, 4].map((slot) => {
                            const assigned =
                              onboardingMissions.find(
                                (m) => Number(m?.slot) === slot,
                              ) || null;
                            const imgSrc = assigned
                              ? pickSlotImage(assigned)
                              : null;
                            const loadingSlot =
                              onboardingDataLoading ||
                              (!assigned && onboardingMissions.length === 0);
                            return (
                              <div
                                key={`onboarding-slot-${slot}`}
                                className="rounded-md border-2 border-white/10 bg-black/20 p-3 h-full flex flex-col gap-2"
                              >
                                <div className="flex gap flex-row justify-between items-center">
                                  <div className="text-[11px] text-slate-400">
                                    {assigned?.currentLevel !== null &&
                                    assigned?.currentLevel !== undefined
                                      ? `Level ${assigned.currentLevel}`
                                      : "Level —"}
                                  </div>
                                  <div
                                    className={`${assigned && assigned.isActive ? "badge badge-success" : ""} px-2 h-auto text-[11px] text-slate-900`}
                                  >
                                    {assigned
                                      ? assigned.isActive
                                        ? "Active"
                                        : "Assigned"
                                      : "No NFT"}
                                  </div>
                                </div>
                                {loadingSlot ? (
                                  <div className="grid place-items-center flex-1">
                                    <span className="loading loading-spinner loading-sm text-success" />
                                  </div>
                                ) : (
                                  <div className="flex flex-col flex-1">
                                    <div className="text-sm text-slate-100 ">
                                      {assigned?.name || "Unassigned"}
                                    </div>

                                    <div className="flex text-[11px] text-slate-300 mt-auto">
                                      {assigned?.reward || "Reward unknown"}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex justify-between">
                          <button
                            type="button"
                            className="btn btn-clear btn-sm px-0"
                            onClick={() => setOnboardingStep(1)}
                            disabled={onboardingBusy}
                          >
                            Back
                          </button>
                          <div class="flex gap-2">
                            <button
                              type="button"
                              className="btn btn-clear btn-sm"
                              onClick={() => void continueOnboarding()}
                              disabled={onboardingBusy || onboardingDataLoading}
                            >
                              <span className="inline-flex items-center gap-1.5">
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  viewBox="0 0 640 640"
                                  className={`w-4 h-4 ${onboardingDataLoading ? "animate-spin" : ""}`}
                                  fill="currentColor"
                                  aria-hidden="true"
                                >
                                  <path d="M320 96c123.7 0 224 100.3 224 224s-100.3 224-224 224S96 443.7 96 320c0-34.1 7.6-66.5 21.3-95.5l44.9 22.4C151.2 268 144 293.4 144 320c0 97.2 78.8 176 176 176s176-78.8 176-176S417.2 144 320 144c-47.4 0-90.4 18.7-122.1 49.2l58.1 58.1L112 304V160l51.8 51.8C203.2 163.2 258.3 96 320 96z" />
                                </svg>
                                <span>
                                  {onboardingDataLoading
                                    ? "Refreshing..."
                                    : "Refresh mission status"}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className="btn btn-gradient btn-sm text-shadow-sm text-shadow-black/40"
                              onClick={() => void applyOnboarding()}
                              disabled={onboardingBusy}
                            >
                              {onboardingPreviewOnly
                                ? "Done"
                                : onboardingBusy
                                  ? "Applying..."
                                  : "Apply"}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {onboardingError ? (
                      <div className="rounded-md border border-error/40 bg-error/10 p-2 text-sm text-slate-100">
                        {onboardingError}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {secretModalOpen ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setSecretModalOpen(false);
              }}
            >
              <div className="card w-full max-w-140 space-y-4 !bg-[#0b1116] border border-white/10 z-10">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold">Recovery Phrase</div>
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setSecretModalOpen(false)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-xs text-slate-300">
                  Anyone with this phrase can drain the wallet. Only reveal it
                  if you are alone and you trust your screen recording setup.
                </div>

                {secretModalError ? (
                  <div className="text-sm text-error">{secretModalError}</div>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase text-slate-300">
                      Phrase
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn btn-clear btn-xs"
                        onClick={() => setSecretModalRevealed((v) => !v)}
                        disabled={secretModalBusy}
                        title={secretModalRevealed ? "Hide" : "Reveal"}
                      >
                        {secretModalRevealed ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 640 640"
                            className="w-4 h-4"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="M320 224c-53 0-96 43-96 96s43 96 96 96 96-43 96-96-43-96-96-96zm0 48c26.5 0 48 21.5 48 48s-21.5 48-48 48-48-21.5-48-48 21.5-48 48-48z" />
                            <path d="M320 144C199.6 144 108.8 214.9 64 320c44.8 105.1 135.6 176 256 176s211.2-70.9 256-176c-44.8-105.1-135.6-176-256-176zm0 304c-93.9 0-169.9-52.3-210.7-128C150.1 244.3 226.1 192 320 192s169.9 52.3 210.7 128C489.9 395.7 413.9 448 320 448z" />
                            <path d="M120 520l400-400 34 34-400 400-34-34z" />
                          </svg>
                        ) : (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 640 640"
                            className="w-4 h-4"
                            fill="currentColor"
                            aria-hidden="true"
                          >
                            <path d="M320 224c-53 0-96 43-96 96s43 96 96 96 96-43 96-96-43-96-96-96zm0 48c26.5 0 48 21.5 48 48s-21.5 48-48 48-48-21.5-48-48 21.5-48 48-48z" />
                            <path d="M320 144C199.6 144 108.8 214.9 64 320c44.8 105.1 135.6 176 256 176s211.2-70.9 256-176c-44.8-105.1-135.6-176-256-176zm0 304c-93.9 0-169.9-52.3-210.7-128C150.1 244.3 226.1 192 320 192s169.9 52.3 210.7 128C489.9 395.7 413.9 448 320 448z" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                        disabled={
                          secretModalBusy ||
                          !secretModalBackup?.mnemonic ||
                          !secretModalRevealed
                        }
                        onClick={() => {
                          void copyText(secretModalBackup?.mnemonic || "").then(
                            (ok) => {
                              setSecretCopiedPhraseLabel(
                                ok ? "Copied" : "Copy failed",
                              );
                              setTimeout(
                                () => setSecretCopiedPhraseLabel(null),
                                1200,
                              );
                            },
                          );
                        }}
                        title="Copy (requires reveal)"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 640 640"
                          className="w-4 h-4"
                        >
                          <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                        </svg>
                        {secretCopiedPhraseLabel || "Copy"}
                      </button>
                    </div>
                  </div>
                  <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-relaxed">
                    {secretModalBusy ? (
                      <span className="text-slate-400">Loading…</span>
                    ) : secretModalBackup?.mnemonic ? (
                      secretModalRevealed ? (
                        <span className="select-text font-mono">
                          {secretModalBackup.mnemonic}
                        </span>
                      ) : (
                        <span className="text-slate-400">
                          Hidden. Click the eye icon to reveal.
                        </span>
                      )
                    ) : (
                      <span className="text-slate-400">
                        No recovery phrase backup is available for this wallet.
                      </span>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs uppercase text-slate-300">
                    Address
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm">
                    <span className="truncate">
                      {secretModalBackup?.walletAddress || "—"}
                    </span>
                    <button
                      type="button"
                      className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                      onClick={() =>
                        void copyText(
                          secretModalBackup?.walletAddress || "",
                        ).then((ok) => {
                          setSecretCopiedAddrLabel(
                            ok ? "Copied" : "Copy failed",
                          );
                          setTimeout(
                            () => setSecretCopiedAddrLabel(null),
                            1200,
                          );
                        })
                      }
                      disabled={!secretModalBackup?.walletAddress}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 640 640"
                        className="w-4 h-4"
                      >
                        <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                      </svg>
                      {secretCopiedAddrLabel || "Copy"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          {createWalletOpen ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setCreateWalletOpen(false);
              }}
            >
              <div className="card w-full max-w-150 space-y-4 !bg-[#0b1116] border border-white/10 z-10">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold">
                    Generate New App Wallet
                  </div>
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setCreateWalletOpen(false)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>

                {createWalletResult ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-10 h-10 rounded-full bg-success/20 border border-success/60 grid place-items-center">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 640 640"
                        className="w-5 h-5 text-success"
                        fill="currentColor"
                      >
                        <path d="M256 416.6L163.3 323.9L129.4 357.8L256 484.4L510.6 229.8L476.7 195.9L256 416.6z" />
                      </svg>
                    </div>
                    <div className="text-sm text-slate-200">
                      Wallet created successfully.
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-300">
                    {createWalletOnboarding
                      ? "No app-wallet is configured yet. Generate one now to enable app-wallet mode."
                      : "This replaces your current app-wallet in the app. Save the recovery phrase immediately."}
                  </div>
                )}

                {createWalletError ? (
                  <div className="text-sm text-error">{createWalletError}</div>
                ) : null}

                {!createWalletResult && !createWalletOnboarding ? (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={createWalletConfirm}
                      onChange={(e) => setCreateWalletConfirm(e.target.checked)}
                      disabled={createWalletBusy}
                    />
                    <span>
                      I understand this will replace the current app-wallet and
                      I must save the recovery phrase now.
                    </span>
                  </label>
                ) : null}

                {createWalletResult ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs uppercase text-slate-300">
                          Recovery Phrase
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-clear btn-xs"
                            onClick={() => setCreateWalletRevealed((v) => !v)}
                            title={createWalletRevealed ? "Hide" : "Reveal"}
                          >
                            {createWalletRevealed ? "Hide" : "Reveal"}
                          </button>
                          <button
                            type="button"
                            className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                            disabled={!createWalletRevealed}
                            onClick={() => {
                              void copyText(
                                createWalletResult?.mnemonic || "",
                              ).then((ok) => {
                                setCreateCopiedPhraseLabel(
                                  ok ? "Copied" : "Copy failed",
                                );
                                setTimeout(
                                  () => setCreateCopiedPhraseLabel(null),
                                  1200,
                                );
                              });
                            }}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 640 640"
                              className="w-4 h-4"
                            >
                              <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                            </svg>
                            {createCopiedPhraseLabel || "Copy"}
                          </button>
                        </div>
                      </div>
                      <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm leading-relaxed">
                        {createWalletRevealed ? (
                          <span className="select-text font-mono">
                            {createWalletResult?.mnemonic || "—"}
                          </span>
                        ) : (
                          <span className="text-slate-400">
                            Hidden. Click Reveal.
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs uppercase text-slate-300">
                        Address
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm">
                        <span className="truncate">
                          {createWalletResult?.walletAddress || "—"}
                        </span>
                        <button
                          type="button"
                          className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                          onClick={() =>
                            void copyText(
                              createWalletResult?.walletAddress || "",
                            ).then((ok) => {
                              setCreateCopiedAddrLabel(
                                ok ? "Copied" : "Copy failed",
                              );
                              setTimeout(
                                () => setCreateCopiedAddrLabel(null),
                                1200,
                              );
                            })
                          }
                          disabled={!createWalletResult?.walletAddress}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 640 640"
                            className="w-4 h-4"
                          >
                            <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                          </svg>
                          {createCopiedAddrLabel || "Copy"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className="flex items-center justify-end gap-2 pt-2">
                  {!createWalletResult ? (
                    <button
                      type="button"
                      className="btn btn-gradient"
                      disabled={
                        createWalletBusy ||
                        (!createWalletOnboarding && !createWalletConfirm)
                      }
                      onClick={() => void runCreateWallet()}
                    >
                      {createWalletBusy ? "Generating..." : "Generate Wallet"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-clear"
                      onClick={() => setCreateWalletOpen(false)}
                    >
                      Close
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          {currentPage === "mish_tish" ? (
            <CompetitionPage
              latestCompetition={latestCompetition}
              latestCompetitionBusy={latestCompetitionBusy}
              latestCompetitionError={latestCompetitionError}
              refreshLatestCompetition={refreshLatestCompetition}
              isCurrentCompetitionRow={isCurrentCompetitionRow}
            />
          ) : null}
          {currentPage !== "missions" ? null : (
            <>
              <div className="space-y-1.5">
                <section className="card grid grid-cols-2 gap-4">
                  <div className="space-y-3 w-full ">
                    {" "}
                    <div className="status-row text-2xl flex items-center gap-2">
                      <span>{mainStatusLabel}</span>
                      {status.running ? (
                        <span className="loading loading-spinner loading-sm text-success" />
                      ) : null}
                    </div>
                    <div className="action-row flex w-full">
                      <button
                        className={`active:scale-98  rounded-[10px] text-lg font-normal px-5 py-1 flex h-auto text-white btn btn-gradient w-full border-0 text-shadow-md text-shadow-black/30 shadow-md shadow-black/30 ${status.running ? "active" : ""}`}
                        onClick={() =>
                          status.running
                            ? bridge.stopBackend()
                            : void startMissions()
                        }
                      >
                        {!status.running
                          ? "Start Missioninginginging"
                          : "Press to stop"}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-center">
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-base ">
                      <div className="w-full col-span-2 text-sm">Session</div>
                      <div>
                        🎯{" "}
                        <strong>
                          <SlideNumber value={missionStats.active || 0} />
                        </strong>{" "}
                        Active
                      </div>
                      <div>
                        💎{" "}
                        <strong>
                          <SlideNumber
                            value={missionStats.nftsAvailable || 0}
                          />
                        </strong>{" "}
                        NFTs
                      </div>
                      <div>
                        🥞{" "}
                        <strong>
                          <SlideNumber value={missionStats.claimable || 0} />
                        </strong>{" "}
                        Claimable
                      </div>
                      <div>
                        🤑{" "}
                        <strong>
                          <SlideNumber value={missionStats.claimed || 0} />
                        </strong>{" "}
                        Claimed
                      </div>
                    </div>
                  </div>
                </section>

                <section className="card grid grid-cols-[auto_min-content] gap-2 items-center !py-0.5">
                  <div
                    className={`text-xs w-full truncate ${
                      latestLog?.stream === "stderr"
                        ? "text-red-300"
                        : latestLog?.stream === "stdin"
                          ? "text-sky-300"
                          : "text-slate-300"
                    }`}
                  >
                    {latestLog ? latestLog.text : "No backend output yet."}
                  </div>
                  <button
                    className="btn btn-clear btn-sm uppercase !tracking-wider font-light 
             text-slate-300 flex gap-1 w-min p-0"
                    onClick={openCliWindow}
                    type="button"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 640 640"
                      className="w-4 h-4"
                      fill="currentColor"
                    >
                      <path d="M68.8 155.3L57.5 144L80.1 121.4L91.4 132.7L267.4 308.7L278.8 320L267.4 331.3L91.4 507.3L80.1 518.6L57.5 496L68.8 484.7L233.5 320L68.8 155.3zM272.1 480L576.1 480L576.1 512L256.1 512L256.1 480L272.1 480z" />
                    </svg>
                    Logs
                  </button>
                </section>
              </div>

              <section className="">
                <div className="grid grid-cols-2 gap-2 ">
                  <div className="grid grid-cols-2 gap-2 mission-modes h-54">
                    <button
                      className={`h-full card items-center justify-center transition-all ${isNormalMode ? "active" : ""}`}
                      onClick={() => void activateNormalMode()}
                      type="button"
                    >
                      <div className="space-y-2">
                        <div className="z-10 mode__name font-bold text-2xl leading-7">
                          Normal Mode
                        </div>
                        <div className="text-xs">
                          Resets level 20. Can be toggled.
                        </div>
                      </div>
                    </button>
                    <button
                      className={`h-full card @container items-center justify-center overflow-hidden transition-all ${isMissionMode ? "active" : ""}`}
                      onClick={() => void activateMissionMode()}
                      type="button"
                      id="mission-mode-mm_button"
                    >
                      {" "}
                      <div className="space-y-2">
                        <div className="z-10 mode__name font-bold text-2xl leading-7">
                          Mission Mode
                        </div>
                        <div className="text-xs">
                          Resets level 11. Cannot be toggled.
                        </div>
                      </div>
                      <div class="mo-fire">
                        <svg
                          version="1.1"
                          id="Layer_1"
                          xmlns="http://www.w3.org/2000/svg"
                          xmlns:xlink="http://www.w3.org/1999/xlink"
                          x="0px"
                          y="0px"
                          width="1016px"
                          height="493px"
                          viewBox="0 0 1016 493"
                          enable-background="new 0 0 1016 493"
                          xml:space="preserve"
                        >
                          <g>
                            <path
                              class="flame"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M260.138,279.034c0.329,2.103,0.929,3.955,3.466,1.591
        c1.36-1.269,2.555-2.34,2.946-4.48c0.611-3.344,1.288-6.88,4.965-9.637C262.791,267.109,258.981,271.64,260.138,279.034z"
                            />
                            <path
                              class="flame one"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M642.133,261.121c-0.602,1.805,2.854,4.751,5.137,4.486
        c2.775-0.322,5.049-1.429,4.986-4.831c-0.051-2.835-2.447-5.298-5.188-5.287C643.428,255.591,642.939,258.697,642.133,261.121z"
                            />
                            <path
                              class="flame two"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M236.169,192.895c2.469-0.638,4.981-0.998,4.781-3.98
        c-0.117-1.744-0.676-3.642-3.098-3.758c-2.766-0.133-4.256,1.769-4.511,3.915C233.163,190.574,234.413,192.402,236.169,192.895z"
                            />
                            <path
                              class="flame"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M394.363,104.625c2.114,0.205,3.56-0.855,3.625-2.719
        c0.057-1.631-1.206-2.715-3.106-2.809c-1.935-0.095-2.961,0.578-3.069,2.6C391.708,103.615,392.298,104.781,394.363,104.625z"
                            />
                            <path
                              class="flame one"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M257.108,216.734c1.575,0.05,2.945-0.246,2.794-2.009
        c-0.133-1.558-1.21-2.582-2.89-2.516c-1.492,0.059-2.595,1.087-2.394,2.435C254.774,215.686,255.437,217.224,257.108,216.734z"
                            />
                            <path
                              class="flame two"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#F58553"
                              d="M73.648,152.806c1.225,0.057,1.942-0.5,2.374-1.896
        c-0.912-0.418-0.55-1.965-2.227-2.114c-1.723-0.152-2.062,1.195-2.287,2.05C71.119,152.317,72.336,152.744,73.648,152.806z"
                            />
                          </g>
                          <g>
                            <path
                              class="flame one"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#DF513D"
                              d="M217.934,126.101c-1.167-3.763-2.061-7.788-5.236-11.302
        c0.108,2.457-0.002,4.26-0.827,5.933c-0.684,1.387-0.368,3.43-2.745,3.684c-2.311,0.248-3.482-0.874-4.668-2.691
        c-3.922-6.005-2.688-12.452-1.678-18.786c0.745-4.666,2.17-9.221,3.387-14.22c-9.078,5.882-13.839,18.679-11.527,29.102
        c2.305,10.385,6.331,19.888,12.472,28.634c7.29,10.382,7.329,20.787,0.019,30.697c2.168,0.269,3.337-0.783,4.553-1.723
        c8.892-6.871,10.305-16.748,10.146-26.877C221.712,140.951,220.195,133.394,217.934,126.101z"
                            />
                            <path
                              class="flame one"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#DF513D"
                              d="M537.457,199.138c-3.573,3.704-3.719,8.707-4.095,13.078
        c-0.443,5.159,2.751,9.729,6.305,13.933c1.678-4.575,1.526-8.778-0.152-13.235C537.881,208.579,536.785,203.986,537.457,199.138z"
                            />
                            <path
                              class="flame two"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#DF513D"
                              d="M790.553,136.011c-1.086-0.688-1.059,0.386-1.111,0.802
        c-0.26,2.063-1.121,4.191,0.15,6.185c2.043,3.204,3.762,6.5,3.252,11.266c3.506-3.165,4.613-6.646,4.301-10.125
        C796.799,140.311,793.68,137.989,790.553,136.011z"
                            />
                            <path
                              class="flame one"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#DF513D"
                              d="M939.061,13.063c-2.963-0.039-4.814,2.08-4.898,5.601
        c-0.365,3.134,2.238,3.978,4.217,4.556c2.504,0.733,5.953-2.514,5.951-5.005C944.33,15.513,941.861,13.101,939.061,13.063z"
                            />
                            <path
                              class="flame"
                              fill-rule="evenodd"
                              clip-rule="evenodd"
                              fill="#DF513D"
                              d="M553.012,173.176c-5.986,4.961-6.033,6.817-1.004,11.31
        C555.391,181.12,551.922,177.398,553.012,173.176z"
                            />
                          </g>
                          <path
                            class="flame-main one"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                            fill="#DF513D"
                            d="M855.631,466.945C944.262,471.891,972,449.18,972,449.18
    C1027,321.359,944.33,235,944.33,235c-25.416-5.286-45.699-63.5-49.117-88.546c-1.01-7.383,0.025-15.348,1.727-22.938
    c4.066-18.146,11.555-34.489,25.205-47.463c6.234-5.924,13.301-10.446,23.752-8.588c-14.379-8.771-28.559-10.971-43.646-6.452
    c-13.455,4.031-24.506,11.925-34.635,21.463c-10.742,10.116-19.926,21.219-25.68,34.991c-2.672,6.39-4.943,12.996-5.521,19.735
    c-0.764,8.926-0.973,18.003,0.777,26.961c1.719,8.808,4.424,17.371,8.691,25.153c5.264,9.596,10.76,18.952,14.289,29.435
    c3.588,10.658,5.154,21.481,3.627,32.481c-1.809,13.028-7.438,24.381-17.133,33.622c-7.992,7.619-16.848,7.064-23.23-1.906
    c-2.838-3.988-4.801-8.185-5.996-13.175c-2.541-10.627-1.035-20.107,5.604-28.506c7.814-9.888,11.92-20.496,9.221-33.241
    c-2.605-12.3-14.936-23.608-25.422-24.022c4.357,3.514,10.586,11.164,13.289,16.328c4.455,8.511,3.699,18.335-3.877,25.045
    c-5.648,5.003-10.664,10.654-14.902,17.021c-3.209,4.823-6.195,9.681-7.303,15.373c-0.564,2.904-0.221,5.978-0.387,8.969
    c-0.057,1.005,0.322,2.667-1.828,1.731c-5.561-2.418-9.982-6.14-10.158-14.216c-0.094-4.266,2.254-7.965,2.404-12.128
    c0.379-10.409-8.141-20.954-19.229-22.816c-10.182-1.711-18.287,2.746-23.861,14.147c2.469-0.808,4.727-1.556,6.992-2.286
    c2.447-0.789,4.965-0.24,7.432-0.234c7.539,0.02,14.816,8.159,13.32,16.086c-1.266,6.717-4.697,12.408-7.08,18.555
    c-4.266,10.991-10.574,21.106-14.582,32.256c-4.201,11.694-7.123,23.498-4.744,36.104c0.408,2.16,2.133,4.087,1.367,7.061
    c-7.738-8.408-16.045-15.436-25.604-20.918c-8.41-4.82-17.121-8.909-26.645-10.926c-2.17-0.459-3.08-1.602-3.496-3.445
    c-0.963-4.267-3.477-7.051-7.836-7.607c-4.699-0.601-7.273,2.641-9.066,6.234c-1.064,2.138-2.082,2.248-4.195,1.928
    c-15.563-2.355-27.02-11.037-35.943-23.396c-11.643-16.123-16.396-34.125-14.266-54.008c1.791-16.705,8.824-30.894,19.84-43.279
    c11.209-12.603,25.119-21.442,40.432-28.448c-0.35-0.178-0.529-0.323-0.73-0.361c-0.254-0.047-0.531-0.042-0.787,0.002
    c-19.779,3.385-45.439,14.517-59.5,31.411c-0.166,0.201-0.363,0.377-0.549,0.564c-4.191,4.213-7.574,9.034-10.373,14.242
    c-5.674,10.557-8.674,21.895-10.453,33.734c-1.299,8.649-1.73,17.34-0.422,25.789c1.697,10.957,5.266,21.479,10.924,31.289
    c5.309,9.2,11.873,17.521,17.426,26.535c2.143,3.479,1.92,6.092-1.285,8.326c-1.924,1.344-4.066,2.461-6.248,3.335
    c-6.979,2.798-14.191,2.927-21.504,1.562c-15.086-2.816-26.398-10.412-31.984-25.242c-4.852-12.872-3.498-25.889-0.332-38.765
    c3.709-15.087,9.834-29.463,13.641-44.539c3.434-13.596,6.252-27.32,7.219-41.325c0.73-10.567,0.684-21.164-0.883-31.693
    c-1.055-4.138-0.746-8.691-3.738-12.236c0.002,0,0.003,0.001,0.004,0.002c-0.072-4.321-2.307-7.884-4.096-11.609
    c-3.334-8.141-8.697-14.584-16.004-19.415c2.986,4.352,6.135,8.549,8.773,13.114c0.365,0.634,0.885,2.142,2.361,1.377
    c-0.141,4.219,3.092,7.335,3.691,11.312c-0.203,0.471-0.24,0.865,0.434,0.926c0,0-0.039,0.088-0.039,0.089
    c1.229,7.339,3.654,14.469,3.854,21.993c0.277,7.069-0.301,14.054-1.268,21.083c-1.262,9.162-3.033,18.159-5.955,26.918
    c-2.639,7.904-5.814,15.605-8.836,23.359c-3.461,8.881-7.283,17.65-10.363,26.707c-4.963,14.591-10.781,28.851-14.065,44.032
    c-3.851,17.809-2.452,34.576,6.944,50.396c0.892,1.5,1.322,3.014,1.411,4.791c0.607,12.178-6.601,21.589-20.336,22.445
    c-16.567,1.032-29.487-7.037-33.707-22.111c-2.169-7.747-1.702-15.574-0.003-23.352c3.305-15.127,10.624-28.352,19.604-40.729
    c4.995-6.886,8.435-14.472,9.014-22.863c1.204-17.457-5.281-31.88-19.167-42.561c-5.162-3.97-11.1-6.564-18.131-5.406
    c-11.898,1.959-15.779,14.669-16.513,26.118c1.964-2.698,3.785-5.37,5.781-7.906c3.604-4.581,8.707-5.385,13.817-4.151
    c13.203,3.188,19.3,17.235,12.706,28.876c-2.606,4.6-5.966,8.563-10.19,11.975c-5.143,4.15-9.367,9.452-14.577,13.502
    c-5.938,4.618-11.283,9.875-15.389,15.926c-5.288,7.796-11.634,13.953-20.057,17.894c-7.237,3.384-17.27,4.203-22.724-2.331
    c-4.678-5.603-4.442-12.041-2.223-18.393c6.571-18.801,14.331-37.188,18.802-56.705c2.512-10.964,3.926-22.005,3.771-33.219
    c-0.293-21.134-7.547-39.917-19.95-56.795c-3.735-5.083-7.982-9.791-12.397-15.161c-0.441,3.125,0.279,5.327,0.699,7.361
    c2.643,12.804,3.729,25.771,4.406,38.768c0.407,7.829-0.424,15.631-1.206,23.472c-1.115,11.184-3.351,21.955-7.212,32.455
    c-2.723,7.409-6.812,14.064-11.788,20.079c-4.364,5.276-9.939,9.478-16.148,12.21c-8.284,3.646-17.829-2.003-19.39-11.826
    c-2.665-16.773-0.41-32.809,9.74-47.062c-0.963-0.419-1.715,0.063-2.629,0.779c-7.514,5.889-14.286,12.32-19.609,20.456
    c-9.272,14.171-13.619,29.941-15.935,46.323c-1.771,12.528-3.694,24.94-7.695,36.989c-4.727,14.237-21.139,24.276-35.978,21.826
    c-9.413-1.554-15.849-7.425-20.69-15.005c-14.236-22.295-12.316-45.057-1.232-67.882c4.195-8.637,10.013-16.207,16.315-23.659
    c-12.587-1.713-22.69,2.739-31.15,11.041c-10.202,10.013-14.693,23.224-18.941,36.383c-0.987,3.055-1.763,2.217-3.276,1.01
    c-13.538-10.804-22.13-24.641-25.489-41.673c-0.5-3.099-0.999-6.198-1.498-9.298c0.1-11.729,1.626-23.235,5.648-34.413
    c-1.005,1.916-2.907,2.779-4.039,4.46c-13.677,20.313-16.274,43.052-14.618,66.643c0.372,5.296-0.561,10.181-2.291,14.941
    c-2.936,8.075-8.172,9.575-14.724,4.1c-4.525-3.783-8.732-8.006-12.714-12.367c-11.834-12.958-18.152-28.218-18.812-45.852
    c-0.748-19.978,4.404-38.725,11.956-56.868c8.639-20.756,11.392-41.894,6.258-63.94c-2.858-12.27-8.542-23.307-15.923-33.204
    c-3.85-5.163-8.923-9.78-14.618-13.434c-16.292-10.449-32.993-13.009-50.84-3.433c1.47,1.12,2.801,1.62,4.334,2.034
    c12.039,3.249,22.931,8.94,31.515,17.937c10.389,10.89,12.899,24.402,9.939,38.878c-2.776,13.572-7.482,26.616-12.908,39.293
    c-7.716,18.031-16.924,35.417-22.425,54.384c-2.498,8.614-4.16,17.295-4.617,26.232c-0.038,0.737-0.09,1.806-0.548,2.121
    c-1.022,0.704-1.664-0.424-2.182-1.073c-2.667-3.337-4.792-6.98-6.257-11.027c-5.234-14.466-3.651-28.882,0.609-43.142
    c2.264-7.577,5.338-14.913,8.438-23.433c-4.936,3.301-7.244,7.463-9.685,11.352c-11.064,17.624-13.31,37.145-10.991,57.244
    c1.626,14.097,6.347,27.808,5.391,42.253c-0.504,7.608-0.817,15.015-6.939,21.076c0,0-52.749,96.413-18.563,155.781
    c4.75,8.249,402.17,17.768,402.17,17.768c2.102,0,4.204-0.062,6.304-0.094c8.706-0.004,17.41-0.01,26.113-0.015
    c1.494-0.006,2.987-0.012,4.481-0.017c3.332-1.905,5.942-4.229,7.982-6.894c-2.039,2.664-4.65,4.988-7.981,6.894
    c6.079,0.004,12.159,0.008,18.237,0.011c1.445,0.039,2.889,0.113,4.333,0.114c74.932,0.005,149.866,0.012,224.799-0.001
    c27.342-0.005,54.686-0.057,82.025-0.088c16.762-0.006,53.166,0.087,54.609,0.087 M824.752,226.698c0,0.001,0.001,0.002,0.002,0.002
    c-0.02,0.195-0.037,0.39-0.055,0.584C824.717,227.09,824.734,226.894,824.752,226.698z M574.146,136.221
    c1.001,0.838,1.496,2.265,2.499,3.105C575.644,138.489,575.148,137.061,574.146,136.221z M47.543,347.683L47.543,347.683
    l0.125,0.123C47.618,347.757,47.542,347.682,47.543,347.683z"
                          />
                          <path
                            class="flame-main two"
                            fill="#F26C52"
                            d="M976.667,324.592c1.229,3.776,2.013,7.837,2.314,12.227c0,0,0.169-78.337-70.811-125.496
    c-12.488-10.562-22.174-23.317-29.328-37.979c-5.111-10.474-8.277-21.568-8.316-33.246c-0.061-17.212,5.729-32.611,15.887-46.398
    c4.676-6.347,9.795-12.306,16.17-17.068c0.813-0.606,1.436-1.467,2.709-2.8c-6.471,0.968-11.582,3.497-16.594,6.001
    c-12.121,6.057-21.768,15.038-29.004,26.446c-6.633,10.455-9.918,22.096-10.471,34.407c-0.984,21.887,5.711,41.839,15.961,60.806
    c5.223,9.667,11.035,19.048,12.852,30.185c3.426,20.996,1.273,40.842-11.291,58.79c-8.707,12.435-26.303,19.606-40.416,16.137
    c-9.441-2.322-14.35-9.342-17.363-17.764c-5.699-15.928-4.258-31.144,5.617-45.238c3.137-4.479,6.176-9.028,9.457-13.835
    c-4.576,1.163-16.156,14.673-20.363,23.321c-4.803,9.866-1.631,20.479-2.895,30.676c-10.527-3.265-23.447-14.418-21.99-27.205
    c0.559-4.914,0.131-9.867,1.447-14.806c1.6-5.992-1.145-11.556-6.531-14.658c-3.473-2.001-7.193-3.389-11.336-3.133
    c2.994,1.594,6.342,2.346,8.82,4.939c1.842,1.928,2.898,4.032,2.977,6.617c0.418,13.832-1.627,26.889-8.738,39.294
    c-8.867,15.469-13.41,32.414-12.527,50.462c0.334,6.838,2.555,13.077,7.289,18.236c8.326,9.069,9.984,20.421,5.266,31.396
    c-0.754,1.757-1.402,3.433-3.953,1.573c-11.662-8.503-23.174-17.189-33.09-27.736c-4.387-4.665-8.094-9.967-12.469-14.646
    c-8.01-8.57-18.422-11.793-29.779-13.402c-16.861-2.39-33.697-5.066-47.652-16.334c-9.074-7.328-15.014-16.762-19.492-27.226
    c-5.621-13.131-8.916-26.752-8.33-41.222c0.371-9.153,2.295-17.872,5.559-26.362c0.221-0.573,0.424-1.153,0.846-2.309
    c-2.08,0.743-2.357,2.227-2.844,3.376c-4.656,11.01-8.379,22.354-10.244,34.152c-1.172,7.397-0.301,14.827,1.813,22.155
    c3.832,13.296,10.604,25.058,18.066,36.521c3.5,5.377,7.021,10.748,10.359,16.227c5.326,8.736,2.068,19.219-7.029,24.131
    c-8.594,4.64-17.66,5.329-27.082,4.19c-0.625-0.076-1.277,0.081-1.918,0.13l-1.695-0.031c-4.563-1.718-9.17-3.33-13.684-5.174
    c-18.088-7.387-30.508-23.889-30.627-44.457c-0.076-12.859,3.195-24.85,6.871-36.87c3.832-12.531,7.818-25.016,11.65-37.546
    c0.715-2.342,1.018-4.81,0.652-7.516c-1.91,4.821-3.895,9.615-5.719,14.47c-5.123,13.62-10.459,27.169-15.178,40.93
    c-4.24,12.366-8.473,24.877-8.307,38.179c0.162,12.924,4.285,24.588,11.971,35.119c3.307,4.531,7.906,8.158,9.961,13.563
    c3.859,10.151,1.246,19.344-4.648,27.839c-10.016,14.438-24.234,17.849-40.832,15.78c-7.385-0.92-14.406-2.816-21.246-5.422
    c-13.549-5.159-20.191-16.348-23.844-29.433c-5.659-20.297-1.638-39.06,9.969-56.494c7.352-11.042,16.057-20.996,24.254-31.362
    c10.086-12.758,9.057-28.586-2.361-40.235c-5.086-5.189-10.006-10.389-17.781-11.482c-3.191-0.448-6.057-0.333-8.852,1.574
    c6.895-0.15,12.607,2.547,17.379,7.047c11.996,11.316,13.275,24.909,4.355,39.414c-4.842,7.876-10.643,15.015-17.059,21.489
    c-9.441,9.529-17.724,20.023-26.696,29.926c-7.03,7.757-15.354,14.125-26.103,15.848c-13.623,2.184-29.494-4.447-30.713-21.896
    c-0.891-12.764,2.373-24.592,7.247-36.053c4.003-9.414,8.815-18.479,12.995-27.823c5.777-12.917,6.504-26.398,4.506-40.307
    c-1.439-10.016-4.09-19.696-6.574-29.444c-0.232-0.908-0.518-1.76-1.363-2.299c-1.287,0.388-0.861,1.473-0.895,2.303
    c-0.65,16.369-3.062,32.494-6.676,48.451c-2.785,12.297-6.24,24.348-12.229,35.561c-6.266,11.733-15.305,19.604-28.64,22.453
    c-9.214,1.968-15.219-2.511-18.5-9.665c-5.24-11.428-6.019-23.727-4.448-36.16c0.309-2.44,0.587-4.884,1.013-8.444
    c-3.861,7.471-6.259,14.328-8.441,21.26c-4.343,13.795-5.548,28.134-7.463,42.374c-1.608,11.957-3.538,23.914-8.479,35.022
    l-15.857,20.554c-7.382,5.247-16.351,7.71-26.848,7.29c-8.636-0.345-15.731-4.848-21.172-11.485
    c-11.316-13.803-16.834-30.063-19.095-47.496c-1.957-15.088,2.089-29.289,7.337-43.214c1.781-4.724,4.593-8.914,7.143-13.301
    c-6.168,4.492-11.489,9.746-14.327,16.926c-3.176,8.032-5.8,16.283-8.966,24.32c-1.615,4.101-3.291,8.944-8.447,9.479
    c-4.833,0.5-7.611-3.513-10.353-6.885c-4.711-5.799-9.38-11.66-13.003-18.207c-5.151-9.312-7.396-19.474-8.453-30.011
    c-0.391-3.899-0.656-7.797-1.01-11.71c-2.149,14.851-3.22,29.688-0.711,44.639c0.993,5.913,1.636,11.873,0.565,17.956
    c-2.594,14.728-14.194,19.696-27.364,15.702c-17.352-5.263-28.268-17.412-35.249-33.595c-7.923-18.365-10.003-37.727-8.615-57.398
    c1.024-14.504,5.077-28.423,9.827-42.23c4.295-12.483,9.772-24.487,13.912-37.012c5.05-15.277,2.599-29.875-3.141-44.386
    c-2.809-7.1-6.498-13.438-12.36-18.428c-1.311-1.115-2.546-2.211-4.886-2.353c1.798,5.031,3.791,9.689,5.134,14.529
    c5.293,19.076,2.46,37.394-5.948,54.979c-4.234,8.854-9.156,17.38-13.41,26.226c-9.552,19.863-15.102,40.924-18.531,62.641
    c-1.506,9.536-2.45,19.081-2.274,29.927c-8.867-10.378-16.602-20.101-23.522-30.626c1.123,6.077,2.47,12.124,3.324,18.239
    c2.06,14.749,4.544,29.489,1.258,44.428c0,0-16.868-12.046-33.307,36.978c-1.356,4.042-2.709,8.499-4.049,13.412
    c7.755-5.54,11.074-12.951,11.394-22.115c0.022-0.625,0.141-1.246,0.313-2.696c1.795,1.347,3.208,2.806,4.3,4.374
    C6.589,401.313,52,444,52,444c156.805,14.154,296.961,20.449,417.648,22.161c1.765,0.024,3.536,0.051,5.292,0.074
    c148.598,1.953,267.32-3.039,350.782-8.784c1.064-0.073,2.109-0.146,3.162-0.221C918.027,451.008,966,444,966,444
    C987.153,425.667,981.715,361.088,976.667,324.592z"
                          />
                          <path
                            class="flame-main three"
                            opacity="0.8"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                            fill="#F58553"
                            d="M771.154,453.647c4.645,0,9.287-0.143,13.924-0.219
    c-25.818-16.325-17.105-41.962-15.551-65.757c-3.521,0.37-4.951,3.345-7.004,5.331c-9.867,9.548-14.1,23.04-21.363,34.415
    c-9.449,14.788-17.018,14.925-25.93-0.033c-2.594-4.349-4.225-4.217-7.916-1.868c-10.408,6.618-19.42,5.279-28.299-3.677
    c-6.129-6.184-10.113-14.14-15.355-21.021c-4.699-6.163-5.984-12.75-6.344-20.355c-0.447-9.584,2.104-18.817,1.871-28.303h-0.004
    c-7.65,5.511-10.27,14.52-13.883,22.757c-4.41,10.053-5.74,21.149-9.033,31.565c-2.633,8.33-7.711,14.427-17.234,13.855
    c-7.832-0.471-14.918-6.768-17.174-15.797c-0.881-3.54-1.301-7.207-1.984-10.808c-2.359-12.411-11.273-21.867-23.324-24.362
    c1.521,3.162,3.078,5.966,4.262,8.938c4.434,11.113-0.098,23.483-10.412,28.778c-9.416,4.826-20.078,0.569-25.262-10.763
    c-6.271-13.727-8.491-27.745-2.084-42.451c7.385-16.953,15.694-33.557,19.432-52.057c3.805-18.83,8.199-37.641,3.057-56.968
    c-1.508-5.663-3.047-11.502-8.219-15.116c0.531,22.308-1.311,43.79-8.566,64.439c-1.611,4.588-3.866,9.898-9.258,9.653
    c-5.247-0.24-7.363-5.582-8.916-10.199c-2.825-8.413-3.985-17.262-5.019-26.269c-4.696,8.833-7.067,18.028-7.695,27.979
    c-1.67,26.497,4.661,52.582,3.425,78.977c-0.796,17.018-4.039,33.424-16.239,46.251c-5.652,5.94-12.339,8.128-19.831,6.946
    c-6.515-1.03-4.905-8.176-6.835-12.499c-4.691-10.52-11.012-18.682-21.919-21.827c0.271,2.51,1.212,4.334,2.184,6.135
    c6.913,12.791,3.335,26.492-9.141,34.971c-7.763,5.282-16.252,2.058-24.763-9.902c-6.272-8.814-11.438-18.625-18.38-26.764
    c-9.283-10.887-10.386-22.944-9.229-36.673c0.895-10.597,2.159-21.221,3.135-32.339c-2.998,1.271-3.42,3.53-4.264,5.351
    c-5.396,11.639-6.326,24.707-10.429,36.752c-2.34,6.871-4.194,14.084-10.652,18.427c-5.743,3.861-10.957-0.137-17.543-1.849
    c1.996,5.225,1.941,9.44,1.948,13.668c0.009,7.597-3.437,12.981-9.719,16.052c-5.165,2.525-10.896,3.367-15.631-0.757
    c-5.439-4.732-5.102-11.494-3.413-17.886c2.614-9.902,3.342-19.96,2.588-30.076c-0.898-12.045-4.308-23.276-11.323-35.221
    c-1.936,26.202-12.987,46.158-23.798,66.063c-7.771,14.31-20.111,22.571-35.3,26.102c-22.3,5.179-45.063-7.87-52.903-30.214
    c-1.833-5.219-3.105-10.955-10.035-15.357c3.337,6.592,2.699,11.838,2.615,16.988c-0.199,12.348-11.01,19.681-21.815,14.888
    c-9.322-4.138-10.708-13.066-11.149-22.081c-1.051-21.541,2.433-42.76,4.431-64.095c1.699-18.137,1.618-36.25-5.224-53.447
    c-2.413-6.063-4.379-12.723-11.311-16.911c1.208,6.781,2.867,12.603,3.185,18.511c1.202,22.357-3.821,43.814-9.484,65.079
    c-1.724,6.481-6.069,9.843-12.894,10.153c-19.101,0.858-33.916-9.88-45.649-22.92c-12.052-13.398-19.873-30.782-23.049-49.766
    c-2.322-13.875-5.463-27.539-10.073-40.819c-6.375-18.363-12.479-28.436-23.091-35.713c12.643,22.768,18.38,45.825,16.469,70.755
    c-0.113,1.458,0.528,2.991,0.863,4.478c6.375,28.472,19.533,53.678,33.731,78.371c4.063,7.069,6.331,14.761,4.842,22.824
    c-3.339,18.082-11.792,33.119-25.715,44.48c-0.109,0.245-0.177,0.536-0.345,0.72c-0.098,0.107-0.362,0.044-0.551,0.057
    c0.301-0.259,0.602-0.52,0.902-0.776c0.272-11.404,0.781-22.873-7.828-32.517c-3.199,11.496-7.804,18.17-22.956,32.627
    c0,0-20.409,7.137,13.348,20.188C104.064,462.01,446.695,479.899,771.154,453.647z"
                          />
                          <path
                            class="flame-main three"
                            opacity="0.8"
                            fill-rule="evenodd"
                            clip-rule="evenodd"
                            fill="#F58553"
                            d="M956.425,464.105
    c-283.913,0.026-436.816-4.843-720.731-4.854c-5.471,0-10.94-0.17-16.414-0.259c17.521-8.644,29.516-19.407,35.464-33.646
    c3.527,1.396,5.092,3.325,7.317,4.926c35.38,25.433,78.727,21.837,116.905,6.063c14.958-6.18,25.563-14.081,20.298-26.71
    c18.336,1.768,30.708,6.852,38.003,16.78c6.811,9.263,17.117,9.926,28.419,2.379c5.181-3.462,7.175-7.52,7.832-12.224
    c0.825-5.903-5.177-10.447-8.612-16.018c8.262,0.587,12.618,3.027,17.026,5.416c14.347,7.771,24.313,17.255,30.903,28.102
    c6.558,10.787,18.213,18.85,37.52,20.972c41.72,4.582,96.563-11.861,105.411-41.25c5.203-17.268,12.443-34.365,27.301-49.779
    c6.971-7.235,13.938-14.741,30.017-19.136c-3.498,5.18-6.355,8.919-8.574,12.789c-7.594,13.236-11.873,26.498-0.401,39.853
    c10.145,11.811,28.792,13.81,45.402,4.956c15.291-8.153,17.729-17.783,6.95-29.903c21.625,3.47,31.868,10.7,37.656,20.952
    c4.237,7.505,10.585,8.833,22.368,4.999c11.688-3.803,17.802-10.277,21.734-17.517c6.505-11.979,9.623-24.293,9.09-36.918
    c-0.286-6.807-0.097-13.664-8.294-19.234c-0.917-1.19-1.835-2.38-2.734-3.569c25.02,6.119,30.716,20.096,37.163,33.489
    c3.832,7.955,5.298,16.313,8.674,24.361c1.394,3.321,3.512,7.423,10.355,8.059c6.925,0.642,11.047-2.916,13.649-5.935
    c18.472-21.417,25.072-43.195,3.656-65.466c-13.239-22.289-10.814-43.785,9.086-64.394l-0.168-0.118
    c0.767,11.759-5.291,23.314-0.978,35.305c3.61,10.039,9.313,19.199,18.593,27.751c7.567,6.975,13.455,14.467,16.165,22.727
    c0.994,3.797,1.986,7.59,2.982,11.382c-0.127,5.22-0.251,10.438-0.38,15.66c-5.04,9.903-10.8,19.7-14.889,29.741
    c-3.156,7.76,0.219,14.943,12.113,19.614C963.82,417.971,967.399,461.364,956.425,464.105z"
                          />
                        </svg>
                      </div>
                    </button>
                    <button
                      className="h-26 card items-center justify-center opacity-30 col-span-2 hidden"
                      type="button"
                      disabled
                    >
                      auto optimize (from tool) coming soon
                    </button>
                  </div>
                  <div className="flex flex-col items-center px-9 ">
                    <div className="flex flex-1  mx-8  user__wallet-balance h-1/2 items-center">
                      {/* make me a component */}
                      <div className="flex gap-2 flex-col">
                        <ToggleSwitch
                          switchID="enableResets"
                          title="Enable Mission Level Reset"
                          checked={isMissionMode ? true : resetEnabled}
                          disabled={isMissionMode}
                          onChange={(event) =>
                            void setMissionResetEnabled(event.target.checked)
                          }
                        />
                        <ToggleSwitch
                          switchID="enableRentals"
                          title="Enable Rentals"
                          disabled
                        />
                        <div className="text-[11px] text-slate-400 -mt-1">
                          Rentals coming soon
                        </div>
                      </div>
                    </div>
                    <div className="grid  grid-cols-2 gap-x-2 gap-y-1 mx-8  user__wallet-balance  h-1/2 items-center">
                      {walletTiles.map((tile) => (
                        <div
                          key={tile.key}
                          className="flex gap-2 items-center user__wallet-balance-item"
                        >
                          <img
                            src={tile.icon}
                            alt={`${tile.label} Logo`}
                            className="w-8 h-8 aspect-square"
                          />
                          <div className="flex flex-col gap-0 w-full">
                            <span
                              className={`user__wallet-ballance-sol_increase text-sm leading-tight ${tile.earnedClass}`}
                            >
                              {tile.earnedVisible ? (
                                <span className="inline-flex items-center gap-0.5">
                                  <span>(</span>
                                  <span>{tile.earnedDirection}</span>
                                  <SlideNumberFormatted
                                    value={tile.earnedNumber}
                                    format={(n) =>
                                      Number(n || 0).toLocaleString(undefined, {
                                        maximumFractionDigits: 2,
                                      })
                                    }
                                  />
                                  <span>)</span>
                                </span>
                              ) : (
                                "\u00a0"
                              )}
                            </span>
                            <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                              <SlideNumberFormatted
                                value={tile.balanceNumber}
                                format={(n) =>
                                  Number(n || 0).toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                  })
                                }
                              />
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="">
                <div className="grid grid-cols-4 gap-2 missions__parent">
                  {[1, 2, 3, 4].map((slot) => {
                    const entry =
                      slots.find((s) => Number(s?.slot) === slot) || null;
                    const slotError = slotResetErrors[String(slot)] || null;
                    const title = entry?.missionName || `slot ${slot}`;
                    const missionLevel =
                      entry?.missionLevel === null ||
                      entry?.missionLevel === undefined
                        ? null
                        : `${entry.missionLevel}`;
                    const progress =
                      Number.isFinite(Number(entry?.progress)) &&
                      Number.isFinite(Number(entry?.goal)) &&
                      Number(entry.goal) > 0
                        ? `${Number(entry.progress)}/${Number(entry.goal)}`
                        : `${slot}/4`;
                    const progressCurrent = Number(entry?.progress);
                    const progressGoal = Number(entry?.goal);
                    const hasProgress =
                      Number.isFinite(progressCurrent) &&
                      Number.isFinite(progressGoal) &&
                      progressGoal > 0;
                    const progressPercent = hasProgress
                      ? Math.max(
                          0,
                          Math.min(100, (progressCurrent / progressGoal) * 100),
                        )
                      : 0;
                    const imgSrc = pickSlotImage(entry);
                    return (
                      <div
                        className={`card-mission ${slotError ? "card-mission--error" : ""}`}
                        key={slot}
                      >
                        <div className="card-mission__header relative overflow-clip">
                          <MissionSlotImage src={imgSrc} />
                          {isStarting ? (
                            <span className="loading loading-spinner loading-xs text-white/30 absolute top-2 right-2 z-20" />
                          ) : null}
                          {slotError ? (
                            <button
                              type="button"
                              className="mission-error-badge"
                              title="Reset error details"
                              onClick={() => setResetErrorModal(slotError)}
                            >
                              i
                            </button>
                          ) : null}
                          {missionLevel ? (
                            <div className="z-10 text-sm flex items-center rounded-[5px] justify-center w-7 h-7 opacity-100 place-self-end-safe shadow-md shadow-black/20 font-semibold bg-amber-500 border-orange-200 border-2">
                              {missionLevel}
                            </div>
                          ) : null}
                          {!slotError & hasProgress ? (
                            <div className="relative w-full h-4 rounded-full overflow-hidden bg-zinc-800 opacity-90 shadow-md shadow-black/20 after:hidden ">
                              <div className="absolute rounded-full inset-0 z-0 bg-linear-to-r from-violet-500 via-fuchsia-500 to-pink-500 after:hidden transition-all"></div>
                              <div
                                className="absolute rounded-r-full rounded-l-none top-0 right-0 z-10 h-full bg-zinc-800 after:hidden transition-all"
                                style={{ width: `${100 - progressPercent}%` }}
                              ></div>
                              <div className="absolute inset-0 z-20 flex items-center rounded-full justify-center text-[10px] font-semibold text-white">
                                {progress}
                              </div>
                            </div>
                          ) : (
                            ""
                          )}
                          {slot === 4 && canUnlockSlot4 ? (
                            <button
                              type="button"
                              className="absolute inset-0 z-30 grid place-items-center bg-black/55 text-white font-semibold tracking-wide uppercase text-xs"
                              onClick={() => {
                                setSlotUnlockModalOpen(true);
                                setSlotUnlockBusy(false);
                                setSlotUnlockError(null);
                                setSlotUnlockResult(null);
                              }}
                            >
                              Click to unlock
                            </button>
                          ) : null}
                        </div>
                        <div className="card-mission__meta">
                          <div className="card-mission__title">
                            {title ? title : "Assign NFT to start"}
                          </div>
                          <div className="card-mission__slot text-gray-400">
                            Slot {slot}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          )}
          {resetErrorModal ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setResetErrorModal(null);
              }}
            >
              <div className="card w-full max-w-140 space-y-4 !bg-[#0b1116] border border-error/50 z-10">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold text-error">
                    Reset Needs Attention
                  </div>
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setResetErrorModal(null)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-sm text-slate-200">
                  <span className="font-semibold">
                    {resetErrorModal?.missionName || "Unknown mission"}
                  </span>
                  {Number.isFinite(Number(resetErrorModal?.slot))
                    ? ` (slot ${Number(resetErrorModal.slot)})`
                    : ""}
                </div>
                <div className="text-xs text-slate-300">
                  Action: {resetErrorModal?.actionName || "reset"}{" "}
                  {resetErrorModal?.at
                    ? `• ${new Date(resetErrorModal.at).toLocaleString()}`
                    : ""}
                </div>
                <div className="rounded-md border border-error/40 bg-error/10 p-3 text-sm text-slate-100">
                  {resetErrorModal?.error || "Reset failed."}
                </div>
                {resetErrorModal?.bridgeUrl ? (
                  <div className="space-y-2">
                    <div className="text-xs uppercase text-slate-300">
                      Manual Reset Bridge URL
                    </div>
                    <div className="rounded-md border border-white/10 bg-black/20 p-2 text-xs break-all text-slate-200">
                      {resetErrorModal.bridgeUrl}
                    </div>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="btn btn-clear btn-sm"
                        onClick={() => {
                          const url = String(
                            resetErrorModal.bridgeUrl || "",
                          ).trim();
                          if (!url) return;
                          void openExternalUrl(url);
                        }}
                      >
                        Open Link
                      </button>
                      <button
                        type="button"
                        className="btn btn-gradient btn-sm"
                        onClick={() => void copyText(resetErrorModal.bridgeUrl)}
                      >
                        Copy Link
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setResetErrorModal(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {slotUnlockModalOpen ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget && !slotUnlockBusy) {
                  setSlotUnlockModalOpen(false);
                }
              }}
            >
              <div className="card w-full max-w-140 space-y-4 !bg-[#0b1116] border border-white/15 z-10">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold text-white">
                    Unlock Slot 4
                  </div>
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setSlotUnlockModalOpen(false)}
                    title="Close"
                    disabled={slotUnlockBusy}
                  >
                    ✕
                  </button>
                </div>
                <div className="text-sm text-slate-200">
                  Are you sure you want to unlock your 4th slot for{" "}
                  <span className="font-semibold">
                    {normalizedSlotUnlockCost} PBP
                  </span>
                  ?
                </div>
                {slotUnlockError ? (
                  <div className="rounded-md border border-error/40 bg-error/10 p-3 text-sm text-slate-100">
                    {slotUnlockError}
                  </div>
                ) : null}
                {slotUnlockResult?.reason === "no_more_to_unlock" ? (
                  <div className="rounded-md border border-success/35 bg-success/10 p-3 text-sm text-slate-100">
                    No more to unlock.
                  </div>
                ) : null}
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setSlotUnlockModalOpen(false)}
                    disabled={slotUnlockBusy}
                  >
                    No
                  </button>
                  <button
                    type="button"
                    className="btn btn-gradient btn-sm"
                    onClick={() => void confirmUnlockSlot4()}
                    disabled={slotUnlockBusy}
                  >
                    {slotUnlockBusy ? "Preparing..." : "Yes"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {lowBalanceModal ? (
            <div
              className="fixed inset-0 z-60 grid place-items-center bg-black/50 p-4"
              role="dialog"
              aria-modal="true"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setLowBalanceModal(null);
              }}
            >
              <div
                className="p-4  w-full rounded-xl shadow-2xl shadow-black/95 space-y-4 z-10 border-2 border-[#1D1C27]  transition-all duration-250 ease-out"
                style={{
                  maxWidth: onboardingStep === 2 ? "680px" : "680px",
                  backgroundImage: `url(${backImg})`,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                {/* <div className="card w-full max-w-140 space-y-4 !bg-[#0b1116] border border-warning/50 z-10"> */}
                <div className="flex items-center justify-between gap-3">
                  <div className="text-lg font-semibold text-warning">
                    Low Funding Balance
                  </div>
                  <button
                    type="button"
                    className="btn btn-clear btn-sm"
                    onClick={() => setLowBalanceModal(null)}
                    title="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="text-sm text-slate-200">
                  Your funding wallet dropped below safe thresholds. Top it up
                  to avoid failed transactions.
                </div>
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-slate-100">
                  {lowBalanceModal.reasons.join(" ")}
                </div>
                <div>
                  <label
                    htmlFor="user-wallet__lock-status"
                    className="text-sm uppercase text-slate-300"
                  >
                    Balances
                  </label>
                  <div className="flex gap-3 items-center user-wallet__balances">
                    <div
                      className={`flex gap-1 items-center user-wallet__balances-item ${
                        Number(
                          lowBalanceModal?.sol ??
                            fundingWalletSummary?.sol ??
                            0,
                        ) < Number(lowBalanceThresholds?.sol ?? 0.01)
                          ? "rounded-md border border-warning/60 bg-warning/10 px-2 py-1"
                          : ""
                      }`}
                    >
                      <div className="text-sm">
                        <SlideNumberFormatted
                          value={Number(fundingWalletSummary?.sol || 0)}
                          format={(n) =>
                            Number(n || 0).toLocaleString(undefined, {
                              maximumFractionDigits: 4,
                            })
                          }
                        />{" "}
                        SOL
                      </div>
                    </div>
                    <div
                      className={`flex gap-1 items-center user-wallet__balances-item ${
                        Number(
                          lowBalanceModal?.pbp ??
                            fundingWalletSummary?.pbp ??
                            0,
                        ) < Number(lowBalanceThresholds?.pbp ?? 1000)
                          ? "rounded-md border border-warning/60 bg-warning/10 px-2 py-1"
                          : ""
                      }`}
                    >
                      <div className="text-sm">
                        <SlideNumberFormatted
                          value={Number(fundingWalletSummary?.pbp || 0)}
                          format={(n) =>
                            Number(n || 0).toLocaleString(undefined, {
                              maximumFractionDigits: 2,
                            })
                          }
                        />{" "}
                        PBP
                      </div>
                    </div>
                  </div>
                  {!fundingWalletSummary ? (
                    <div className="text-xs text-slate-400 mt-1">
                      Loading app-wallet summary...
                    </div>
                  ) : null}
                </div>

                <label
                  htmlFor="user__wallet-addres"
                  className="text-sm uppercase text-slate-300"
                >
                  In-App Address
                </label>
                <div className="user__wallet-addres text-lg flex flex-wrap gap-y-0 gap-x-5 items-center">
                  <div className="flex w-full flex-basis">
                    {appWalletAddress || "—"}
                  </div>
                  <button
                    type="button"
                    className="fill-white flex  items-center gap-1 font-normal text-xs px-0  py-1 h-min btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                    onClick={() => {
                      const value = appWalletAddress;
                      if (!value) return;
                      void copyText(value).then((ok) => {
                        setCopiedLabel(ok ? "Copied" : "Copy failed");
                        setTimeout(() => setCopiedLabel(null), 1200);
                      });
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 640 640"
                      className="w-4 h-4"
                    >
                      <path d="M352 544L128 544C110.3 544 96 529.7 96 512L96 288C96 270.3 110.3 256 128 256L176 256L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L384 464L384 512C384 529.7 369.7 544 352 544zM288 384C270.3 384 256 369.7 256 352L256 128C256 110.3 270.3 96 288 96L512 96C529.7 96 544 110.3 544 128L544 352C544 369.7 529.7 384 512 384L288 384zM224 352C224 387.3 252.7 416 288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352z" />
                    </svg>
                    Copy
                  </button>
                  <button
                    type="button"
                    className="fill-white flex font-normal items-center gap-1 text-xs btn-clear btn px-0 py-1 h-min hover:fill-accent hover:text-accent hover:cursor-pointer"
                    disabled={!appWalletAddress}
                    onClick={() => {
                      if (!appWalletAddress) return;
                      const target = `https://solscan.io/account/${encodeURIComponent(appWalletAddress)}`;
                      void openExternalUrl(target);
                    }}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 640 640"
                      className="w-4 h-4"
                    >
                      <path d="M574.5 449.2L489.6 537.9C487.8 539.8 485.5 541.4 483 542.4C480.5 543.4 477.8 544 475.1 544L72.9 544C71 544 69.1 543.5 67.5 542.4C65.9 541.3 64.6 539.9 63.9 538.2C63.2 536.5 62.9 534.6 63.2 532.7C63.5 530.8 64.4 529.1 65.7 527.8L150.6 439.1C152.4 437.2 154.7 435.6 157.1 434.6C159.5 433.6 162.2 433 164.9 433L567.3 433C569.2 433 571.1 433.5 572.7 434.6C574.3 435.7 575.6 437.1 576.3 438.8C577 440.5 577.3 442.4 577 444.3C576.7 446.2 575.8 447.9 574.5 449.2zM489.7 270.6C487.9 268.7 485.6 267.1 483.1 266.1C480.6 265.1 477.9 264.5 475.2 264.5L72.8 264.5C70.9 264.5 69 265 67.4 266.1C65.8 267.2 64.5 268.6 63.8 270.3C63.1 272 62.8 273.9 63.1 275.8C63.4 277.7 64.3 279.4 65.6 280.7L150.5 369.4C152.3 371.3 154.6 372.9 157 373.9C159.4 374.9 162.1 375.5 164.8 375.5L567.2 375.5C569.1 375.5 571 375 572.6 373.9C574.2 372.8 575.5 371.4 576.2 369.7C576.9 368 577.2 366.1 576.9 364.2C576.6 362.3 575.7 360.6 574.4 359.3L489.5 270.6zM72.9 206.9L475.3 206.9C478 206.9 480.7 206.4 483.2 205.3C485.7 204.2 487.9 202.7 489.8 200.8L574.7 112.1C576 110.7 576.9 109 577.2 107.2C577.5 105.4 577.3 103.5 576.5 101.7C575.7 99.9 574.5 98.5 572.9 97.5C571.3 96.5 569.4 95.9 567.5 95.9L165 96C162.3 96 159.6 96.5 157.2 97.6C154.8 98.7 152.5 100.2 150.7 102.1L65.7 190.8C64.4 192.2 63.5 193.9 63.2 195.7C62.9 197.5 63.1 199.4 63.9 201.2C64.7 203 65.9 204.4 67.5 205.4C69.1 206.4 71 207 72.9 207z" />
                    </svg>
                    Explorer
                  </button>
                </div>

                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    className="btn btn-gradient btn-sm"
                    onClick={() => setLowBalanceModal(null)}
                  >
                    OK
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function CliView() {
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

export default ControlView;
