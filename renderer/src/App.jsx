import NavMain from "./components/nav/app";
import { useEffect, useMemo, useRef, useState } from "react";
import WindowChrome from "./components/WindowChrome/app";
import HeaderUser from "./components/HeaderUser/app";
import useBackendState from "./components/useBackendState/app";
import ToggleSwitch from "./components/ToggleSwitch/app";

import pbpIcon from "./img/icon_pbp.webp";
import solIcon from "./img/icon-sm__sol.svg";
import ccIcon from "./img/icon_cc.webp";
import tcIcon from "./img/icon_tc.webp";
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
  const { bridge, status, logs } = useBackendState();
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
  const [usePreviousDebug, setUsePreviousDebug] = useState(false);
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
      const res = await bridge.getLatestCompetition({
        competitionPick: usePreviousDebug ? "second" : "first",
      });
      if (!res?.ok) throw new Error(res?.error || "Scrape failed.");
      setLatestCompetition(res.competition || null);
    } catch (e) {
      setLatestCompetitionError(String(e?.message || e));
    } finally {
      setLatestCompetitionBusy(false);
    }
  };

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
        earned: (rewardTotals.pbp ?? 0) - (spendTotals.pbp ?? 0),
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
        earned: (rewardTotals.cc ?? 0) - (spendTotals.cc ?? 0),
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
        earned: (rewardTotals.tc ?? 0) - (spendTotals.tc ?? 0),
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
    status.sessionRewardTotals,
    status.sessionSpendTotals,
  ]);
  const lockLabel =
    status.signerLocked === true
      ? "🔒"
      : status.signerLocked === false
        ? "🔓"
        : "";
  const slots = Array.isArray(status.guiMissionSlots)
    ? status.guiMissionSlots
    : [];
  const missionStats = status.currentMissionStats || {};
  const fundingWalletSummary =
    status.fundingWalletSummary?.status === "ok"
      ? status.fundingWalletSummary
      : null;
  const isWatching = status.watcherRunning === true;
  const isStarting = status.running && !isWatching;
  const [activityLabel, setActivityLabel] = useState(null);
  const [copiedLabel, setCopiedLabel] = useState(null);
  const [secretModalOpen, setSecretModalOpen] = useState(false);
  const [secretModalBusy, setSecretModalBusy] = useState(false);
  const [secretModalError, setSecretModalError] = useState(null);
  const [secretModalBackup, setSecretModalBackup] = useState(null);
  const [secretModalRevealed, setSecretModalRevealed] = useState(false);
  const [secretCopiedPhraseLabel, setSecretCopiedPhraseLabel] = useState(null);
  const [secretCopiedAddrLabel, setSecretCopiedAddrLabel] = useState(null);

  const [createWalletOpen, setCreateWalletOpen] = useState(false);
  const [createWalletConfirm, setCreateWalletConfirm] = useState(false);
  const [createWalletBusy, setCreateWalletBusy] = useState(false);
  const [createWalletError, setCreateWalletError] = useState(null);
  const [createWalletResult, setCreateWalletResult] = useState(null);
  const [createWalletRevealed, setCreateWalletRevealed] = useState(false);
  const [createCopiedPhraseLabel, setCreateCopiedPhraseLabel] = useState(null);
  const [createCopiedAddrLabel, setCreateCopiedAddrLabel] = useState(null);
  const mainStatusLabel = activityLabel
    ? activityLabel
    : status.running
      ? isWatching
        ? "Watching Missions..."
        : "Starting up..."
      : "Stopped";

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
    if (!status.running || !Array.isArray(logs) || logs.length === 0) return;
    const last = logs[logs.length - 1];
    const text = String(last?.text || "");
    let next = null;
    if (
      /^\[WATCH\].*✅\s+Claimed/i.test(text) ||
      /Claimed .*reward/i.test(text)
    ) {
      next = "✅ Claimed Mission";
    } else if (/^\[ASSIGN\].*✅\s+Started mission/i.test(text)) {
      next = "🚀 Started Mission";
    } else if (/^\[WATCH\].*Cycle complete/i.test(text)) {
      next = "🔎 Watching Missions...";
    }
    if (!next) return;
    setActivityLabel(next);
    const timer = setTimeout(() => {
      setActivityLabel(null);
    }, 1400);
    return () => clearTimeout(timer);
  }, [logs, status.running]);

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
  const startMissions = async () => {
    if (!status.running) {
      await bridge.startBackend();
    }
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
    if (!status.running) {
      setSecretModalError(
        "Secret keys require the backend to be running. Start missions first, then try again.",
      );
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

  const openCreateWalletModal = () => {
    setCreateWalletOpen(true);
    setCreateWalletConfirm(false);
    setCreateWalletBusy(false);
    setCreateWalletError(null);
    setCreateWalletResult(null);
    setCreateWalletRevealed(false);
    setCreateCopiedPhraseLabel(null);
    setCreateCopiedAddrLabel(null);
  };

  const runCreateWallet = async () => {
    if (!createWalletConfirm) return;
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
      setCreateWalletRevealed(true);
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
            onManualClaim={() => status.running && bridge?.sendCommand?.("c")}
          />
          {currentPage === "settings" && (
            <>
              <section>
                <div className="card gap-6">
                  <div className="space-y-4">
                    <div className="flex items-center">
                      <ToggleSwitch
                        switchID="enabledFunding"
                        checked={fundingEnabled}
                        onChange={(e) =>
                          void (async () => {
                            const enabled = e.target.checked === true;
                            if (!enabled) {
                              await setSignerMode("manual");
                              return;
                            }
                            // Default "on" choice is app_wallet unless user has selected browser.
                            const target =
                              fundingSource === "browser"
                                ? "dapp"
                                : "app_wallet";
                            await setSignerMode(target);
                          })()
                        }
                      />
                      <h1 className="text-2xl font-normal ">
                        Funding Wallet
                      </h1>{" "}
                    </div>
                    <div className="text-sm text-slate-300">
                      Wallets must have enough Solana to cover resets
                      transactions.
                    </div>

                    {fundingEnabled && (
                      <div className="signer-type">
                        <label className="signer-type__app items-start ">
                          <input
                            type="radio"
                            name="funding_source"
                            value="app_wallet"
                            className="fake-checkbox-radio"
                            checked={fundingSource === "app_wallet"}
                            onChange={(e) =>
                              void (async () => {
                                setFundingSource(e.target.value);
                                await setSignerMode("app_wallet");
                              })()
                            }
                          />
                          <div className="space-y-2">
                            {" "}
                            <div className="flex gap-2 items-center w-full justify-between">
                              {" "}
                              <h2 className="text-base text-white">
                                App Wallet
                              </h2>
                              <span className="badge h-min uppercase border-transparent bg-white text-black text-[11px] place-self-center ">
                                Full Automation
                              </span>
                            </div>
                            <span className="signer-type_description text-xs text-slate-300 ">
                              A dedicated self-custody wallet specifically for
                              this app. No approval needed.
                            </span>{" "}
                            <div className="flex font-semibold gap-2 mt-3  text-slate-300">
                              <img
                                src={solIcon}
                                className="w-4 h-4"
                                alt="Solana logo"
                              />
                              Requires funding for transactions
                            </div>
                          </div>
                        </label>
                        <label className="signer-type__browser items-start ">
                          <input
                            type="radio"
                            name="funding_source"
                            value="browser"
                            className="fake-checkbox-radio"
                            checked={fundingSource === "browser"}
                            onChange={(e) =>
                              void (async () => {
                                setFundingSource(e.target.value);
                                await setSignerMode("dapp");
                              })()
                            }
                          />
                          <div className="space-y-2">
                            {" "}
                            <h2 className="text-base text-white">Browser</h2>
                            <span className="signer-type_description text-xs  text-slate-300">
                              Transactions open in your browser wallet and must
                              be manually approved.
                            </span>
                          </div>
                        </label>
                      </div>
                    )}
                  </div>

                  {fundingEnabled && fundingSource === "app_wallet" ? (
                    <div className="space-y-2">
                      <h3 className="sm border-b border-white/20 pb-1">
                        App-Wallet Details
                      </h3>
                      <label
                        htmlFor="user__wallet-addres"
                        className="text-sm uppercase text-slate-300"
                      >
                        Address
                      </label>
                      <div className="user__wallet-addres text-lg flex gap-3 items-center">
                        {fundingWalletSummary?.address ||
                          status.signerWallet ||
                          "—"}
                        <button
                          type="button"
                          className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer"
                          onClick={() => {
                            const value = String(
                              fundingWalletSummary?.address ||
                                status.signerWallet ||
                                "",
                            ).trim();
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
                            className="w-6 h-6"
                          >
                            <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                          </svg>{" "}
                          {copiedLabel || "Copy"}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-8">
                        <div>
                          {" "}
                          <label
                            htmlFor="user-wallet__lock-status"
                            className="text-sm uppercase text-slate-300"
                          >
                            Lock State
                          </label>
                          <div className="user-wallet__lock-status flex gap-2">
                            {lockLabel} Locked (last unlock time here)
                          </div>
                        </div>
                        <div>
                          <label
                            htmlFor="user-wallet__lock-status"
                            className="text-sm uppercase text-slate-300"
                          >
                            Balances
                          </label>
                          <div className="flex gap-3 items-center user-wallet__balances">
                            <div className="flex gap-1 items-center user-wallet__balances-item">
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
                            </div>{" "}
                            <div className="flex gap-1 items-center user-wallet__balances-item">
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
                      </div>

                      <button
                        type="button"
                        onClick={() => void openSecretModal()}
                        className="text-sm uppercase inline-flex px-6 py-1.5 bg-[#9661E2] max-w-max rounded-sm hover:bg-[#5F0DD5] transition-colors"
                      >
                        View Secret Keys
                      </button>
                      <div className="bg-warning/20 border border-warning/70 rounded-md p-3  space-y-2.5 opacity-50 mt-4">
                        <span>Generate New App Wallet</span>
                        <div className="text-xs">
                          This will delete your app-wallet from the app
                          entirely. There is no re-adding it. Do not do this
                          unless you are 100% sure. You will only be able to
                          access it by recovering it elsewhere.
                        </div>

                        <button
                          className="text-xs uppercase inline-flex px-6 py-1.5 bg-error max-w-max rounded-sm not-disabled:hover:bg-error-content transition-colors"
                          onClick={() => openCreateWalletModal()}
                          type="button"
                        >
                          Generate New Wallet
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            </>
          )}{" "}
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
                    This replaces your current app-wallet in the app. Save the
                    recovery phrase immediately.
                  </div>
                )}

                {createWalletError ? (
                  <div className="text-sm text-error">{createWalletError}</div>
                ) : null}

                {!createWalletResult ? (
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
                      disabled={!createWalletConfirm || createWalletBusy}
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
            <section>
              <div className="card gap-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <h1 className="text-2xl font-normal">
                      {latestCompetition?.competitionNumber
                        ? `Competition ${latestCompetition.competitionNumber}`
                        : "Competition"}
                    </h1>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-slate-400 flex items-center gap-1 select-none">
                      <input
                        type="checkbox"
                        checked={usePreviousDebug}
                        onChange={(e) => {
                          setUsePreviousDebug(e.target.checked === true);
                          setLatestCompetition(null);
                        }}
                      />
                      Use previous (debug)
                    </label>
                    <button
                      type="button"
                      className="btn btn-clear btn-sm uppercase !tracking-wider font-light text-slate-300"
                      onClick={() => void refreshLatestCompetition()}
                      disabled={latestCompetitionBusy}
                      title={
                        latestCompetition
                          ? "Refresh competition data"
                          : "Load competition data"
                      }
                    >
                      {latestCompetitionBusy
                        ? latestCompetition
                          ? "Refreshing..."
                          : "Loading..."
                        : latestCompetition
                          ? "Refresh"
                          : "Load"}
                    </button>
                  </div>
                </div>

                {latestCompetitionError ? (
                  <div className="text-sm text-red-300">
                    {latestCompetitionError}
                  </div>
                ) : null}

                {!latestCompetition ? (
                  <div className="text-sm text-slate-300">
                    {latestCompetitionBusy
                      ? "Loading competition..."
                      : "Press Load to fetch the latest competition."}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {latestCompetition.debug?.challenge ? (
                      <div className="text-sm text-amber-200">
                        Headless scrape looks blocked (
                        {latestCompetition.debug.challenge}). Try again after
                        opening the competitions page once in-app, or disable
                        bot protection.
                      </div>
                    ) : null}
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="text-slate-400">Start</div>
                      <div>
                        {latestCompetition.start ||
                          latestCompetition.datesText ||
                          "Unknown"}
                      </div>
                      <div className="text-slate-400">End</div>
                      <div>
                        {latestCompetition.end ||
                          latestCompetition.datesText ||
                          "Unknown"}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Missions</div>
                      {Array.isArray(latestCompetition.missions) &&
                      latestCompetition.missions.length ? (
                        <ul className="text-sm list-disc pl-5 space-y-0.5">
                          {latestCompetition.missions.map((m, idx) => (
                            <li key={`${idx}_${m}`}>{m}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-slate-300">
                          No missions found.
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Prizes</div>
                      {Array.isArray(latestCompetition.prizes) &&
                      latestCompetition.prizes.length ? (
                        <ul className="text-sm list-disc pl-5 space-y-0.5">
                          {latestCompetition.prizes.map((p, idx) => (
                            <li key={`${idx}_${p}`}>{p}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-slate-300">
                          No prizes found.
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      <div className="text-sm text-slate-400">Results</div>
                      {latestCompetition.resultsStatus ? (
                        <div className="text-sm text-slate-300">
                          {latestCompetition.resultsStatus}
                        </div>
                      ) : Array.isArray(latestCompetition.users) &&
                        latestCompetition.users.length ? (
                        <ul className="text-sm list-disc pl-5 space-y-0.5">
                          {latestCompetition.users.map((u, idx) => (
                            <li key={`${idx}_${u}`}>{u}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-sm text-slate-300">
                          No users found.
                        </div>
                      )}
                    </div>

                    {latestCompetition.debug ? (
                      <details className="text-xs text-slate-400">
                        <summary className="cursor-pointer select-none">
                          Debug
                        </summary>
                        <div className="pt-2 space-y-2">
                          <div>
                            pick:{" "}
                            {latestCompetition.debug.competitionPick || "?"} •
                            cards: {latestCompetition.debug.cardCount ?? "?"}
                          </div>
                          {latestCompetition.debug.sampleText ? (
                            <div className="whitespace-pre-wrap break-words">
                              {latestCompetition.debug.sampleText}
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </div>
                )}
              </div>
            </section>
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
                        {!status.running ? "Start Missions" : "Press to stop"}
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
                  <div className="grid grid-cols-2 gap-2 mission-modes">
                    <button
                      className={`h-26 card items-center justify-center transition-all ${isNormalMode ? "active" : ""}`}
                      onClick={() => void activateNormalMode()}
                      type="button"
                    >
                      normal
                    </button>
                    <button
                      className={`h-26 card items-center justify-center transition-all ${isMissionMode ? "active" : ""}`}
                      onClick={() => void activateMissionMode()}
                      type="button"
                    >
                      mission
                    </button>
                    <button
                      className="h-26 card items-center justify-center"
                      type="button"
                    >
                      mode 3
                    </button>
                    <button
                      className="h-26 card items-center justify-center"
                      type="button"
                    >
                      mode 4
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
                      <div className="card-mission " key={slot}>
                        <div className="card-mission__header relative overflow-clip">
                          <MissionSlotImage src={imgSrc} />
                          {isStarting ? (
                            <span className="loading loading-spinner loading-xs text-white/30 absolute top-2 right-2 z-20" />
                          ) : null}
                          {missionLevel ? (
                            <div className="z-10 text-sm flex items-center rounded-[5px] justify-center w-7 h-7 opacity-100 place-self-end-safe shadow-md shadow-black/20 font-semibold bg-amber-500 border-orange-200 border-2">
                              {missionLevel}
                            </div>
                          ) : null}
                          {hasProgress ? (
                            <div className="relative w-full h-4 rounded-full overflow-hidden bg-zinc-800 opacity-90 shadow-md shadow-black/20 after:hidden ">
                              <div className="absolute inset-0 z-0 bg-linear-to-r from-violet-500 via-fuchsia-500 to-pink-500 after:hidden transition-all"></div>
                              <div
                                className="absolute top-0 right-0 z-10 h-full bg-zinc-800 after:hidden transition-all"
                                style={{ width: `${100 - progressPercent}%` }}
                              ></div>
                              <div className="absolute inset-0 z-20 flex items-center justify-center text-[10px] font-semibold text-white">
                                {progress}
                              </div>
                            </div>
                          ) : (
                            ""
                          )}
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
    node.scrollTop = node.scrollHeight;
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

      <section className=" flex-1  ">
        <div className="space-y-4">
          <div
            className="terminal bg-black/75"
            ref={outputRef}
            style={{
              height: "472px",
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

export function App() {
  const isCli = window.location.hash === "#/cli";
  return isCli ? <CliView /> : <ControlView />;
}
