import { useState } from "react";
import ToggleSwitch from "../components/ToggleSwitch/app";
import solIcon from "../img/icon-sm__sol.svg";

export default function SettingsPage({
  fundingEnabled,
  fundingSource,
  setFundingSource,
  setSignerMode,
  appWalletAddress,
  copyText,
  openExternalUrl,
  lockLabel,
  fundingWalletSummary,
  SlideNumberFormatted,
  openSecretModal,
  openCreateWalletModal,
  autoUpdateCheckEnabled,
  setAutoUpdateCheckEnabled,
  reducedMotionEnabled,
  setReducedMotionEnabled,
  onManualUpdateCheck,
  updateCheckBusy,
  updateCheckMessage,
}) {
  const [copyAddressLabel, setCopyAddressLabel] = useState("Copy Address");

  return (
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
                  const target =
                    fundingSource === "browser" ? "dapp" : "app_wallet";
                  await setSignerMode(target);
                })()
              }
            />
            <h1 className="text-2xl font-normal ">Funding Wallet</h1>{" "}
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
                  <div className="flex gap-2 items-center w-full justify-between">
                    <h2 className="text-base text-white">App Wallet</h2>
                    <span className="badge h-min uppercase border-transparent bg-white text-black text-[11px] place-self-center ">
                      Full Automation
                    </span>
                  </div>
                  <span className=" text-xs text-slate-300  ">
                    A dedicated self-custody wallet specifically for this app.
                    No approval needed.
                  </span>
                  <div className="flex font-semibold gap-2 mt-3  text-slate-300">
                    <img src={solIcon} className="w-4 h-4" alt="Solana logo" />
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
                  <h2 className="text-base text-white">Browser</h2>
                  <span className="signer-type_description text-xs  text-slate-300">
                    Transactions open in your browser wallet and must be
                    manually approved.
                  </span>
                </div>
              </label>
            </div>
          )}
        </div>

        {fundingEnabled && fundingSource === "app_wallet" ? (
          <div className="space-y-3">
            <h3 className="flex gap-4 sm border-b border-white/20 pb-1 justify-between">
              App Wallet Details
            </h3>
            <div className="flex items-center justify-between gap-3 leading-none">
              <label
                htmlFor="user__wallet-addres"
                className="text-xs uppercase leading-none text-slate-300"
              >
                Wallet Address
              </label>
              <button
                type="button"
                className="fill-white flex items-center gap-1 text-xs leading-none font-normal opacity-60 hover:cursor-pointer hover:fill-accent hover:text-accent hover:opacity-100 disabled:opacity-40"
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
                View on Explorer
              </button>
            </div>
            <div className="user__wallet-addres text-lg -mt-1">
              <div className="flex min-h-13 w-full items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 p-2 px-3">
                <div className="min-w-0 flex-1 truncate">
                  {appWalletAddress || "—"}
                </div>
                <button
                  type="button"
                  className="fill-white flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 font-normal text-xs hover:cursor-pointer hover:border-white/20 hover:bg-white/10 hover:fill-accent hover:text-accent disabled:opacity-50"
                  disabled={!appWalletAddress}
                  onClick={() => {
                    const value = appWalletAddress;
                    if (!value) return;
                    void copyText(value).then((ok) => {
                      setCopyAddressLabel(ok ? "Copied!" : "Copy failed");
                      setTimeout(
                        () => setCopyAddressLabel("Copy Address"),
                        1000,
                      );
                    });
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 640 640"
                    className="h-4 w-4"
                  >
                    <path d="M352 544L128 544C110.3 544 96 529.7 96 512L96 288C96 270.3 110.3 256 128 256L176 256L176 224L128 224C92.7 224 64 252.7 64 288L64 512C64 547.3 92.7 576 128 576L352 576C387.3 576 416 547.3 416 512L416 464L384 464L384 512C384 529.7 369.7 544 352 544zM288 384C270.3 384 256 369.7 256 352L256 128C256 110.3 270.3 96 288 96L512 96C529.7 96 544 110.3 544 128L544 352C544 369.7 529.7 384 512 384L288 384zM224 352C224 387.3 252.7 416 288 416L512 416C547.3 416 576 387.3 576 352L576 128C576 92.7 547.3 64 512 64L288 64C252.7 64 224 92.7 224 128L224 352z" />
                  </svg>
                  {copyAddressLabel}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-8">
              <div>
                <label
                  htmlFor="user-wallet__lock-status"
                  className="text-xs uppercase text-slate-300"
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
                  </div>
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
                    Loading app wallet summary...
                  </div>
                ) : null}
              </div>{" "}
            </div>{" "}
            <div className="flex gal=2 justify-between items-center">
              {" "}
              <button
                type="button"
                onClick={() => void openSecretModal()}
                className="text-sm   px-3 py-1.5 bg-[#9661E2] max-w-max rounded-sm hover:bg-[#5F0DD5] transition-colors"
              >
                View Secret Keys
              </button>{" "}
              <button
                className="btn btn-xs bg-error font-normal border-error rounded-sm not-disabled:hover:bg-error-content transition-all opacity-70 hover:opacity-100 "
                onClick={() => openCreateWalletModal()}
                type="button"
              >
                Generate New Wallet
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="mt-4 grid gap-4 grid-cols-2">
        <div className="card gap-4">
          <div className="space-y-4">
            <div className="flex items-center">
              <ToggleSwitch
                switchID="autoUpdateCheckEnabled"
                checked={autoUpdateCheckEnabled === true}
                onChange={(e) =>
                  void setAutoUpdateCheckEnabled(e.target.checked === true)
                }
              />
              <h1 className="text-2xl font-normal ">App Updates</h1>
            </div>
            <div className="text-xs text-slate-300">
              Atomatically check for a newer version when the app launches.
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-sm   px-3 py-1.5 bg-[#9661E2] max-w-max rounded-sm hover:bg-[#5F0DD5] transition-colors"
                onClick={() => void onManualUpdateCheck?.()}
                disabled={updateCheckBusy === true}
              >
                {updateCheckBusy === true ? "Checking..." : "Check Now"}
              </button>
              {updateCheckMessage ? (
                <div className="text-xs text-slate-300">
                  {updateCheckMessage}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="card gap-4">
          <div className="space-y-4">
            <div className="flex items-center">
              <ToggleSwitch
                switchID="reducedMotionEnabledSettings"
                checked={reducedMotionEnabled === true}
                onChange={(e) =>
                  void setReducedMotionEnabled(e.target.checked === true)
                }
              />
              <h1 className="text-2xl font-normal ">Reduced Motion</h1>
            </div>
            <div className="text-xs text-slate-300">
              Disable heavy motion effects like the mission fire animation to
              reduce CPU usage.
            </div>
            <div className="text-xs text-slate-400">
              Turning this off may cause higher resource usage.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
