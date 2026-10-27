import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import AnnouncementDialog from "../../renderer/src/components/AnnouncementDialog";
import "./style.css";
import { visibleContent } from "./visible-content.mjs";

const empty = () => ({ id: "", enabled: false, visibility: { title: false, text: false, image: false, prizes: false, info: false, link: false }, title: "", text: "", info: "", imageUrl: "", imageWidth: undefined, imageAlt: "", prizes: [], linkUrl: "", linkLabel: "", startsAt: "", endsAt: "" });
function localTime(iso) { if (!iso) return ""; const date = new Date(iso); if (!Number.isFinite(+date)) return ""; return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function App() {
  const [session, setSession] = useState(null), [items, setItems] = useState([]), [selected, setSelected] = useState(-1);
  const [tab, setTab] = useState("message");
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [preview, setPreview] = useState(false);
  const item = items[selected];
  useEffect(() => { fetch("/api/session").then(r => r.json()).then(value => { setSession(value); setItems(value.draft.announcements); }).catch(e => setError(e.message)); }, []);
  const change = patch => setItems(old => old.map((value, i) => i === selected ? { ...value, ...patch } : value));
  async function request(route, body = { announcements: items }) {
    const response = await fetch("/api/" + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Announcement-Token": session.token }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  async function action(run) { setBusy(true); setError(""); setMessage(""); try { await run(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const input = (label, key, options = {}) => <label className="editor-field">{label}<input {...options} value={item[key] || ""} onChange={event => change({ [key]: event.target.value, ...(key === "imageUrl" ? { imageFile: "" } : {}) })} /></label>;
  const area = (label, key) => <label className="editor-field">{label}<textarea rows="3" value={item[key] || ""} onChange={event => change({ [key]: event.target.value })} /></label>;
  const include = (key, label) => <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none"><input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={item.visibility?.[key] !== false} onChange={event => change({ visibility: { ...item.visibility, [key]: event.target.checked } })} />Include {label} in announcement</label>;
  const displayed = item ? visibleContent(item) : null;
  const imageUrl = item?.imageFile ? "/api/images/" + item.imageFile : item?.imageUrl;
  return <main className="editor-shell">
    <header className="editor-header"><div><h1>Announcements</h1><p>Write locally. Preview the popup. Publish when ready.</p></div><span className="editor-badge">Local editor</span></header>
    {error || message ? <div className={`editor-status ${error ? "editor-error" : ""}`} aria-live="polite">{error ? <p role="alert" className="whitespace-pre-wrap">{error}</p> : message}</div> : null}
    <div className="editor-layout">
      <aside className="editor-sidebar" aria-label="Announcements">
        <button className="editor-new" disabled={busy || !session || items.length >= 20} onClick={() => { setItems(old => [...old, empty()]); setSelected(items.length); setPreview(false); setTab("message"); }}>+ New announcement</button>
        <div className="editor-list">{items.map((value, index) => <button key={index} className={index === selected ? "editor-selected" : ""} onClick={() => { setSelected(index); setPreview(false); }}><strong>{value.title || value.id || "Untitled"}</strong><span>{value.publishedId ? "Published" : "Local draft"}</span></button>)}{!items.length ? <p>Your drafts will appear here.</p> : null}</div>
        <details className="editor-import"><summary>Load from GitHub</summary><p>Bring published messages into the list so you can edit or remove them. Local-only drafts are kept.</p><button className="btn btn-clear btn-sm" disabled={busy || !session} onClick={() => action(async () => { const { draft } = await request("load-published"); setItems(old => [...old.filter(item => !draft.announcements.some(live => live.id === (item.publishedId || item.id))), ...draft.announcements]); setSelected(-1); setMessage("Published messages loaded. Changes stay local until you publish again."); })}>Load published messages</button></details>
      </aside>
      {item ? <section className="editor-card">
        <nav className="editor-tabs" aria-label="Editor sections">{[["message","Message"],["extras","Prizes & rules"],["delivery","Schedule & publish"]].map(([key,label]) => <button key={key} aria-current={tab === key ? "page" : undefined} className={tab === key ? "editor-tab-active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>
        <fieldset className="editor-form" key={selected} disabled={busy}>
          {tab === "message" ? <>
            {include("title", "title")}
            {input("Title (optional)", "title", { maxLength: 160 })}
            {include("image", "image")}
            <div className="editor-image-row">
              <div className="editor-image-thumb">{imageUrl ? <img src={imageUrl} alt="Selected announcement image" /> : <span>No image</span>}</div>
              <div className="editor-image-controls"><label className="editor-field">Image (optional)<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { const file = event.target.files[0]; event.target.value = ""; if (!file) return; void action(async () => {
                const response = await fetch("/api/image", { method: "POST", headers: { "X-Announcement-Token": session.token }, body: file }); const result = await response.json(); if (!response.ok) throw new Error(result.error); change({ imageFile: result.imageFile, imageUrl: "" }); setMessage("Image saved locally. It uploads only when you publish.");
              }); }} /></label><p className="editor-hint">PNG, JPEG, WebP or GIF · up to 5 MB. Image-only announcements work too.</p>{item.imageFile || item.imageUrl ? <button className="btn btn-clear btn-sm" onClick={() => change({ imageFile: "", imageUrl: "" })}>Remove image</button> : null}</div>
            </div>
            <details className="editor-image-options"><summary>Image URL, width & description</summary><div className="editor-options-grid">{input("Or use an HTTPS image URL", "imageUrl", { type: "url" })}<label className="editor-field">Width (%)<input type="number" min="1" max="100" step="1" value={item.imageWidth ?? ""} onChange={event => change({ imageWidth: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>{input("Image description", "imageAlt", { maxLength: 200 })}</div><p className="editor-hint">100% fills the popup width. Images keep their proportions without cropping.</p></details>
            {include("text", "message")}
            {area("Message (optional)", "text")}
            <p className="editor-hint">{"Links: [View stats](https://example.com/stats/{wallet}) or a plain HTTPS URL. {wallet} becomes the reader’s game wallet in URLs."}</p>
            <p className="editor-hint">Leave anything blank to hide that section in the popup.</p>
          </> : null}
          {tab === "extras" ? <>
            {include("prizes", "prizes")}
            <div className="editor-prizes"><div className="editor-section-heading"><h2>Prizes</h2><button className="btn btn-clear btn-sm" disabled={(item.prizes || []).length >= 20} onClick={() => change({ prizes: [...(item.prizes || []), { place: "", prize: "" }] })}>+ Add prize</button></div>{(item.prizes || []).map((row,index) => <div className="editor-prize" key={index}><input aria-label={`Placement ${index + 1}`} value={row.place} onChange={event => change({ prizes: item.prizes.map((r,i) => i === index ? { ...r, place: event.target.value } : r) })} /><input aria-label={`Prize ${index + 1}`} value={row.prize} onChange={event => change({ prizes: item.prizes.map((r,i) => i === index ? { ...r, prize: event.target.value } : r) })} /><button className="btn btn-clear btn-sm" aria-label={`Remove prize ${index + 1}`} onClick={() => change({ prizes: item.prizes.filter((_,i) => i !== index) })}>Remove</button></div>)}{!item.prizes?.length ? <p className="editor-hint">Optional. Add one row for 1st place, or more for other placements.</p> : null}</div>
            {include("info", "rules / extra info")}
            {area("Rules / extra info (optional)", "info")}
            <p className="editor-hint">{"Use [link text](https://example.com) or plain HTTPS URLs. URLs can include {wallet} for the reader’s game wallet."}</p>
            {include("link", "details link")}
            <div className="editor-two">{input("Details link (optional)", "linkUrl", { type: "url" })}{input("Link label", "linkLabel", { maxLength: 100 })}</div>
          </> : null}
          {tab === "delivery" ? <>
            <div className="editor-section-heading"><h2>When should it appear?</h2><span className="editor-hint">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
            <div className="editor-two">{[["Starts", "startsAt"],["Ends", "endsAt"]].map(([label,key]) => <label className="editor-field" key={key}>{label}<input type="datetime-local" value={localTime(item[key])} onChange={event => change({ [key]: event.target.value ? new Date(event.target.value).toISOString() : "" })} /></label>)}</div>
            <p className="editor-hint">Both times are required. Apps show it only during this window, after setup. Expired messages stay hidden.</p>
            {input("Announcement ID", "id", { maxLength: 100 })}
            <p className="editor-hint">Keep this ID for corrections. Change it only for a new announcement that people should see again.</p>
            <div className="editor-publish-box"><p><strong>Publish</strong> posts this announcement using the dates above. <strong>Remove</strong> takes this announcement off the app feed. Other announcements stay as they are.</p><div className="editor-publish-actions"><button className="btn btn-gradient" disabled={busy || !session} onClick={() => action(async () => {
              await request("save");
              const result = await request("publish", { announcement: visibleContent(item), publishedId: item.publishedId || null });
              const next = items.map((value,index) => index === selected ? { ...value, publishedId: result.id } : value);
              setItems(next); await request("save", { announcements: next });
              setMessage("Published this announcement. Apps pick it up on their next check; the start and end times still apply.");
            })}>{busy ? "Working…" : "Publish"}</button><button className="btn btn-clear" disabled={busy || !session} onClick={() => action(async () => {
              if (item.publishedId) await request("remove", { announcement: item, publishedId: item.publishedId });
              const next = items.filter((_,index) => index !== selected);
              await request("save", { announcements: next }); setItems(next); setSelected(-1);
              setMessage(item.publishedId ? "Removed this announcement. Apps stop showing it on their next check." : "Removed this local draft. Nothing changed on GitHub.");
            })}>Remove</button></div><p className="editor-hint">Publish changes only this message. Removing a local draft does not contact GitHub.</p></div>
            <details className="editor-destination"><summary>Publishing destination</summary><p>{session?.destination}</p></details>
          </> : null}
        </fieldset>
        <footer className="editor-footer"><div><button className="btn btn-clear btn-sm" disabled={busy || !session} onClick={() => action(async () => { await request("save"); setMessage("Draft saved on this computer. Nothing sent to GitHub."); })}>Save local draft</button><span>Stays on this computer.</span></div><button className="btn btn-gradient btn-sm" disabled={busy} onClick={() => setPreview(true)}>Preview popup</button></footer>
        {preview ? <AnnouncementDialog announcement={{ ...displayed, imageUrl: displayed.imageFile ? imageUrl : displayed.imageUrl, prizes: (displayed.prizes || []).filter(r => r.place || r.prize) }} onClose={() => setPreview(false)} openExternal={url => window.open(url, "_blank", "noopener,noreferrer")} /> : null}
      </section> : <section className="editor-empty"><h2>Start with a message</h2><p>Choose <strong>+ New announcement</strong> to create a draft, or load published messages from the sidebar. Publish or remove one announcement at a time from <strong>Schedule & publish</strong>.</p></section>}
    </div>
  </main>;
}
createRoot(document.getElementById("root")).render(<App />);
