import React from "react";

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
}) {
  const stopDisabledInteraction = (event) => {
    if (!disabled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <label
      htmlFor={forID || switchID}
      className={`inline-flex items-center gap-3 select-none ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      }`}
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

      <span className="switch-wrap">
        <span className="switch-track" />
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
  );
}
