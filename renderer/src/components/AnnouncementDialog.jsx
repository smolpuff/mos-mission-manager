import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import backImg from "../img/back.png";
import { announcementLinkUrl, announcementTextParts } from "../announcement-links.mjs";

export default function AnnouncementDialog({ announcement, onClose, openExternal, wallet = "" }) {
  const panel = useRef(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const dismissForever = useRef(false);
  const dismiss = useCallback(() => onClose(dismissForever.current), [onClose]);
  useEffect(() => {
    dismissForever.current = false;
    setDontShowAgain(false);
  }, [announcement?.id]);
  useEffect(() => setImageFailed(false), [announcement?.imageUrl]);
  useEffect(() => {
    if (!announcement) return;
    const previous = document.activeElement;
    panel.current?.querySelector('[data-announcement-close]')?.focus({ preventScroll: true });
    const keydown = event => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); }
      if (event.key !== "Tab") return;
      const buttons = [...(panel.current?.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled)') || [])];
      const first = buttons[0], last = buttons.at(-1);
      if ((!event.shiftKey && document.activeElement === last) || !panel.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [announcement?.id, dismiss]);
  if (!announcement) return null;
  const linkUrl = announcementLinkUrl(announcement.linkUrl, wallet);
  const richText = text => announcementTextParts(text, wallet).map((part, index) => part.href
    ? <a key={index} href={part.href} className="announcement-link text-secondary underline underline-offset-2 hover:text-accent" onClick={event => { event.preventDefault(); void openExternal?.(part.href); }}>{part.text}</a>
    : part.text);
  const content = (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      role="dialog" aria-modal="true" aria-label={announcement.title || "Announcement"}>
      <div ref={panel} className="p-4 w-full rounded-xl shadow-2xl shadow-black/95 space-y-4 z-10 border-2 border-[#1D1C27] overflow-y-auto"
        style={{ maxWidth: "640px", maxHeight: "calc(100dvh - 32px)", backgroundImage: `url(${backImg})`, backgroundSize: "cover", backgroundPosition: "center" }}>
        {announcement.imageUrl && !imageFailed ? <img src={announcement.imageUrl} alt={announcement.imageAlt || ""} referrerPolicy="no-referrer" onError={() => setImageFailed(true)} className="mx-auto block h-auto max-w-full rounded-lg" style={{ width: `${announcement.imageWidth ?? 100}%` }} /> : null}
        {announcement.title ? <h2 className="text-lg font-semibold">{announcement.title}</h2> : null}
        {announcement.text ? <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">{richText(announcement.text)}</p> : null}
        {announcement.prizes?.length ? <dl className="rounded-md border border-white/10 bg-black/20 p-3 space-y-2 text-sm">
          {announcement.prizes.map((row, index) => <div key={index} className="flex gap-4"><dt className="font-semibold text-secondary shrink-0">{row.place}</dt><dd className="text-slate-100 whitespace-pre-wrap break-words">{row.prize}</dd></div>)}
        </dl> : null}
        {announcement.info ? <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-slate-200 whitespace-pre-wrap break-words">{richText(announcement.info)}</div> : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {announcement.canSuppress !== false ? <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={dontShowAgain} onChange={event => {
              dismissForever.current = event.target.checked;
              setDontShowAgain(event.target.checked);
            }} />
            Don’t show this announcement again
          </label> : null}
          <div className="flex items-center gap-3">
          {linkUrl ? <a href={linkUrl} className="announcement-link text-sm font-semibold text-secondary underline underline-offset-2 hover:text-accent" onClick={event => { event.preventDefault(); void openExternal?.(linkUrl); }}>{announcement.linkLabel || "View details"}</a> : null}
          <button type="button" data-announcement-close className="btn btn-gradient btn-sm text-shadow-sm text-shadow-black/40" onClick={dismiss}>Dismiss</button>
          </div>
        </div>
      </div>
    </div>
  );
  return createPortal(content, document.body);
}
