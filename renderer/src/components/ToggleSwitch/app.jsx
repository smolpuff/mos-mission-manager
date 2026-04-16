import React from "react";

export default function ToggleSwitch({
  switchID,
  forID,
  title,
  defaultChecked,
  checked,
  onChange,
  onClick,
  disabled = false,
  name,
  value,
}) {
  return (
    <label
      htmlFor={forID || switchID}
      className="inline-flex items-center gap-3 cursor-pointer select-none"
    >
      <input
        id={switchID}
        name={name}
        value={value}
        type="checkbox"
        className="peer sr-only"
        defaultChecked={defaultChecked}
        checked={checked}
        onChange={onChange}
        onClick={onClick}
        disabled={disabled}
      />

      <span className="switch-wrap">
        <span className="switch-track" />
      </span>

      <span className="text-sm font-medium">{title}</span>
    </label>
  );
}
