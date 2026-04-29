import React from "react";
import solIcon from "../../img/icon-sm__sol.svg";
import pbpIcon from "../../img/icon-sm__pbp.webp";
import StatusBadge from "../StatusBadge/app";

export default function HeaderUser({
  lockLabel,
  status,
  debug,
  isAuthenticated,
  onManualClaim,
  manualCheckBusy = false,
}) {
  const signerMode = String(status.signerMode || "").trim();
  const fundingSummary =
    status.fundingWalletSummary?.status === "ok"
      ? status.fundingWalletSummary
      : null;
  const mainWalletBalances = Array.isArray(
    status.currentUserWalletSummary?.balances,
  )
    ? status.currentUserWalletSummary.balances
    : [];

  const parseBalance = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const cleaned = value.replace(/[, _]/g, "").trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };

  const findBalance = (key) => {
    const want = String(key || "")
      .trim()
      .toLowerCase();
    for (const entry of mainWalletBalances) {
      const k = String(entry?.key || entry?.symbol || entry?.name || "")
        .trim()
        .toLowerCase();
      if (!k) continue;
      if (k !== want) continue;
      const n = parseBalance(entry?.displayBalance ?? entry?.balance);
      if (n !== null) return n;
    }
    return null;
  };

  const mainSol = findBalance("sol");
  const mainPbp = findBalance("pbp");
  const displayName = String(status.currentUserDisplayName || "").trim();
  const walletId = String(status.currentUserWalletId || "").trim();
  const username = displayName || walletId || "Unknown";
  return (
    <section className="space-y-0 grid grid-cols-[70%_auto]" id="app__header">
      <div className="left">
        <h1 className="text-2xl user_meta__username">{username}</h1>
        {signerMode === "manual" ? (
          <div className="user_meta__funding_wallet flex gap-3 items-center">
            <div className="text-xs mt-1">
              <span className="user_meta__funding_wallet_lockstate text-xs">
                {lockLabel}
              </span>{" "}
              Manual Mode
            </div>
          </div>
        ) : signerMode === "dapp" ? (
          <div className="user_meta__funding_wallet flex gap-3 items-center mt-1">
            <div className="text-xs ">
              <span className="user_meta__funding_wallet_lockstate text-xs">
                {lockLabel}
              </span>{" "}
              Browser Wallet Balance
            </div>
            <div className="flex gap-3 items-center">
              <div className="flex gap-1 items-center">
                <div>
                  <img src={solIcon} alt="Solana logo" />
                </div>
                <div className="text-xs">
                  {Number(mainSol || 0).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}{" "}
                  SOL
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <div>
                  <img src={pbpIcon} alt="PBP token logo" />
                </div>
                <div className="text-xs">
                  {Number(mainPbp || 0).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  PBP
                </div>
              </div>
            </div>
          </div>
        ) : fundingSummary ? (
          <div className="user_meta__funding_wallet flex gap-3 items-center">
            <div className="text-xs mt-1">
              {/* <span className="user_meta__funding_wallet_lockstate text-xs">
                {lockLabel}
              </span>{" "} */}
              Funding Wallet Balance
            </div>
            <div className="flex gap-3 items-center">
              <div className="flex gap-1 items-center">
                <img src={solIcon} alt="Solana logo" />

                <div className="text-xs">
                  {Number(fundingSummary.sol || 0).toLocaleString(undefined, {
                    maximumFractionDigits: 4,
                  })}{" "}
                  SOL
                </div>
              </div>
              <div className="flex gap-1 items-center">
                <img src={pbpIcon} alt="PBP token logo" />

                <div className="text-xs">
                  {Number(fundingSummary.pbp || 0).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  PBP
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {debug && (
          <div className="debug-info text-xs opacity-80 flex gap-3">
            <span>
              {lockLabel}{" "}
              {status.signerMode ? ` mode: ${status.signerMode}` : ""}
            </span>
            <span>
              {status.signerWallet ? `wallet: ${status.signerWallet}` : ""}
            </span>
          </div>
        )}
      </div>
      <div className="flex  flex-col h-full right text-xs w-full text-right place-content-center-safe">
        <div className="flex items-center justify-end gap-2">
          <ConnectionBadge status={status} isAuthenticated={isAuthenticated} />
        </div>
        <div className="flex items-center justify-end gap-1 w-full">
          <StatusBadge running={status.running} />
          {typeof onManualClaim === "function" ? (
            <button
              type="button"
              className="btn btn-clear btn-xs p-0"
              title="Run manual claim/assign (c)"
              onClick={() => onManualClaim()}
              disabled={!status.running}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 640 640"
                className={`w-4 h-4 ${manualCheckBusy ? "animate-spin" : ""}`}
                fill="currentColor"
              >
                <path d="M320 96c123.7 0 224 100.3 224 224s-100.3 224-224 224S96 443.7 96 320c0-34.1 7.6-66.5 21.3-95.5l44.9 22.4C151.2 268 144 293.4 144 320c0 97.2 78.8 176 176 176s176-78.8 176-176S417.2 144 320 144c-47.4 0-90.4 18.7-122.1 49.2l58.1 58.1L112 304V160l51.8 51.8C203.2 163.2 258.3 96 320 96z" />
              </svg>
            </button>
          ) : null}
        </div>
        {debug && <span className="pid-label">PID {status.pid ?? "none"}</span>}
      </div>
    </section>
  );
}

function ConnectionBadge({ status, isAuthenticated }) {
  const conn = status?.mcpConnection || null;
  const state = String(conn?.state || "").toLowerCase();
  const label =
    state === "connected"
      ? "Connected"
      : state === "reconnecting"
        ? "Reconnecting"
        : state === "expired"
          ? "Expired Token"
          : isAuthenticated
            ? "Connected"
            : "Disconnected";
  const icon =
    state === "connected" || (state !== "expired" && isAuthenticated)
      ? { text: "●", cls: "text-success" }
      : state === "reconnecting"
        ? { text: "↻", cls: "text-sky-300" }
        : { text: "✕", cls: "text-error" };
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span className={icon.cls}>{icon.text}</span>
    </span>
  );
}
