import LoadingSpinner from "./LoadingSpinner";
import WalletOptionCards from "./WalletOptionCards";

export default function SetupWalletStep({
  value, onSelect, onContinue, busy, walletBusy, walletSlow,
  address, walletError, onCopy, copiedLabel,
  fundingAcknowledged, onFundingAcknowledgedChange,
}) {
  return (
    <WalletOptionCards
      value={value}
      onChange={onSelect}
      name="onboarding_signer_mode"
      includeManual
      stacked
      renderSelected={(option) => (
        <div className="space-y-3">
          {option.value === "app_wallet" ? (
            <>
              {walletBusy ? (
                <div className="flex items-center gap-2 text-xs text-slate-300" role="status">
                  <LoadingSpinner />
                  <span>{walletSlow ? "Still creating your wallet. Please keep the app open." : "Creating your wallet…"}</span>
                </div>
              ) : address ? (
                <div className="user__wallet-addres text-lg">
                  <div className="flex min-h-13 w-full items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 p-2 px-3 transition-all">
                    <div className="min-w-0 flex-1 truncate" title={address}>{address}</div>
                    <button
                      type="button"
                      className="fill-white flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 !px-2 !py-0.5 font-normal text-[11px] hover:cursor-pointer hover:border-white/20 hover:bg-white/10 hover:fill-accent hover:text-accent disabled:opacity-50"
                      onClick={onCopy}
                    >
                      {copiedLabel || "Copy address"}
                    </button>
                  </div>
                </div>
              ) : null}
              <p className="text-[11px] text-slate-400">Back up recovery keys: Settings → View Secret Keys.</p>
              {walletError ? <div className="text-xs text-error" role="alert">{walletError}</div> : null}
              <div className="flex items-center gap-3">
                <label className="flex flex-1 items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-xs !size-4 !rounded-sm border-white/50 shrink-0"
                    checked={fundingAcknowledged}
                    onChange={(event) => onFundingAcknowledgedChange(event.target.checked)}
                  />
                  <span>I understand I must add SOL + PBP to pay for resets. <span className="text-white">(Required)</span></span>
                </label>
                <button
                  type="button"
                  className="btn btn-gradient btn-sm text-shadow-sm text-shadow-black/40 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  onClick={onContinue}
                  disabled={busy || !fundingAcknowledged}
                >{walletBusy ? "Creating wallet…" : walletError ? "Retry" : "Continue"}</button>
              </div>
            </>
          ) : null}
          {option.value !== "app_wallet" ? (
            <div className="flex justify-end">
              <button
                type="button"
                className="btn btn-gradient btn-sm text-shadow-sm text-shadow-black/40"
                onClick={onContinue}
                disabled={busy}
              >Continue</button>
            </div>
          ) : null}
        </div>
      )}
    />
  );
}
