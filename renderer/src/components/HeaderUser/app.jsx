import React from "react";
import solIcon from "../../img/icon-sm__sol.svg";
import pbpIcon from "../../img/icon-sm__pbp.webp";
import StatusBadge from "../StatusBadge/app";

export default function HeaderUser({
  lockLabel,
  status,
  debug,
  isAuthenticated,
}) {
  return (
    <section className="space-y-0 grid grid-cols-[70%_auto]" id="app__header">
      <div className="left">
        <h1 className="text-2xl user_meta__username">rmrfkorea </h1>
        <div className="user_meta__funding_wallet flex gap-3 items-center">
          <div className="text-xs mt-1">
            <span className="user_meta__funding_wallet_lockstate text-xs">
              {lockLabel}
            </span>{" "}
            Funding Wallet Balance
          </div>
          <div className="flex gap-3 items-center">
            <div className="flex gap-1 items-center">
              <div>
                <img src={solIcon} alt="Solana logo" />
              </div>
              <div className="text-xs">0.12 SOL</div>
            </div>
            <div className="flex gap-1 items-center">
              <div>
                <img src={pbpIcon} alt="PBP token logo" />
              </div>
              <div className="text-xs">69,433.34 PBP</div>
            </div>
          </div>
        </div>
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
        <span>Connected {isAuthenticated && <span>s</span>}</span>
        <StatusBadge running={status.running} />
        {debug && <span className="pid-label">PID {status.pid ?? "none"}</span>}
      </div>
    </section>
  );
}
