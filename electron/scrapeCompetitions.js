"use strict";

const { withHeadlessWindow } = require("./headless");

const COMPETITIONS_URL =
  "https://pixelbypixel.studio/missions/competitions";

function coerceText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || null;
}

async function scrapeLatestCompetition(opts = {}) {
  const competitionPick = ["first", "second", "last"].includes(opts?.competitionPick)
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

  const findCompetitionHeaders = () => {
    const nodes = Array.from(document.querySelectorAll("main *"));
    const headers = nodes
      .filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return false;
        const t = coerceText(el.innerText);
        if (!t) return false;
        // Header should basically be "Competition 17" / "Competition #17"
        if (!/^competition\\s*#?\\s*\\d{1,6}\\b/i.test(t)) return false;
        // Avoid grabbing giant containers that *contain* the header.
        return t.length <= 32;
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

  const findCompetitionCards = () => {
    const headers = findCompetitionHeaders();
    const cards = [];
    const seen = new Set();
    for (const h of headers) {
      const num = extractHeaderNumber(h);
      if (!num) continue;
      if (seen.has(num)) continue;
      const card = pickCompetitionContainerForHeader(h);
      if (!card) continue;
      seen.add(num);
      cards.push(card);
    }
    return cards;
  };

  const pickCompetitionCard = (pick) => {
    const cards = findCompetitionCards();
    if (!cards.length) return null;
    if (pick === "second") return cards[1] || cards[0];
    if (pick === "last") return cards[cards.length - 1] || cards[0];
    return cards[0];
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

  const findFirstCompetitionRoot = () => {
    const picked = pickCompetitionCard(${JSON.stringify(competitionPick)});
    if (picked) return picked;
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
    await waitForContent();
	    const root = findFirstCompetitionRoot();
	    const pageText = coerceText(document.body?.innerText || "");
	    const text = coerceText(root?.innerText || pageText || "");
	    const challenge = looksLikeChallenge(text) ? "challenge_page" : null;
      const cards = findCompetitionCards();
      const discoveredNumbers = cards
        .map((el) => {
          const m = coerceText(el.innerText).match(/Competition\\s*#?\\s*(\\d{1,6})/i);
          return m ? String(m[1]) : null;
        })
        .filter(Boolean);

    const numberMatch =
      text.match(/Competition\\s*#?\\s*(\\d{1,6})/i) ||
      text.match(/\\bCompetition\\b[^\\n]{0,50}?\\b(\\d{1,6})\\b/i) ||
      text.match(/\\b#\\s*(\\d{1,6})\\b/);

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

    // Prefer splitting the card's own text by label boundaries to avoid "row contains everything" issues.
    const startText =
      findValueNextToHeader(root, "Start") ||
      labelSplit(text, "Start", ["End", "Missions", "Prizes", "Results", "Finished", "ID"]) ||
      findTextAfterLabel(root, "Start") ||
      findTextAfterLabel(root, "Start date") ||
      null;
    const endText =
      findValueNextToHeader(root, "End") ||
      labelSplit(text, "End", ["Missions", "Prizes", "Results", "Finished", "ID", "Start"]) ||
      findTextAfterLabel(root, "End") ||
      findTextAfterLabel(root, "End date") ||
      null;

    const datesMatch =
      (!startText || !endText)
        ? (text.match(/\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\b[^\\n]{0,120}?\\b\\d{1,2}\\b[^\\n]{0,120}?(?:-|–|to)[^\\n]{0,120}?\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\b[^\\n]{0,120}?\\b\\d{1,2}\\b/i) ||
          text.match(/\\b\\d{4}-\\d{2}-\\d{2}\\b[^\\n]{0,60}?(?:-|–|to)[^\\n]{0,60}?\\b\\d{4}-\\d{2}-\\d{2}\\b/))
        : null;

    const missions = findListFollowingHeader(root, "Missions");
    const prizes = findListFollowingHeader(root, "Prizes").length
      ? findListFollowingHeader(root, "Prizes")
      : findListFollowingHeader(root, "Prize");

    let resultsStatus = null;
    let users = [];

	    const noResults =
	      /no\\s+results\\s+yet/i.test(text) ||
	      /results\\s+not\\s+available/i.test(text) ||
	      /no\\s+participants\\s+yet/i.test(text);
	    if (noResults) {
	      resultsStatus = "No results yet";
	    } else {
	      const findResultsHeaderBlock = () => {
	        const candidates = Array.from(root.querySelectorAll("*"))
	          .map((el) => ({ el, t: coerceText(el.innerText) }))
	          .filter((x) => x.t)
	          .filter(
	            (x) =>
	              /\\brank\\b/i.test(x.t) &&
	              /\\bplayer\\b/i.test(x.t) &&
	              /\\bcompleted\\b/i.test(x.t) &&
	              /unique\\s*nft/i.test(x.t),
	          )
	          // prefer smallest header block
	          .sort((a, b) => a.t.length - b.t.length);
	        return candidates[0]?.el || null;
	      };

	      const parseGridRowText = (rowText) => {
	        const t = coerceText(rowText);
	        if (!t) return null;
	        // Typical: "3 — rmrfkorea 302 225"
	        const m = t.match(/^\\s*(\\d{1,4})\\s*(?:[-–—]|\\s)+\\s*([a-z0-9_\\-.]{2,})\\s+(\\d{1,8})\\s+(\\d{1,8})\\s*$/i);
	        if (!m) return null;
	        const rank = m[1];
	        const player = m[2];
	        const completed = m[3];
	        const unique = m[4];
	        if (!/[a-z]/i.test(player)) return null;
	        return "#" + rank + " • " + player + " • Completed " + completed + " • Unique NFTs " + unique;
	      };

	      const scrapeResultsGrid = () => {
	        const header = findResultsHeaderBlock();
	        if (!header) return [];
	        const scope =
	          header.closest("section, article, div") || header.parentElement || root;

	        // Walk forward after the header and collect candidate row-like elements.
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
	          // Skip empty/huge blocks
	          if (txt && txt.length <= 120) {
	            const parsed = parseGridRowText(txt);
	            if (parsed) found.push(parsed);
	          }
	          next = walker.nextNode();
	        }
	        return found;
	      };

	      const grid = scrapeResultsGrid();
	      if (grid.length) {
	        users = grid.slice(0, 150);
	      }
	    }

    return {
      competitionNumber: numberMatch ? String(numberMatch[1]) : null,
      start: startText || null,
      end: endText || null,
      datesText: datesMatch ? coerceText(datesMatch[0]) : null,
      missions,
      prizes,
      resultsStatus,
      users,
      sourceUrl: location.href,
      scrapedAt: new Date().toISOString(),
	      debug: {
	        readyState: document.readyState,
	        cardCount: cards.length,
          discoveredNumbers,
	        competitionPick: ${JSON.stringify(competitionPick)},
	        challenge,
	        sampleText: text.slice(0, 400),
	        samplePageText: pageText.slice(0, 400),
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
        users: Array.isArray(result?.users)
          ? result.users.map(coerceText).filter(Boolean)
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
