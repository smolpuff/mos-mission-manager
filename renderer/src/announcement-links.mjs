export function announcementLinkUrl(value, wallet = "") {
  if (!value) return null;
  const template = value.replace(/%7Bwallet%7D/gi, "{wallet}");
  if (template.includes("{wallet}") && !wallet) return null;
  try {
    const url = new URL(template.replaceAll("{wallet}", encodeURIComponent(wallet)));
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Plain HTTPS URLs and [label](https://...) links; never interpret HTML.
export function announcementTextParts(value, wallet = "") {
  const text = String(value || ""), parts = [];
  const pattern = /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>\[\]]+)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
    const raw = match[2] || match[3];
    const trailing = match[3] ? raw.match(/[.,!?;:)]+$/)?.[0] || "" : "";
    const url = raw.slice(0, raw.length - trailing.length);
    parts.push({ text: match[1] || url, href: announcementLinkUrl(url, wallet) });
    if (trailing) parts.push({ text: trailing });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
