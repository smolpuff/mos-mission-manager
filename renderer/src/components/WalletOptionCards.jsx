export const walletOptions = [
  {
    value: "app_wallet",
    name: "In-App Wallet",
    title: "Let the app do it",
    description: "Creates your wallet inside this app for transactions. Your main wallet stays separate. You own it, not the developer; keys stay on your computer.",
  },
  {
    value: "dapp",
    name: "Browser Wallet",
    title: "I’ll approve each reset",
    description: "Opens a signing link each time. Connect your wallet and approve it there.",
  },
  {
    value: "manual",
    name: "Manual",
    title: "I’ll reset on PBP",
    description: "Opens the PBP missions page so you can perform the reset yourself.",
  },
];

export default function WalletOptionCards({ value, onChange, name, includeManual = false, stacked = false, renderSelected }) {
  return (
    <fieldset className={`signer-type min-w-0 ${stacked ? "flex-col" : ""}`}>
      <legend className="sr-only">Choose a wallet option</legend>
      {walletOptions.filter((option) => includeManual || option.value !== "manual").map((option) => (
        <div
          key={option.value}
          className={`${option.value === "app_wallet" ? "signer-type__app" : "signer-type__browser"} !flex-col items-start min-w-0`}
        >
          <label className="flex items-start gap-2 w-full cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.value}
              className="fake-checkbox-radio shrink-0"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <div className="space-y-2 min-w-0 w-full">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h2 className="text-base text-white">{option.title}</h2>
                {option.value === "app_wallet" ? (
                  <span className="badge h-min uppercase border-transparent bg-white text-black text-[11px]">
                    Full Automation
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-white">{option.name}</div>
              <div className="text-xs text-slate-300">{option.description}</div>
            </div>
          </label>
          {value === option.value && renderSelected ? (
            <div className="pl-7 w-full min-w-0">{renderSelected(option)}</div>
          ) : null}
        </div>
      ))}
    </fieldset>
  );
}
