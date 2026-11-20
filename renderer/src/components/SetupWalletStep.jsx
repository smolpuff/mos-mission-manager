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
      walletNameFirst
      actionHeading
      showDescription
      recommendAppWallet
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
                  <div className="wallet-funding-address flex min-h-13 w-full items-center gap-3 rounded-lg p-2 px-3 transition-all">
                    <div className="min-w-0 flex-1 truncate" title={address}>{address}</div>
                    <button
                      type="button"
                      className="fill-white flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 !px-2 !py-0.5 font-normal text-[11px] hover:cursor-pointer hover:border-white/20 hover:bg-white/10 hover:fill-accent hover:text-accent disabled:opacity-50"
                      onClick={onCopy}
                    >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 640 640"
                    className="h-3 w-3"
                  >
                    <path d="M352 544L128 544C110.3 544 96 529.7 96 512L96 288C96 270.3 110.3 256 128 256L176 256L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L384 464L384 512C384 529.7 369.7 544 352 544zM288 384C270.3 384 256 369.7 256 352L256 128C256 110.3 270.3 96 288 96L512 96C529.7 96 544 110.3 544 128L544 352C544 369.7 529.7 384 512 384L288 384zM224 352C224 387.3 252.7 416 288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352z" />
                  </svg>
                      {copiedLabel || "Copy"}
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
                  <span>I understand I must fund this wallet with SOL + PBP to enable full automation.</span>
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
