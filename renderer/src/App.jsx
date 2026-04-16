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

function ControlView() {
  const { bridge, status, logs } = useBackendState();
  const [currentPage, setCurrentPage] = useState("missions");
  const [isCliActive, setIsCliActive] = useState(false);
  const [fundingSource, setFundingSource] = useState("browser");
  const [fundingEnabled, setFundingEnabled] = useState(true);
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
  const isWatching = status.watcherRunning === true;
  const isStarting = status.running && !isWatching;
  const [activityLabel, setActivityLabel] = useState(null);
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
                        onChange={(e) => setFundingEnabled(e.target.checked)}
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
                            onChange={(e) => setFundingSource(e.target.value)}
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
                            onChange={(e) => setFundingSource(e.target.value)}
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

                  {fundingEnabled && fundingSource === "app_wallet" && (
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
                        3LgiNymFyPAC8MHdx8GjVgGuG3caCRxs8rRg2pitrbMV
                        <button className="fill-white flex items-center gap-1 text-xs btn btn-clear hover:fill-accent hover:text-accent hover:cursor-pointer">
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 640 640"
                            className="w-6 h-6"
                          >
                            <path d="M352 512L128 512L128 288L176 288L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L352 464L352 512zM288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352C224 387.3 252.7 416 288 416z" />
                          </svg>{" "}
                          Copy
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
                              <div className="text-sm">0.12 SOL</div>
                            </div>{" "}
                            <div className="flex gap-1 items-center user-wallet__balances-item">
                              <div className="text-sm">0.12 PBP</div>
                            </div>
                          </div>
                        </div>
                      </div>

                      <button className="text-sm uppercase inline-flex px-6 py-1.5 bg-[#9661E2] max-w-max rounded-sm hover:bg-[#5F0DD5] transition-colors">
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
                          disabled
                        >
                          Generate New Wallet - DISABLED
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}{" "}
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
                            : bridge.startBackend()
                        }
                      >
                        {!status.running
                          ? "Start Missioninining"
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
                  <div className="grid grid-cols-2 gap-2 mission-modes">
                    <button className="h-26 card items-center justify-center">
                      mode 1
                    </button>
                    <button className="h-26 card items-center justify-center">
                      mode 1
                    </button>
                    <button className="h-26 card items-center justify-center">
                      mode 1
                    </button>
                    <button className="h-26 card items-center justify-center">
                      mode 1
                    </button>
                  </div>
                  <div className="flex flex-col items-center px-9 ">
                    <div className="flex flex-1  mx-8  user__wallet-balance h-1/2 items-center">
                      {/* make me a component */}
                      <div className="flex gap-2 flex-col">
                        <ToggleSwitch
                          switchID="enableResets"
                          title="Enable Mission Level Reset"
                          defaultChecked={true}
                        />
                        <ToggleSwitch
                          switchID="enableRentals"
                          title="Enable Rentals"
                        />
                      </div>
                    </div>
                    <div className="grid  grid-cols-2 gap-x-2 gap-y-1 mx-8  user__wallet-balance  h-1/2 items-center">
                      <div className="flex gap-2 items-center user__wallet-balance-item">
                        <img
                          src={solIcon}
                          alt="Solana Logo"
                          className="w-8 h-8 aspect-square"
                        />
                        <div className="flex flex-col gap-0 w-full">
                          <span className="user__wallet-ballance-sol_increase text-success text-sm leading-tight">
                            (+0.002)
                          </span>
                          <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                            0.2
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-2 items-center user__wallet-balance-item">
                        <img
                          src={pbpIcon}
                          alt="PBP Token Logo"
                          className="w-8 h-8 aspect-square"
                        />
                        <div className="flex flex-col gap-0">
                          <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                            (+1500)
                          </span>
                          <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                            169,420.43
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-2 items-center user__wallet-balance-item">
                        <img
                          src={ccIcon}
                          alt="Community Coins Logo"
                          className="w-8 h-8 aspect-square"
                        />
                        <div className="flex flex-col gap-0">
                          <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                            (0.002)
                          </span>
                          <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                            0.2
                          </span>
                        </div>
                      </div>
                      <div className="flex gap-2 items-center user__wallet-balance-item">
                        <img
                          src={tcIcon}
                          alt="Tournament Coins Logo"
                          className="w-8 h-8 aspect-square"
                        />
                        <div className="flex flex-col gap-0">
                          <span className="user__wallet-ballance-so_increase text-success text-sm leading-tight">
                            (0.002)
                          </span>
                          <span className="user__wallet-ballance-sol text-lg font-semibold leading-tight">
                            0.2
                          </span>
                        </div>
                      </div>
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
