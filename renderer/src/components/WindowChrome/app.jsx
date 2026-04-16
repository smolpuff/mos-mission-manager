import React from "react";
import useDesktopBridge from "../useDesktopBridge";

export default function WindowChrome({ title, subtitle, styling }) {
  const bridge = useDesktopBridge();

  return (
    <header className={`window-chrome ${styling}`}>
      <div className="window-actions">
        <button
          className="window-button window-button-close"
          type="button"
          aria-label="Close window"
          onClick={() => bridge.closeWindow()}
        >
          <span />
        </button>
        <button
          className="window-button window-button-min"
          type="button"
          aria-label="Minimize window"
          onClick={() => bridge.minimizeWindow()}
        >
          <span />
        </button>
      </div>
      <div className="window-drag">
        <div className="window-title-wrap">
          <h1 className="chrome-title">{title}</h1>
        </div>
      </div>
      <div className="window-actions-spacer" />
    </header>
  );
}
