"use strict";

function createLogger(ctx) {
  let winkUntilMs = 0;
  let nextWinkAtMs = Date.now() + 2500 + Math.floor(Math.random() * 4500);

  function debugString(meta = {}) {
    const entries = Object.entries(meta).filter(
      ([, v]) => v !== undefined && v !== null,
    );
    if (entries.length === 0) return "";
    return entries
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  }

  function getDisplayWidth(str) {
    let width = 0;
    for (const char of String(str || "")) {
      const code = char.codePointAt(0);
      if (
        (code >= 0x1f300 && code <= 0x1faff) ||
        (code >= 0x2600 && code <= 0x26ff) ||
        (code >= 0x2700 && code <= 0x27bf)
      ) {
        width += 2;
      } else {
        width += 1;
      }
    }
    return width;
  }

  function nextGiraffeFrame() {
    const now = Date.now();
    if (now >= winkUntilMs && now >= nextWinkAtMs) {
      winkUntilMs = now + 500;
      nextWinkAtMs = now + 500 + Math.floor(Math.random() * 7000);
    }
    const winking = now < winkUntilMs;
    return [
      "(\\(\\     ",
      winking ? "/.* )    " : "/.. )    ",
      "(_. -'\\   ",
      "  \\#\\  ",
      "  \\#\\ ",
      "",
    ];
  }

  function padDisplayRight(str, width) {
    const text = String(str || "");
    const padLen = width - getDisplayWidth(text);
    return text + " ".repeat(Math.max(0, padLen));
  }

  function composeHeaderLine(left, right, innerWidth) {
    const leftText = String(left || "");
    const rightText = String(right || "");
    if (!rightText) return padDisplayRight(leftText, innerWidth);
    const rightWidth = getDisplayWidth(rightText);
    const leftMaxWidth = Math.max(0, innerWidth - rightWidth - 1);
    let clippedLeft = leftText;
    while (
      getDisplayWidth(clippedLeft) > leftMaxWidth &&
      clippedLeft.length > 0
    ) {
      clippedLeft = clippedLeft.slice(0, -1);
    }
    const leftWidth = getDisplayWidth(clippedLeft);
    const gapWidth = Math.max(1, innerWidth - leftWidth - rightWidth);
    return `${clippedLeft}${" ".repeat(gapWidth)}${rightText}`;
  }

  function padBlockRight(lines = []) {
    const width = lines.reduce(
      (max, line) => Math.max(max, getDisplayWidth(line)),
      0,
    );
    return lines.map(
      (line) => " ".repeat(Math.max(0, width - getDisplayWidth(line))) + line,
    );
  }

  function buildHeaderLines(stats = ctx.currentMissionStats) {
    const termWidth = process.stdout.columns || 78;
    const boxWidth = Math.max(termWidth, 40);
    const innerWidth = boxWidth - 4;
    const resetStatus = ctx.level20ResetEnabled ? "ON" : "OFF";
    const modeStatus = ctx.missionModeEnabled
      ? `mission (${ctx.currentMissionResetLevel} reset)`
      : "normal";
    const status = ctx.watcherRunning ? "🟢 running" : "🔴 stopped";
    const totalClaimed =
      typeof ctx.config.totalClaimed === "number" ? ctx.config.totalClaimed : 0;
    const giraffe = padBlockRight(nextGiraffeFrame());

    const lines = [
      composeHeaderLine(
        `${ctx.APP_NAME} ${ctx.APP_VERSION}`,
        giraffe[0],
        innerWidth,
      ),
      composeHeaderLine(status, giraffe[1], innerWidth),
      composeHeaderLine(
        `mode: ${modeStatus} | lvl20 reset: ${resetStatus}`,
        giraffe[2],
        innerWidth,
      ),
      composeHeaderLine("", giraffe[3], innerWidth),
      composeHeaderLine(
        `🙀 ${ctx.currentUserDisplayName || "unknown user"}`,
        giraffe[4],
        innerWidth,
      ),
      composeHeaderLine(
        `✅ ${stats.claimed}(${totalClaimed}) claimed | 🤑 ${stats.claimable} claimable | 🎯 ${stats.active} active | 🥞 ${stats.available} ready | 💎 ${stats.nftsAvailable ?? 0} NFTs`,
        giraffe[5],
        innerWidth,
      ),
    ];

    const out = [];
    out.push("╔" + "═".repeat(boxWidth - 2) + "╗");
    for (const line of lines) {
      const padded = padDisplayRight(line, innerWidth);
      out.push(`║ ${padded} ║`);
    }
    out.push("╚" + "═".repeat(boxWidth - 2) + "╝");
    out.push("");
    return out;
  }

  function printHeaderArea(stats = ctx.currentMissionStats) {
    const lines = buildHeaderLines(stats);
    for (const l of lines) console.log(l);
  }

  function getLogAreaLines() {
    const HEADER_LINES = 12;
    const totalRows = process.stdout.rows || 24;
    return Math.max(3, totalRows - HEADER_LINES);
  }

  function redrawHeaderAndLog(stats = ctx.currentMissionStats) {
    if (ctx.startupFxActive) return;
    process.stdout.write("\x1b[H\x1b[2J");
    const lines = getScreenLines(stats);
    for (const l of lines) process.stdout.write(l + "\n");
  }

  function getScreenLines(stats = ctx.currentMissionStats) {
    const out = [];
    out.push(...buildHeaderLines(stats));
    const logLines = getLogAreaLines();
    const start = Math.max(0, ctx.logBuffer.length - logLines);
    const visibleLogs = ctx.logBuffer.slice(start);
    for (let i = 0; i < logLines; i += 1) {
      const line = visibleLogs[i] || "";
      out.push(line.padEnd(78, " "));
    }
    return out;
  }

  function logWithTimestamp(message, stats = ctx.currentMissionStats) {
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const line = `[${timestamp}] ${message}`;
    ctx.logBuffer.push(line);
    const maxSize = ctx.debugMode
      ? ctx.LOG_BUFFER_SIZE_DEBUG
      : ctx.LOG_BUFFER_SIZE;
    if (ctx.logBuffer.length > maxSize) ctx.logBuffer.shift();
    if (ctx.startupFxActive) return;
    redrawHeaderAndLog(stats);
  }

  function logDebug(scope, action, meta = {}) {
    if (!ctx.debugMode) return;
    const scopeKey = String(scope || "general").toLowerCase();
    if (ctx.startupComplete && !["watch", "assign", "auth"].includes(scopeKey))
      return;
    const scopeTag = String(scope || "general").toUpperCase();
    const suffix = debugString(meta);
    const msg = suffix
      ? `[DEBUG] [${scopeTag}] ${action} | ${suffix}`
      : `[DEBUG] [${scopeTag}] ${action}`;
    logWithTimestamp(msg);
  }

  function clearLogBuffer() {
    ctx.logBuffer = [];
    if (ctx.startupFxActive) return;
    redrawHeaderAndLog(ctx.currentMissionStats);
  }

  return {
    getDisplayWidth,
    printHeaderArea,
    getLogAreaLines,
    redrawHeaderAndLog,
    getScreenLines,
    logWithTimestamp,
    logDebug,
    clearLogBuffer,
  };
}

module.exports = {
  createLogger,
};
