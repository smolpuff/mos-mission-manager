"use strict";

const { withHeadlessWindow } = require("./headless");

const COMPETITIONS_URL =
  "https://pixelbypixel.studio/missions/competitions";

function coerceText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || null;
}

async function scrapeLatestCompetition(opts = {}) {
  const competitionPick = ["first", "second", "last", "active"].includes(opts?.competitionPick)
    ? opts.competitionPick
    : "first";
  return withHeadlessWindow(
    COMPETITIONS_URL,
    // Allow styles; some sites hide/replace content until CSS/JS finishes loading.
    // Still block heavier assets to keep it low-memory.
    { timeoutMs: 35_000, blockResources: true, partition: "persist:pbp-scrape", preserveStorage: true },
    async (win) => {
      const result = await win.webContents.executeJavaScript(
        `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const coerceText = (v) => String(v || "").replace(/\\s+/g, " ").trim();
  const looksLikeChallenge = (text) => {
    const t = String(text || "");
    return (
      /checking your browser/i.test(t) ||
      /cloudflare/i.test(t) ||
      /attention required/i.test(t) ||
      /ddos/i.test(t) ||
      /verify you are human/i.test(t)
    );
  };

  const getCompetitionSearchRoot = () =>
    document.querySelector("main") || document.body;

  const findCompetitionHeaders = () => {
    const nodes = Array.from(getCompetitionSearchRoot().querySelectorAll("*"));
    const headers = nodes
      .filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return false;
        const t = coerceText(el.innerText);
        if (!t) return false;
        // Header should basically be "Competition 17" / "Competition #17"
        if (!/^competition\\s*#?\\s*\\d{1,6}\\b/i.test(t)) return false;
        // Avoid giant containers that happen to include the header and much more text.
        return t.length <= 96;
      })
      .sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    return headers;
  };

  const extractHeaderNumber = (headerEl) => {
    const t = coerceText(headerEl?.innerText || "");
    const m = t.match(/^competition\\s*#?\\s*(\\d{1,6})\\b/i);
    return m ? String(m[1]) : null;
  };

  const findCompetitionHeaderByNumber = (competitionNumber) => {
    if (!competitionNumber) return null;
    const headers = findCompetitionHeaders();
    return (
      headers.find(
        (header) => extractHeaderNumber(header) === String(competitionNumber),
      ) || null
    );
  };

  const pickCompetitionContainerForHeader = (headerEl) => {
    if (!headerEl) return null;
    const allHeaders = findCompetitionHeaders();
    const isOtherHeaderInside = (el) =>
      allHeaders.some((h) => h !== headerEl && el.contains(h));

    let cur = headerEl;
    let depth = 0;
    while (cur && cur !== document.body && depth < 14) {
      // We want the smallest ancestor that contains this header but no other competition header.
      if (
        cur !== headerEl &&
        /^(div|section|article|li)$/i.test(String(cur.tagName || "")) &&
        cur.contains(headerEl) &&
        !isOtherHeaderInside(cur)
      ) {
        const t = coerceText(cur.innerText);
        if (t && /\\bstart\\b/i.test(t) && /\\bend\\b/i.test(t)) return cur;
      }
      cur = cur.parentElement;
      depth += 1;
    }
    return headerEl.closest("article, section, div") || headerEl.parentElement;
  };

  const scoreCompetitionContainer = (el) => {
    const t = coerceText(el?.innerText || "");
    if (!t) return { ok: false, score: -1, len: 0 };
    const compMatch = t.match(/competition\\s*#?\\s*(\\d{1,6})/i);
    const hasStart = /\\bstart\\b/i.test(t);
    const hasEnd = /\\bend\\b/i.test(t);
    const hasPrizes = /\\bprize(s)?\\b/i.test(t);
    const hasMissions = /\\bmissions?\\b/i.test(t);
    const hasResults = /\\bresults?\\b/i.test(t) || /\\brank\\b/i.test(t);
    const ok = Boolean(compMatch) && hasStart && hasEnd;
    const len = t.length;
    const score =
      (compMatch ? 10 : 0) +
      (hasStart ? 6 : 0) +
      (hasEnd ? 6 : 0) +
      (hasMissions ? 2 : 0) +
      (hasPrizes ? 2 : 0) +
      (hasResults ? 2 : 0) -
      Math.min(25, Math.floor(len / 400));
    return { ok, score, len, number: compMatch ? String(compMatch[1]) : null };
  };

  const findCompetitionCardsFromContainers = () => {
    const candidates = Array.from(
      getCompetitionSearchRoot().querySelectorAll("article, section, li, div"),
    )
      .map((el) => ({ el, ...scoreCompetitionContainer(el) }))
      .filter((item) => item.ok)
      .sort((a, b) => b.score - a.score || a.len - b.len);

    const picked = [];
    const seenNumbers = new Set();
    for (const item of candidates) {
      if (!item?.el || !item?.number) continue;
      if (seenNumbers.has(item.number)) continue;
      // Skip broad wrappers once a smaller matching card for the same area is already selected.
      const containsPicked = picked.some((chosen) => item.el.contains(chosen));
      if (containsPicked) continue;
      picked.push(item.el);
      seenNumbers.add(item.number);
      if (picked.length >= 10) break;
    }
    return picked;
  };

  const findCompetitionCardsFromText = () => {
    const searchRoot = getCompetitionSearchRoot();
    const textNodes = Array.from(searchRoot.querySelectorAll("*"))
      .filter((el) => {
        if (!el) return false;
        const t = coerceText(el.innerText);
        return (
          t &&
          /^competition\\s*#?\\s*\\d{1,6}\\b/i.test(t) &&
          t.length <= 96
        );
      });
    const cards = [];
    const seen = new Set();
    for (const el of textNodes) {
      const card =
        el.closest("[class*='competition'], article, section, li, div") ||
        el.parentElement;
      const meta = scoreCompetitionContainer(card);
      if (!meta.ok || !meta.number || seen.has(meta.number)) continue;
      seen.add(meta.number);
      cards.push(card);
    }
    return cards;
  };

  const findCompetitionCards = () => {
    const headers = findCompetitionHeaders();
    const cards = [];
    const seenNumbers = new Set();
    const seenElements = new Set();
    for (const h of headers) {
      const num = extractHeaderNumber(h);
      if (!num) continue;
      if (seenNumbers.has(num)) continue;
      const card = pickCompetitionContainerForHeader(h);
      if (!card) continue;
      seenNumbers.add(num);
      seenElements.add(card);
      cards.push(card);
    }
    const fallbackContainerCards = findCompetitionCardsFromContainers();
    for (const card of fallbackContainerCards) {
      const meta = scoreCompetitionContainer(card);
      if (!meta.number || seenNumbers.has(meta.number) || seenElements.has(card))
        continue;
      seenNumbers.add(meta.number);
      seenElements.add(card);
      cards.push(card);
    }
    const fallbackTextCards = findCompetitionCardsFromText();
    for (const card of fallbackTextCards) {
      const meta = scoreCompetitionContainer(card);
      if (!meta.number || seenNumbers.has(meta.number) || seenElements.has(card))
        continue;
      seenNumbers.add(meta.number);
      seenElements.add(card);
      cards.push(card);
    }
    return cards
      .sort((a, b) => {
        if (a === b) return 0;
        const pos = a.compareDocumentPosition(b);
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .slice(0, 10);
  };

  const pickCompetitionCard = (pick) => {
    const cards = findCompetitionCards();
    if (!cards.length) return null;
    if (pick === "active") {
      const activeCard =
        cards.find((card) => {
          const text = coerceText(card?.innerText || "");
          return /\b(in progress|active)\b/i.test(text);
        }) || null;
      if (activeCard) return activeCard;
      const startedCard =
        cards.find((card) => {
          const text = coerceText(card?.innerText || "");
          return !/\bnot started\b/i.test(text);
        }) || null;
      if (startedCard) return startedCard;
      return cards[0];
    }
    if (pick === "second") return cards[1] || cards[0];
    if (pick === "last") return cards[cards.length - 1] || cards[0];
    return cards[0];
  };

  const clickIfVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width <= 0 && rect.height <= 0) return false;
    try {
      el.scrollIntoView?.({ block: "center", inline: "nearest" });
    } catch {}
    try {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      return true;
    } catch {}
    try {
      el.click?.();
      return true;
    } catch {}
    return false;
  };

  const bruteForceExpandCompetitionScopes = async (roots) => {
    const toggleMatcher =
      /standings|leaderboard|results|participants|rankings|view|show|expand|details|table/i;
    let clicked = false;
    for (const root of roots || []) {
      if (!root) continue;
      const scopes = [
        root,
        root.parentElement,
        root.parentElement?.parentElement,
        root.nextElementSibling,
        root.parentElement?.nextElementSibling,
      ].filter(Boolean);
      const controls = [];
      for (const scope of scopes) {
        const found = Array.from(
          scope.querySelectorAll(
            "button, a, summary, [role='button'], [aria-expanded]",
          ),
        );
        for (const el of found) {
          if (controls.includes(el)) continue;
          const text = coerceText(el.innerText || el.textContent || "");
          const ariaLabel = coerceText(el.getAttribute?.("aria-label") || "");
          const ariaExpanded = String(el.getAttribute?.("aria-expanded") || "")
            .trim()
            .toLowerCase();
          const className = String(el.className || "");
          const looksClosed =
            ariaExpanded === "false" ||
            /collapsed|closed/i.test(className) ||
            /expand/i.test(text) ||
            /show/i.test(text) ||
            /view/i.test(text);
          const looksRelevant =
            toggleMatcher.test(text) ||
            toggleMatcher.test(ariaLabel) ||
            toggleMatcher.test(className);
          if (!looksClosed && !looksRelevant) continue;
          controls.push(el);
        }
      }
      for (const el of controls.slice(0, 20)) {
        clicked = clickIfVisible(el) || clicked;
      }
    }
    if (clicked) {
      await sleep(600);
    }
    return clicked;
  };

  const competitionHasVisibleResults = (competitionNumber) => {
    const header = findCompetitionHeaderByNumber(competitionNumber);
    const root = header ? pickCompetitionContainerForHeader(header) : null;
    const text = coerceText(root?.innerText || "");
    return (
      Boolean(root?.querySelector("table")) ||
      /\\brank\\b/i.test(text) ||
      /\\bplayer\\b/i.test(text) ||
      /\\bcompleted\\b/i.test(text) ||
      /unique\\s*nft/i.test(text)
    );
  };

  const expandCompetitionHeaderToggle = async (competitionNumber) => {
    const header = findCompetitionHeaderByNumber(competitionNumber);
    if (!header) return false;
    const scopes = [
      header,
      header.parentElement,
      header.parentElement?.parentElement,
      header.closest("article, section, li, div"),
    ].filter(Boolean);
    const controls = [];
    for (const scope of scopes) {
      const found = Array.from(
        scope.querySelectorAll(
          "button, a, summary, [role='button'], [aria-expanded]",
        ),
      );
      for (const el of found) {
        if (controls.includes(el)) continue;
        const text = coerceText(el.innerText || el.textContent || "");
        const ariaLabel = coerceText(el.getAttribute?.("aria-label") || "");
        const ariaExpanded = String(el.getAttribute?.("aria-expanded") || "")
          .trim()
          .toLowerCase();
        const className = String(el.className || "");
        const isPlus = text === "+" || /^\\+\\s*$/.test(text);
        const looksClosed =
          ariaExpanded === "false" || /collapsed|closed/i.test(className);
        const looksRelevant =
          isPlus ||
          /standings|leaderboard|results|participants|rankings|expand|show|view|details/i.test(
            text,
          ) ||
          /standings|leaderboard|results|participants|rankings|expand|show|view|details/i.test(
            ariaLabel,
          );
        if (!looksClosed && !looksRelevant) continue;
        controls.push(el);
      }
    }

    let clicked = false;
    for (const el of controls.slice(0, 12)) {
      clicked = clickIfVisible(el) || clicked;
    }
    if (!clicked && header.parentElement) {
      clicked = clickIfVisible(header.parentElement) || clicked;
    }
    if (!clicked) return false;

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (competitionHasVisibleResults(competitionNumber)) return true;
      await sleep(150);
    }
    return true;
  };

  const findLabelNode = (root, label) => {
    const wanted = String(label || "").trim().toLowerCase();
    if (!wanted) return null;
    const nodes = Array.from(root.querySelectorAll("*"))
      .filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return false;
        const t = coerceText(el.innerText);
        if (!t) return false;
        const lower = t.toLowerCase();
        return lower === wanted || lower.startsWith(wanted + ":");
      })
      // Prefer shorter exact label nodes.
      .sort((a, b) => (coerceText(a.innerText).length || 0) - (coerceText(b.innerText).length || 0));
    return nodes[0] || null;
  };

  const findTextAfterLabel = (root, label) => {
    const node = findLabelNode(root, label);
    if (!node) return null;

    const own = coerceText(node.innerText);
    const labelLower = String(label || "").toLowerCase();
    if (own && own.toLowerCase().startsWith(labelLower + ":")) {
      const rest = own.split(":").slice(1).join(":");
      const cleaned = coerceText(rest);
      if (cleaned) return cleaned;
    }

    const row = node.closest("li, p, div, tr") || node.parentElement;
    if (row) {
      const rowText = coerceText(row.innerText);
      if (rowText) {
        const prefix = new RegExp("^" + String(label || "") + "\\\\s*:?\\\\s*", "i");
        const cleaned = coerceText(rowText.replace(prefix, ""));
        if (cleaned && cleaned.toLowerCase() !== String(label).toLowerCase()) return cleaned;
      }
    }

    const sib = node.nextElementSibling;
    const sibText = coerceText(sib?.innerText);
    return sibText || null;
  };

  const findHeaderNode = (root, label) => {
    const wanted = String(label || "").trim().toLowerCase();
    if (!wanted) return null;
    const nodes = Array.from(root.querySelectorAll("*"))
      .filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return false;
        // Only treat short, exact matches as headers.
        const t = coerceText(el.innerText);
        if (!t) return false;
        const lower = t.toLowerCase();
        if (lower !== wanted) return false;
        return t.length <= 24;
      });
    return nodes[0] || null;
  };

  const findValueNextToHeader = (root, label) => {
    const header = findHeaderNode(root, label);
    if (!header) return null;

    // Common patterns: label/value in adjacent siblings.
    const sib = header.nextElementSibling;
    const sibText = coerceText(sib?.innerText);
    if (sibText && sibText.length <= 120) return sibText;

    // dl/dt/dd pattern
    if (String(header.tagName || "").toLowerCase() === "dt") {
      const dd = header.nextElementSibling;
      const ddText = coerceText(dd?.innerText);
      if (ddText) return ddText;
    }

    // table th/td pattern
    if (String(header.tagName || "").toLowerCase() === "th") {
      const td = header.nextElementSibling;
      const tdText = coerceText(td?.innerText);
      if (tdText) return tdText;
    }

    // Fallback: look within the nearest row container, but only take the part after the label.
    const row = header.closest("li, p, div, tr") || header.parentElement;
    const rowText = coerceText(row?.innerText);
    if (!rowText) return null;
    const prefix = new RegExp("^" + String(label || "") + "\\\\s*:?\\\\s*", "i");
    const cleaned = coerceText(rowText.replace(prefix, ""));
    // Avoid swallowing whole card: cap to a reasonable size.
    if (cleaned && cleaned.length <= 120) return cleaned;
    return null;
  };

  const findListFollowingHeader = (root, label) => {
    const header = findHeaderNode(root, label);
    if (!header) return [];
    const otherLabel =
      String(label || "").toLowerCase() === "missions" ? "Prizes" : "Missions";

    const sectionHasHeader = (el, headerLabel) =>
      Boolean(findHeaderNode(el, headerLabel));

    const findBestSection = () => {
      let cur = header.parentElement;
      let depth = 0;
      while (cur && cur !== root && depth < 12) {
        const hasUl = Boolean(cur.querySelector("ul"));
        if (
          hasUl &&
          sectionHasHeader(cur, label) &&
          !sectionHasHeader(cur, otherLabel)
        ) {
          return cur;
        }
        cur = cur.parentElement;
        depth += 1;
      }
      // Fallback: nearest container.
      return header.closest("section, article, div, li") || root;
    };

    const scope = findBestSection();
    const ul = scope.querySelector("ul");
    if (!ul) return [];
    return Array.from(ul.querySelectorAll("li"))
      .map((li) => coerceText(li.innerText))
      .filter(Boolean)
      .slice(0, 200);
  };

  const findFallbackCompetitionRoot = () => {
    const candidates = [
      document.querySelector("main"),
      document.body,
    ].filter(Boolean);

    const score = (el) => {
      const t = coerceText(el?.innerText || "");
      if (!t) return { ok: false, score: -1, len: 0 };
      const hasStart = /\bstart\b/i.test(t);
      const hasEnd = /\bend\b/i.test(t);
      const hasPrizes = /\bprize(s)?\b/i.test(t);
      const hasMissions = /\bmissions?\b/i.test(t);
      const hasComp = /\bcompetition\b/i.test(t);
      const ok = hasComp && hasStart && hasEnd;
      const len = t.length;
      // Prefer smaller containers that still have the right labels.
      const s =
        (hasComp ? 5 : 0) +
        (hasStart ? 5 : 0) +
        (hasEnd ? 5 : 0) +
        (hasPrizes ? 2 : 0) +
        (hasMissions ? 2 : 0) -
        Math.min(20, Math.floor(len / 500));
      return { ok, score: s, len };
    };

    const ranked = candidates
      .map((el) => ({ el, ...score(el) }))
      .filter((x) => x.ok)
      .sort((a, b) => b.score - a.score || a.len - b.len);

    return ranked[0]?.el || candidates[0] || document.body;
  };

  const hasCompetitionContent = () => {
    const card = pickCompetitionCard(${JSON.stringify(competitionPick)});
    if (card) return true;
    const bodyText = coerceText(document.body?.innerText || "");
    return /competition\\s*#?\\s*\\d+/i.test(bodyText);
  };

  const waitForContent = async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (hasCompetitionContent()) return true;
      await sleep(250);
    }
    return false;
  };

  return (async () => {
    const labelSplit = (sourceText, fromLabel, toLabels) => {
      const src = String(sourceText || "");
      const from = String(fromLabel || "").trim();
      if (!src || !from) return null;
      const fromRe = new RegExp("\\\\b" + from + "\\\\b\\\\s*:?\\\\s*", "i");
      const fromMatch = src.match(fromRe);
      if (!fromMatch || fromMatch.index == null) return null;
      const startIdx = fromMatch.index + fromMatch[0].length;
      const rest = src.slice(startIdx);
      let endIdx = rest.length;
      for (const to of toLabels || []) {
        const toRe = new RegExp("\\\\b" + String(to) + "\\\\b\\\\s*:?\\\\s*", "i");
        const m = rest.match(toRe);
        if (m && m.index != null) endIdx = Math.min(endIdx, m.index);
      }
      const out = coerceText(rest.slice(0, endIdx));
      return out || null;
    };
    const cardHasExpandedContent = (root) => {
      const text = coerceText(root?.innerText || "");
      if (!text) return false;
      return (
        /\\bstart\\b/i.test(text) ||
        /\\bend\\b/i.test(text) ||
        /\\bmissions?\\b/i.test(text) ||
        /\\bprize(s)?\\b/i.test(text) ||
        /\\bresults?\\b/i.test(text)
      );
    };
    const expandCompetitionCard = async (root) => {
      if (!root || cardHasExpandedContent(root)) return false;
      const toggleCandidates = Array.from(
        root.querySelectorAll("button, a, summary, [role='button'], [aria-expanded]"),
      ).filter((el) => {
        if (!el) return false;
        const text = coerceText(el.innerText || el.textContent || "");
        const ariaExpanded = String(el.getAttribute?.("aria-expanded") || "");
        const ariaLabel = String(el.getAttribute?.("aria-label") || "");
        const className = String(el.className || "");
        return (
          ariaExpanded.toLowerCase() === "false" ||
          /expand|open|show|view|details|results?/i.test(text) ||
          /expand|open|show|view|details|results?/i.test(ariaLabel) ||
          /accordion|collapse|expand/i.test(className) ||
          /^competition\\s*#?\\s*\\d{1,6}\\b/i.test(text)
        );
      });

      const clickIfVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        if (rect && rect.width <= 0 && rect.height <= 0) return false;
        try {
          el.scrollIntoView?.({ block: "center", inline: "nearest" });
        } catch {}
        try {
          el.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
          return true;
        } catch {}
        try {
          el.click?.();
          return true;
        } catch {}
        return false;
      };

      let clicked = false;
      for (const el of toggleCandidates.slice(0, 8)) {
        clicked = clickIfVisible(el) || clicked;
      }
      if (!clicked) {
        clicked = clickIfVisible(root);
      }
      if (clicked) {
        await sleep(300);
      }
      return clicked;
    };
    const resolveCompetitionRoot = (root, competitionNumber) => {
      if (!root) return root;
      const candidates = [root];
      const addCandidate = (el) => {
        if (!el) return;
        if (candidates.includes(el)) return;
        candidates.push(el);
      };

      addCandidate(root.nextElementSibling);
      addCandidate(root.previousElementSibling);
      addCandidate(root.parentElement);
      addCandidate(root.parentElement?.nextElementSibling);

      let cur = root.parentElement;
      let depth = 0;
      while (cur && cur !== document.body && depth < 6) {
        addCandidate(cur);
        addCandidate(cur.nextElementSibling);
        const panel = competitionNumber
          ? cur.querySelector(
              "[aria-expanded='true'], [data-state='open'], [class*='open'], [class*='expanded'], [class*='accordion'], [class*='collapse']",
            )
          : null;
        addCandidate(panel);
        cur = cur.parentElement;
        depth += 1;
      }

      const numberRe = competitionNumber
        ? new RegExp(
            "\\\\bcompetition\\\\s*#?\\\\s*" + String(competitionNumber) + "\\\\b",
            "i",
          )
        : /competition\\s*#?\\s*\\d+/i;
      const scored = candidates
        .filter(Boolean)
        .map((el) => {
          const text = coerceText(el?.innerText || "");
          const hasNumber = numberRe.test(text);
          const hasMeta =
            /\\bstart\\b/i.test(text) ||
            /\\bend\\b/i.test(text) ||
            /\\bmissions?\\b/i.test(text) ||
            /\\bprize(s)?\\b/i.test(text) ||
            /\\bresults?\\b/i.test(text) ||
            /\\brank\\b/i.test(text);
          const len = text.length;
          const score =
            (hasNumber ? 10 : 0) +
            (hasMeta ? 10 : 0) -
            Math.min(15, Math.floor(len / 500));
          return { el, text, hasNumber, hasMeta, len, score };
        })
        .filter((item) => item.hasNumber)
        .sort((a, b) => b.score - a.score || a.len - b.len);
      return scored[0]?.el || root;
    };
    const expandStandingsSection = async (root, competitionNumber) => {
      if (!root) return false;
      const scopes = [];
      const pushScope = (el) => {
        if (!el || scopes.includes(el)) return;
        scopes.push(el);
      };
      pushScope(root);
      pushScope(root.parentElement);
      pushScope(root.parentElement?.parentElement);
      pushScope(root.nextElementSibling);
      pushScope(root.parentElement?.nextElementSibling);

      const numberRe = competitionNumber
        ? new RegExp(
            "\\\\bcompetition\\\\s*#?\\\\s*" + String(competitionNumber) + "\\\\b",
            "i",
          )
        : /competition\\s*#?\\s*\\d+/i;
      const toggleMatcher =
        /standings|leaderboard|results|participants|rankings|view\\s+results|view\\s+standings|show\\s+results|show\\s+standings|expand/i;
      const candidates = [];
      for (const scope of scopes) {
        const controls = Array.from(
          scope.querySelectorAll(
            "button, a, summary, [role='button'], [aria-expanded]",
          ),
        );
        for (const el of controls) {
          const text = coerceText(el.innerText || el.textContent || "");
          const ariaLabel = coerceText(el.getAttribute?.("aria-label") || "");
          const className = String(el.className || "");
          const scopeText = coerceText(scope.innerText || "");
          if (
            !toggleMatcher.test(text || ariaLabel || className) &&
            String(el.getAttribute?.("aria-expanded") || "").toLowerCase() !==
              "false"
          ) {
            continue;
          }
          const nearbyMatchesCompetition =
            numberRe.test(scopeText) ||
            numberRe.test(
              coerceText(el.closest("section, article, li, div")?.innerText || ""),
            );
          if (!nearbyMatchesCompetition) continue;
          candidates.push(el);
        }
      }
      let clicked = false;
      for (const el of candidates.slice(0, 12)) {
        clicked = clickIfVisible(el) || clicked;
      }
      if (clicked) await sleep(350);
      return clicked;
    };
    const extractCompetitionFromRoot = async (root, index) => {
      await expandCompetitionCard(root);
      const numberMatch =
        coerceText(root?.innerText || "").match(/Competition\\s*#?\\s*(\\d{1,6})/i) ||
        coerceText(root?.innerText || "").match(/\\bCompetition\\b[^\\n]{0,50}?\\b(\\d{1,6})\\b/i) ||
        coerceText(root?.innerText || "").match(/\\b#\\s*(\\d{1,6})\\b/);
      if (numberMatch?.[1]) {
        await expandCompetitionHeaderToggle(String(numberMatch[1]));
      }
      let resolvedRoot = resolveCompetitionRoot(
        root,
        numberMatch ? String(numberMatch[1]) : null,
      );
      await expandStandingsSection(
        resolvedRoot,
        numberMatch ? String(numberMatch[1]) : null,
      );
      resolvedRoot = resolveCompetitionRoot(
        resolvedRoot,
        numberMatch ? String(numberMatch[1]) : null,
      );
      const pageText = coerceText(document.body?.innerText || "");
      const text = coerceText(resolvedRoot?.innerText || pageText || "");
      const challenge = looksLikeChallenge(text) ? "challenge_page" : null;

      const startText =
        findValueNextToHeader(resolvedRoot, "Start") ||
        labelSplit(text, "Start", ["End", "Missions", "Prizes", "Results", "Finished", "ID"]) ||
        findTextAfterLabel(resolvedRoot, "Start") ||
        findTextAfterLabel(resolvedRoot, "Start date") ||
        null;
      const endText =
        findValueNextToHeader(resolvedRoot, "End") ||
        labelSplit(text, "End", ["Missions", "Prizes", "Results", "Finished", "ID", "Start"]) ||
        findTextAfterLabel(resolvedRoot, "End") ||
        findTextAfterLabel(resolvedRoot, "End date") ||
        null;

      const datesMatch =
        (!startText || !endText)
          ? (text.match(/\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\b[^\\n]{0,120}?\\b\\d{1,2}\\b[^\\n]{0,120}?(?:-|–|to)[^\\n]{0,120}?\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\b[^\\n]{0,120}?\\b\\d{1,2}\\b/i) ||
            text.match(/\\b\\d{4}-\\d{2}-\\d{2}\\b[^\\n]{0,60}?(?:-|–|to)[^\\n]{0,60}?\\b\\d{4}-\\d{2}-\\d{2}\\b/))
          : null;

      const missions = findListFollowingHeader(resolvedRoot, "Missions");
      const prizes = findListFollowingHeader(resolvedRoot, "Prizes").length
        ? findListFollowingHeader(resolvedRoot, "Prizes")
        : findListFollowingHeader(resolvedRoot, "Prize");

      let resultsStatus = null;
      let userRows = [];
      let users = [];

      const noResults =
        /no\\s+results\\s+yet/i.test(text) ||
        /results\\s+not\\s+available/i.test(text) ||
        /no\\s+participants\\s+yet/i.test(text);
      if (noResults) {
        resultsStatus = "No results yet";
      } else {
        const expandResultsToggles = async () => {
          const toggleCandidates = Array.from(resolvedRoot.querySelectorAll("button, a, [role='button']"))
            .filter((el) => {
              const t = coerceText(el.innerText || el.textContent || "");
              if (!t) return false;
              return (
                /^s\\s*\\+$/i.test(t) ||
                /^show\\b/i.test(t) ||
                /\\bshow\\s+more\\b/i.test(t) ||
                /\\bmore\\b/i.test(t)
              );
            })
            .slice(0, 6);
          for (const el of toggleCandidates) {
            try {
              clickIfVisible(el);
            } catch {}
          }
          if (toggleCandidates.length > 0) {
            await sleep(220);
          }
        };

        const parseUsersFromFirstTable = () => {
          const tables = Array.from(resolvedRoot.querySelectorAll("table"));
          const table = tables[0] || null;
          if (!table) return [];
          const headerCells = Array.from(
            table.querySelectorAll("thead th, tr th"),
          ).map((c) => coerceText(c.innerText || c.textContent || "").toLowerCase());
          const rankIndex = headerCells.findIndex((t) => /rank|place|position/.test(t));
          const playerIndex = headerCells.findIndex((t) => /player|user|wallet/.test(t));
          const completedIndex = headerCells.findIndex((t) => /completed|finish|done/.test(t));
          const uniqueIndex = headerCells.findIndex((t) => /unique\\s*nft|unique/.test(t));
          const rows = Array.from(table.querySelectorAll("tr"));
          const out = [];
          for (const row of rows) {
            const cells = Array.from(row.querySelectorAll("td"));
            if (cells.length < 2) continue;
            const values = cells.map((c) => coerceText(c.innerText || c.textContent || ""));
            const rankRaw = values[rankIndex >= 0 ? rankIndex : 0] || "";
            const rankMatch = String(rankRaw).match(/\\d{1,4}/);
            const rank = rankMatch ? Number(rankMatch[0]) : null;
            const player = values[playerIndex >= 0 ? playerIndex : 1] || "";
            const completedRaw = values[completedIndex >= 0 ? completedIndex : 2] || "";
            const uniqueRaw = values[uniqueIndex >= 0 ? uniqueIndex : 3] || "";
            const completedMatch = String(completedRaw).match(/\\d{1,8}/);
            const uniqueMatch = String(uniqueRaw).match(/\\d{1,8}/);
            const completed = completedMatch ? Number(completedMatch[0]) : null;
            const uniqueNFTs = uniqueMatch ? Number(uniqueMatch[0]) : null;
            if (!Number.isFinite(rank)) continue;
            if (!player || /^player$/i.test(player)) continue;
            out.push({
              rank,
              player,
              completed,
              uniqueNFTs,
            });
          }
          return out;
        };

        const findResultsHeaderBlock = () => {
          const candidates = Array.from(resolvedRoot.querySelectorAll("*"))
            .map((el) => ({ el, t: coerceText(el.innerText) }))
            .filter((x) => x.t)
            .filter(
              (x) =>
                /\\brank\\b/i.test(x.t) &&
                /\\bplayer\\b/i.test(x.t),
            )
            .sort((a, b) => a.t.length - b.t.length);
          return candidates[0]?.el || null;
        };

        const parseGridRowText = (rowText) => {
          const t = coerceText(rowText);
          if (!t) return null;
          if (/^rank\\b/i.test(t) && /player/i.test(t)) return null;
          const patterns = [
            /^\\s*(\\d{1,4})\\s*(?:[-–—]|\\s)+\\s*([a-z0-9_\\-.]{2,})\\s+(\\d{1,8})\\s+(\\d{1,8})\\s*$/i,
            /^\\s*(\\d{1,4})\\s+([a-z0-9_\\-. ]{2,40}?)\\s+(\\d{1,8})\\s+(\\d{1,8})\\s*$/i,
            /^\\s*(\\d{1,4})\\D+([a-z0-9_\\-.]{2,})\\D+(\\d{1,8})\\D+(\\d{1,8})\\s*$/i,
          ];
          for (const pattern of patterns) {
            const m = t.match(pattern);
            if (!m) continue;
            const rank = Number(m[1]);
            const player = coerceText(m[2]);
            const completed = Number(m[3]);
            const uniqueNFTs = Number(m[4]);
            if (!player || !/[a-z]/i.test(player)) continue;
            return { rank, player, completed, uniqueNFTs };
          }
          const simpleMatch = t.match(
            /^\\s*(\\d{1,4})(?:\\s+([+\\-]?\\d+|[-–—]))?\\s+([a-z0-9][a-z0-9_\\-. ]{1,50})\\s*$/i,
          );
          if (simpleMatch) {
            const rank = Number(simpleMatch[1]);
            const player = coerceText(simpleMatch[3]);
            if (Number.isFinite(rank) && player && /[a-z]/i.test(player)) {
              return {
                rank,
                player,
                completed: null,
                uniqueNFTs: null,
              };
            }
          }
          return null;
        };

        const normalizeUserRows = (rows) => {
          const seen = new Set();
          return rows
            .filter(
              (row) =>
                Number.isFinite(Number(row?.rank)) &&
                Number(row.rank) > 0 &&
                coerceText(row?.player),
            )
            .map((row) => ({
              rank: Number(row.rank),
              player: coerceText(row.player),
              completed:
                Number.isFinite(Number(row.completed))
                  ? Number(row.completed)
                  : null,
              uniqueNFTs:
                Number.isFinite(Number(row.uniqueNFTs))
                  ? Number(row.uniqueNFTs)
                  : null,
            }))
            .filter((row) => {
              const key = String(row.rank) + ":" + String(row.player);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .sort((a, b) => a.rank - b.rank);
        };

        const scrapeResultsGrid = () => {
          const header = findResultsHeaderBlock();
          if (!header) return [];
          const scope =
            header.closest("section, article, div") ||
            header.parentElement ||
            resolvedRoot;

          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, null);
          walker.currentNode = header;
          const found = [];
          let next = walker.nextNode();
          while (next && found.length < 200) {
            const tag = String(next.tagName || "").toLowerCase();
            if (tag === "script" || tag === "style" || tag === "noscript") {
              next = walker.nextNode();
              continue;
            }
            const txt = coerceText(next.innerText);
            if (txt && txt.length <= 120) {
              const parsed = parseGridRowText(txt);
              if (parsed) found.push(parsed);
            }
            next = walker.nextNode();
          }
          return found;
        };

        const scrapeResultsTextBlock = () => {
          const fullText = coerceText(resolvedRoot?.innerText || "");
          if (!fullText) return [];
          const resultsBlock =
            labelSplit(fullText, "Results", [
              "Prizes",
              "Missions",
              "Start",
              "End",
              "Competition",
            ]) || fullText;
          const lines = String(resultsBlock)
            .split(/\\n+/)
            .map((line) => coerceText(line))
            .filter(Boolean);
          const parsed = [];
          for (const line of lines) {
            if (/^rank\\b/i.test(line) && /player/i.test(line)) continue;
            const row = parseGridRowText(line);
            if (row) parsed.push(row);
          }

          if (parsed.length) return parsed;

          const rowLikeNodes = Array.from(
            resolvedRoot.querySelectorAll("li, tr, div, p, span"),
          )
            .map((el) => coerceText(el.innerText || el.textContent || ""))
            .filter((value) => value && value.length <= 140);
          for (const value of rowLikeNodes) {
            const row = parseGridRowText(value);
            if (row) parsed.push(row);
          }
          return parsed;
        };

        const runResultsScrape = async () => {
          await expandResultsToggles();
          const tableUsers = parseUsersFromFirstTable();
          if (tableUsers.length) return normalizeUserRows(tableUsers).slice(0, 150);
          const grid = scrapeResultsGrid();
          if (grid.length) return normalizeUserRows(grid).slice(0, 150);
          const textRows = scrapeResultsTextBlock();
          if (textRows.length) return normalizeUserRows(textRows).slice(0, 150);
          return [];
        };
        userRows = await runResultsScrape();
        users = userRows.map((row) =>
          "#" + row.rank + " • " + row.player +
          (Number.isFinite(row.completed) ? " • Completed " + row.completed : "") +
          (Number.isFinite(row.uniqueNFTs) ? " • Unique NFTs " + row.uniqueNFTs : ""),
        );
      }

      return {
        competitionNumber: numberMatch ? String(numberMatch[1]) : null,
        start: startText || null,
        end: endText || null,
        datesText: datesMatch ? coerceText(datesMatch[0]) : null,
        missions,
        prizes,
        resultsStatus,
        userRows,
        users,
        sourceUrl: location.href,
        scrapedAt: new Date().toISOString(),
        debug: {
          readyState: document.readyState,
          challenge,
          cardIndex: index,
          expandedCard: cardHasExpandedContent(root),
          resolvedRootChanged: resolvedRoot !== root,
          resolvedRootSample: coerceText(resolvedRoot?.innerText || "").slice(
            0,
            240,
          ),
          sampleText: text.slice(0, 400),
          samplePageText: pageText.slice(0, 400),
        },
      };
    };

    await waitForContent();
    let cards = findCompetitionCards();
    const initialPickedCard = pickCompetitionCard(${JSON.stringify(competitionPick)});
    const rootsToExpand = [];
    if (initialPickedCard) rootsToExpand.push(initialPickedCard);
    for (const card of cards.slice(0, 5)) {
      if (!card || rootsToExpand.includes(card)) continue;
      rootsToExpand.push(card);
    }
    await bruteForceExpandCompetitionScopes(rootsToExpand);
    cards = findCompetitionCards();
    const pickedCard = pickCompetitionCard(${JSON.stringify(competitionPick)});
    const fallbackRoot = findFallbackCompetitionRoot();
    const orderedRoots = [];
    if (pickedCard) orderedRoots.push(pickedCard);
    for (const card of cards.slice(0, 5)) {
      if (!card || orderedRoots.includes(card)) continue;
      orderedRoots.push(card);
    }
    if (!orderedRoots.length && fallbackRoot) orderedRoots.push(fallbackRoot);
    const competitions = [];
    for (let i = 0; i < orderedRoots.length; i += 1) {
      competitions.push(await extractCompetitionFromRoot(orderedRoots[i], i));
    }
    const primary =
      competitions[0] ||
      (await extractCompetitionFromRoot(pickedCard || fallbackRoot, 0));
    const discoveredNumbers = cards
      .map((el) => {
        const m = coerceText(el.innerText).match(/Competition\\s*#?\\s*(\\d{1,6})/i);
        return m ? String(m[1]) : null;
      })
      .filter(Boolean);

    return {
      ...primary,
      competitions,
      debug: {
        ...(primary?.debug || {}),
        cardCount: cards.length,
        discoveredNumbers,
        competitionPick: ${JSON.stringify(competitionPick)},
      },
    };
  })();
})()`,
        true,
      );

      return {
        competitionNumber: coerceText(result?.competitionNumber),
        start: coerceText(result?.start),
        end: coerceText(result?.end),
        datesText: coerceText(result?.datesText),
        missions: Array.isArray(result?.missions)
          ? result.missions.map(coerceText).filter(Boolean)
          : [],
        prizes: Array.isArray(result?.prizes)
          ? result.prizes.map(coerceText).filter(Boolean)
          : [],
        resultsStatus: coerceText(result?.resultsStatus),
        userRows: Array.isArray(result?.userRows)
          ? result.userRows
              .map((row) => ({
                rank: Number(row?.rank),
                player: coerceText(row?.player),
                completed:
                  Number.isFinite(Number(row?.completed))
                    ? Number(row.completed)
                    : null,
                uniqueNFTs:
                  Number.isFinite(Number(row?.uniqueNFTs))
                    ? Number(row.uniqueNFTs)
                    : null,
              }))
              .filter(
                (row) => Number.isFinite(row.rank) && row.rank > 0 && row.player,
              )
          : [],
        users: Array.isArray(result?.users)
          ? result.users.map(coerceText).filter(Boolean)
          : [],
        competitions: Array.isArray(result?.competitions)
          ? result.competitions
              .map((competition) => ({
                competitionNumber: coerceText(competition?.competitionNumber),
                start: coerceText(competition?.start),
                end: coerceText(competition?.end),
                datesText: coerceText(competition?.datesText),
                missions: Array.isArray(competition?.missions)
                  ? competition.missions.map(coerceText).filter(Boolean)
                  : [],
                prizes: Array.isArray(competition?.prizes)
                  ? competition.prizes.map(coerceText).filter(Boolean)
                  : [],
                resultsStatus: coerceText(competition?.resultsStatus),
                userRows: Array.isArray(competition?.userRows)
                  ? competition.userRows
                      .map((row) => ({
                        rank: Number(row?.rank),
                        player: coerceText(row?.player),
                        completed:
                          Number.isFinite(Number(row?.completed))
                            ? Number(row.completed)
                            : null,
                        uniqueNFTs:
                          Number.isFinite(Number(row?.uniqueNFTs))
                            ? Number(row.uniqueNFTs)
                            : null,
                      }))
                      .filter(
                        (row) =>
                          Number.isFinite(row.rank) &&
                          row.rank > 0 &&
                          row.player,
                      )
                  : [],
                users: Array.isArray(competition?.users)
                  ? competition.users.map(coerceText).filter(Boolean)
                  : [],
                sourceUrl: coerceText(competition?.sourceUrl) || COMPETITIONS_URL,
                scrapedAt: coerceText(competition?.scrapedAt),
                debug: competition?.debug || null,
              }))
              .filter(
                (competition) =>
                  competition.competitionNumber ||
                  competition.start ||
                  competition.end ||
                  competition.missions.length ||
                  competition.prizes.length ||
                  competition.userRows.length,
              )
          : [],
        sourceUrl: coerceText(result?.sourceUrl) || COMPETITIONS_URL,
        scrapedAt: coerceText(result?.scrapedAt),
        debug: result?.debug || null,
      };
    },
  );
}

module.exports = {
  scrapeLatestCompetition,
  COMPETITIONS_URL,
};
