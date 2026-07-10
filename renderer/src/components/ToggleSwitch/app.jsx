export default function ToggleSwitch({
  switchID,
  forID,
  title,
  helperText,
  defaultChecked,
  checked,
  onChange,
  onClick,
  disabled = false,
  name,
  value,
  styling,
  size = "default",
  switchWrapClassName = "",
  tinyStateText = false,
}) {
  const stopDisabledInteraction = (event) => {
    if (!disabled) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const hasInlineLabel = Boolean(String(title || "").trim() || helperText);

  return (
    <div className={`flex gap-2 justify-between ${hasInlineLabel ? "w-full" : "w-auto"}`}>
      <div>
        <label
          htmlFor={forID || switchID}
          className={`inline-flex items-center select-none ${
            size === "tiny" ? "gap-2" : "gap-3"
          } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
          aria-disabled={disabled}
          onClickCapture={stopDisabledInteraction}
          onMouseDownCapture={stopDisabledInteraction}
          onPointerDownCapture={stopDisabledInteraction}
        >
          <input
            id={switchID}
            name={name}
            value={value}
            type="checkbox"
            className="peer sr-only"
            defaultChecked={defaultChecked}
            checked={checked}
            onChange={(event) => {
              if (disabled) return;
              onChange?.(event);
            }}
            onClick={(event) => {
              if (disabled) return;
              onClick?.(event);
            }}
            disabled={disabled}
          />

          <span
            className={`switch-wrap ${size === "tiny" ? "switch-wrap--tiny" : ""} ${tinyStateText ? "switch-wrap--tiny-state-text" : ""} ${switchWrapClassName}`}
          >
            <span className="switch-track" />
            {tinyStateText ? (
              <span className="switch-state-text" aria-hidden="true">
                {checked ? "On" : "Off"}
              </span>
            ) : null}
          </span>

          <span
            className={`flex flex-col gap-0 text-sm  ${
              disabled ? "" : ""
            } ${styling}`}
          >
            <span>{title}</span>

            {helperText ? (
              <span className="text-[11px] text-slate-400 leading-tight font-normal">
                {helperText}
              </span>
            ) : null}
          </span>
        </label>
      </div>
    </div>
  );
}
