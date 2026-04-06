"use strict";

function randInt(max) {
  return Math.floor(Math.random() * max);
}

function pad(text, width) {
  const t = String(text || "").slice(0, width);
  return t + " ".repeat(Math.max(0, width - t.length));
}

function scramble(text, pct = 0.32) {
  const pool = ".:;=+*#%@/\\|[]{}<>~";
  let out = "";
  for (const ch of String(text || "")) {
    if (ch === " " || randInt(100) > Math.floor(pct * 100)) out += ch;
    else out += pool[randInt(pool.length)];
  }
  return out;
}

function staticLine(width, density = 0.2) {
  const pool = " .:;=+*#%@/\\|[]{}<>~";
  let out = "";
  for (let i = 0; i < width; i += 1) {
    if (randInt(100) < Math.floor(density * 100))
      out += pool[randInt(pool.length)];
    else out += " ";
  }
  return out;
}

function randomGlyph() {
  const pool = " .:;=+*#%@/\\|[]{}<>~";
  return pool[randInt(pool.length)];
}

function normalizeTargetLine(line, cols) {
  const text = String(line || "").replace(/\x1b\[[0-9;]*m/g, "");
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) out += ch;
    else out += " ";
    if (out.length >= cols) break;
  }
  return out.padEnd(cols, " ");
}

function blendTargetInChunks(lines, targetLines, progress) {
  if (!Array.isArray(targetLines) || targetLines.length === 0) return lines;
  const rows = lines.length;
  const cols = lines.reduce((m, l) => Math.max(m, String(l || "").length), 0);
  const target = targetLines.map((l) => normalizeTargetLine(l, cols));
  const revealPct = Math.max(0, Math.min(95, Math.floor(progress * 0.9)));
  if (revealPct <= 0) return lines;

  const out = lines.slice();
  const chunkW = 4;
  const chunkH = 2;
  for (let r = 0; r < rows; r += 1) {
    let row = String(out[r] || "").padEnd(cols, " ");
    const src = target[r] || "".padEnd(cols, " ");
    for (let c = 0; c < cols; c += 1) {
      const blockR = Math.floor(r / chunkH);
      const blockC = Math.floor(c / chunkW);
      // Stable hash so revealed chunks stay visible as progress grows.
      const hash = (blockR * 37 + blockC * 17 + 13) % 100;
      if (hash < revealPct) {
        row = row.slice(0, c) + src[c] + row.slice(c + 1);
      }
    }
    out[r] = row;
  }
  return out;
}

async function revealScreenInChunks(lines, options = {}) {
  const chunks = Math.max(1, Number(options.chunks ?? 4));
  const durationMs = Math.max(0, Number(options.durationMs ?? 800));
  const stepMs = Math.max(20, Math.floor(durationMs / chunks));
  const rows = lines.length;
  const cols = lines.reduce((m, l) => Math.max(m, String(l || "").length), 0);
  const total = rows * cols;
  const order = Array.from({ length: total }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (let step = 1; step <= chunks; step += 1) {
    const revealCount = Math.floor((step / chunks) * total);
    const shown = new Set(order.slice(0, revealCount));
    process.stdout.write("\x1b[H\x1b[2J");
    for (let r = 0; r < rows; r += 1) {
      const src = String(lines[r] || "").padEnd(cols, " ");
      let row = "";
      for (let c = 0; c < cols; c += 1) {
        const idx = r * cols + c;
        row += shown.has(idx) ? src[c] : randomGlyph();
      }
      process.stdout.write(row + "\n");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function renderFxFrame(
  ctx,
  tick,
  elapsedMs = 0,
  handoff = 0,
  targetLines = null,
) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const width = Math.max(52, Math.min(cols - 2, 100));
  const inner = width - 4;
  const boxHeight = 7;

  const progress = Math.max(
    0,
    Math.min(100, Number(ctx.startupFxProgress || 0)),
  );
  const statusByPhase =
    progress < 34
      ? "missions-v3-mcp :: bootstrapping channel"
      : progress < 46
        ? "missions-v3-mcp :: authenticating session"
        : progress < 85
          ? "missions-v3-mcp :: syncing mission and NFTs"
          : "missions-v3-mcp :: ready";

  const movieLines = [
    "[JOEY'S ON THE LINE.]",
    "[PROTECT JOEY. HOLD THE CHANNEL.]",
    "[JOEY LOCKED IN. TRACE COLD.]",
    "[DEPHLECT NODE: JOEY PRIORITY ROUTE.]",
    "[WE'RE IN. DON'T TOUCH THE KEYBOARD.]",
    "[PATCH IT FAST. NO FOOTPRINTS.]",
    "[STATIC'S HOT. KEEP IT QUIET.]",
    "[ONE MORE PUSH AND WE'RE GHOST.]",
  ];

  const title = "missions-v3-mcp";
  const line2 = "[r00ting the merbalznet]";
  const holdMs = 1800;
  const quote = movieLines[Math.floor(elapsedMs / holdMs) % movieLines.length];
  const scramblePct = Math.max(0, 0.12 * (1 - handoff));
  const status = scramble(statusByPhase, scramblePct);
  const noiseA = scramble(
    "##########################",
    Math.max(0, 0.5 * (1 - handoff)),
  );
  const noiseB = scramble(
    "##########################",
    Math.max(0, 0.5 * (1 - handoff)),
  );

  let lines = [];
  for (let r = 0; r < rows; r += 1) {
    const baseDensity = r % 3 === tick % 3 ? 0.3 : 0.16;
    const density = Math.max(0, baseDensity * (1 - handoff));
    lines.push(staticLine(cols, density));
  }
  lines = blendTargetInChunks(lines, targetLines, progress);

  const left = Math.max(0, Math.floor((cols - width) / 2));
  const top = Math.max(0, Math.floor((rows - boxHeight) / 2) - 2);
  const box = [
    "╔" + "═".repeat(width - 2) + "╗",
    `║ ${pad(title, inner)} ║`,
    `║ ${pad(line2, inner)} ║`,
    `║ ${pad(noiseA, inner)} ║`,
    `║ ${pad(quote, inner)} ║`,
    `║ ${pad(`${status}  ${noiseB}`, inner)} ║`,
    "╚" + "═".repeat(width - 2) + "╝",
  ];

  for (let i = 0; i < box.length; i += 1) {
    const row = top + i;
    if (row < 0 || row >= lines.length) continue;
    const base = lines[row];
    const before = base.slice(0, left);
    const after = base.slice(Math.min(base.length, left + box[i].length));
    lines[row] = before + box[i] + after;
  }

  const chunkSize = 3;
  const barWidthRaw = Math.max(24, Math.min(width - 12, 66));
  const totalChunks = Math.max(1, Math.floor(barWidthRaw / chunkSize));
  const barWidth = totalChunks * chunkSize;
  const filledChunks = Math.floor((progress / 100) * totalChunks);
  const fillCells = filledChunks * chunkSize;
  const bar =
    "█".repeat(fillCells) + " ".repeat(Math.max(0, barWidth - fillCells));
  const shownPct = Math.floor((filledChunks / totalChunks) * 100);
  const pct = `${String(shownPct).padStart(3, " ")}%`;
  const barText = `[${bar}] ${pct}`;
  const barLeft = Math.max(0, Math.floor((cols - barText.length) / 2));
  const barRow = Math.min(lines.length - 1, top + box.length + 1);
  const label = "INITIALIZING...";
  const labelLeft = Math.max(0, Math.floor((cols - label.length) / 2));
  const labelRow = Math.max(0, barRow - 1);
  if (labelRow >= 0 && labelRow < lines.length) {
    const base = lines[labelRow];
    const before = base.slice(0, labelLeft);
    const after = base.slice(Math.min(base.length, labelLeft + label.length));
    lines[labelRow] = before + label + after;
  }
  if (barRow >= 0 && barRow < lines.length) {
    const base = lines[barRow];
    const before = base.slice(0, barLeft);
    const after = base.slice(Math.min(base.length, barLeft + barText.length));
    lines[barRow] = before + barText + after;
  }

  const out = lines.map((ln) =>
    String(ln || "")
      .slice(0, cols)
      .padEnd(cols, " "),
  );
  process.stdout.write("\x1b[H\x1b[2J");
  process.stdout.write(out.join("\n"));
}

function startStartupFx(ctx, options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) return () => {};

  const frameMs = Number(options.frameMs ?? 95);
  const getTargetLines =
    typeof options.getTargetLines === "function"
      ? options.getTargetLines
      : () => [];
  const startedAt = Date.now();
  let tick = 0;
  let liveProgress = Math.max(
    0,
    Math.min(100, Number(ctx.startupFxProgress || 0)),
  );
  let handoffProgress = 0;
  let handoffMode = false;
  ctx.startupFxActive = true;
  ctx.startupFxProgress = liveProgress;

  renderFxFrame(ctx, tick, 0, handoffProgress, getTargetLines());
  const timer = setInterval(() => {
    tick += 1;
    const elapsedMs = Date.now() - startedAt;
    if (!handoffMode) {
      const target = Math.max(
        0,
        Math.min(100, Number(ctx.startupFxProgress || 0)),
      );
      if (liveProgress < target) {
        liveProgress = Math.min(target, liveProgress + 2);
      } else if (liveProgress > target) {
        liveProgress = target;
      }
      ctx.startupFxProgress = liveProgress;
    }
    renderFxFrame(ctx, tick, elapsedMs, handoffProgress, getTargetLines());
  }, frameMs);

  return async ({
    transitionMs = 2000,
    fullyVisibleMs = 1000,
    finalRampMs = 1800,
  } = {}) => {
    const rampDuration = Math.max(0, Number(finalRampMs) || 0);
    const frames = Math.max(1, Math.floor(rampDuration / frameMs));
    const remaining = Math.max(0, 100 - liveProgress);
    const step = remaining > 0 ? Math.max(1, Math.ceil(remaining / frames)) : 0;

    while (liveProgress < 100) {
      liveProgress = Math.min(100, liveProgress + step);
      ctx.startupFxProgress = liveProgress;
      renderFxFrame(
        ctx,
        tick + 1,
        Date.now() - startedAt,
        handoffProgress,
        getTargetLines(),
      );
      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }

    handoffMode = true;
    renderFxFrame(
      ctx,
      tick,
      Date.now() - startedAt,
      handoffProgress,
      getTargetLines(),
    );
    const start = Date.now();
    const duration = Math.max(0, Number(transitionMs || 0));
    while (Date.now() - start < duration) {
      const elapsed = Date.now() - start;
      handoffProgress = Math.min(1, elapsed / duration);
      await new Promise((resolve) => setTimeout(resolve, frameMs));
    }
    handoffProgress = 1;
    renderFxFrame(
      ctx,
      tick + 1,
      Date.now() - startedAt,
      handoffProgress,
      getTargetLines(),
    );
    if (fullyVisibleMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Number(fullyVisibleMs) || 0),
      );
    }
    clearInterval(timer);
    ctx.startupFxActive = false;
  };
}

module.exports = {
  startStartupFx,
  revealScreenInChunks,
};
