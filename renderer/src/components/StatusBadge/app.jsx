import React from "react";

export default function StatusBadge({ running, styling }) {
  return (
    <span className={`${styling} ${running}`}>
      {running ? "Watching Missions..." : "Stopped"}
    </span>
  );
}
