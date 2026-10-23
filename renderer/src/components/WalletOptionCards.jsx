export const walletOptions = [
  {
    value: "app_wallet",
    name: "In-App Wallet",
    setupTitle: "Let the app pay",
    setupDescription: "The app pays for every transaction automatically. No need to open the PBP site.",
    title: "Let the app pay and approve all transactions automatically",
    settingsDescription: "Pays for resets automatically.",
    description:
      "Creates a wallet inside this app to pay for all transactions. You own this funding wallet, keys stay on your computer.",
  },
  {
    value: "dapp",
    name: "Browser Wallet",
    setupTitle: "I'll approve each transaction",
    setupDescription: "Approve each transaction yourself on the PBP website.",
    settingsDescription: "Approve each reset on the PBP website.",
    title: "I’ll approve each transaction on the PBP website",
    description:
      "Opens a prepared transaction link on teh PBP website each time to approve.",
  },
  {
    value: "manual",
    name: "Manual",
    setupTitle: "I'll handle resets myself",
    setupDescription: "Open the PBP missions page and reset missions yourself.",
    title: "I’ll reset missions myself on the PBP website",
    description:
      "Opens the PBP missions page so you can perform the action yourself.",
  },
];

function WalletOptionArt({ type }) {
  return (
    <svg
      className="wallet-option-art"
      viewBox="0 0 88 74"
      fill="none"
      aria-hidden="true"
    >
      {type === "manual" ? (
        <>
          <rect
            x="18"
            y="7"
            width="49"
            height="59"
            rx="6"
            fill="#393126"
            stroke="#E2C398"
            strokeWidth="1.6"
          />
          <rect
            x="29"
            y="4"
            width="26"
            height="10"
            rx="4"
            fill="#705B40"
            stroke="#E2C398"
            strokeWidth="1.5"
          />
          <path
            d="M29 27H53M29 36H48M29 45H43"
            stroke="#C6AD8D"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M46 58L49 47L69 27L77 35L57 55L46 58Z"
            fill="#E8CAA0"
            stroke="#493927"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M49 47L57 55M66 30L74 38"
            stroke="#705B40"
            strokeWidth="1.6"
          />
          <path d="M46 58L49 51L53 55L46 58Z" fill="#493927" />
        </>
      ) : type === "dapp" ? (
        <>
          <rect
            x="10"
            y="10"
            width="66"
            height="48"
            rx="7"
            fill="#272333"
            stroke="#B99BD5"
            strokeWidth="1.6"
          />
          <path d="M11 23H75" stroke="#B99BD5" strokeOpacity=".45" />
          <circle cx="18" cy="17" r="1.5" fill="#E3BFF1" />
          <circle cx="24" cy="17" r="1.5" fill="#E3BFF1" fillOpacity=".6" />
          <path
            d="M20 32H43M20 38H35"
            stroke="#A498B7"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <rect
            x="20"
            y="45"
            width="27"
            height="6"
            rx="3"
            fill="#D496EB"
            fillOpacity=".35"
          />
          <path
            d="M61 39L64 65L69 58L77 57L61 39Z"
            fill="#F0DDF8"
            stroke="#41314F"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M76 8L77 4M81 12L85 11"
            stroke="#D496EB"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <path
            d="M18 28L23 9L62 18L59 35"
            fill="#355B49"
            stroke="#99D9B2"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M30 18L53 23"
            stroke="#A9E7BE"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M13 29C13 25 16 23 20 23H64V59H20C16 59 13 56 13 52V29Z"
            fill="#263C34"
            stroke="#9ED9B2"
            strokeWidth="1.6"
          />
          <path d="M14 30H64" stroke="#9ED9B2" strokeOpacity=".4" />
          <rect
            x="51"
            y="36"
            width="20"
            height="15"
            rx="4"
            fill="#456C56"
            stroke="#B0E7C2"
            strokeWidth="1.5"
          />
          <circle cx="58" cy="43.5" r="2" fill="#D7F7E1" />
          <circle
            cx="29"
            cy="53"
            r="13"
            fill="#B1DDBB"
            stroke="#DBF5DF"
            strokeWidth="1.5"
          />
          <path d="M29 45L25 53H31L28 61L35 50H29L32 45H29Z" fill="#355B49" />
          <path
            d="M72 19V13M69 16H75"
            stroke="#BAE8C8"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

export default function WalletOptionCards({
  value,
  onChange,
  name,
  includeManual = false,
  stacked = false,
  walletNameFirst = false,
  actionHeading = !walletNameFirst,
  showDescription = !walletNameFirst,
  recommendAppWallet = false,
  renderSelected,
}) {
  return (
    <fieldset className={`signer-type min-w-0 ${stacked ? "flex-col" : ""}`}>
      <legend className="sr-only">Choose a wallet option</legend>
      {walletOptions
        .filter((option) => includeManual || option.value !== "manual")
        .map((option) => (
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
              <div className={`${walletNameFirst ? "space-y-0" : "space-y-2"} min-w-0 w-full`}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-base text-white inline-flex items-center gap-2">
                    {actionHeading ? (option.setupTitle || option.title) : option.name}
                    {walletNameFirst && option.value === "app_wallet" ? (
                      <span
                        className="control-tooltip settings-help"
                        role="img"
                        aria-label="You own this funding wallet. Its keys stay on your computer."
                        tabIndex={0}
                        data-tooltip="You own this funding wallet. Its keys stay on your computer."
                        onClick={(event) => event.preventDefault()}
                      >
                        ?
                      </span>
                    ) : null}
                  </h2>
                  {option.value === "app_wallet" ? (
                    <span className="badge absolute top-3 right-2 z-2 h-min uppercase border-transparent bg-white text-black text-[11px]">
                      Full Automation
                    </span>
                  ) : null}
                </div>
                <div className={`flex items-center gap-2 ${walletNameFirst ? "wallet-option-summary" : ""}`}>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className={`text-xs ${actionHeading ? "text-secondary font-semibold tracking-wide" : "text-slate-300 leading-snug"}`}>
                      {actionHeading ? option.name : option.title}
                    </div>
                    {showDescription ? (
                      <div className="text-xs text-slate-300">
                        {actionHeading ? (option.setupDescription || option.description) : (option.settingsDescription || option.description)}
                      </div>
                    ) : null}
                    {recommendAppWallet && option.value === "app_wallet" ? (
                      <p className="text-xs text-success font-medium">
                        Recommended: The only option for full automation.
                      </p>
                    ) : null}
                  </div>
                  <WalletOptionArt type={option.value} />
                </div>
              </div>
            </label>
            {value === option.value && renderSelected ? (
              <div className="pl-7 w-full min-w-0">
                {renderSelected(option)}
              </div>
            ) : null}
          </div>
        ))}
    </fieldset>
  );
}
