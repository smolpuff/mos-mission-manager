import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./src/App";
import "./src/styles.css";

window.addEventListener("error", (event) => {
  try {
    console.error("[renderer] window.error", event?.error || event?.message || event);
  } catch {}
});

window.addEventListener("unhandledrejection", (event) => {
  try {
    console.error("[renderer] unhandledrejection", event?.reason || event);
  } catch {}
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
