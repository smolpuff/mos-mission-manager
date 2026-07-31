"use strict";

function canonicalNftCollectionName(value) {
  const label = String(value || "").trim();
  if (!label) return "";
  const key = label.toLowerCase().replace(/\s+/g, "");
  if (/^s[o0]{2}k$/.test(key) || /^(500k|500000)$/.test(key)) return "500K";
  if (/^[il1][o0]{2}k$/.test(key) || /^(100k|100000)$/.test(key)) return "100K";
  return label;
}

module.exports = { canonicalNftCollectionName };
