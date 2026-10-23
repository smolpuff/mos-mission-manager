import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./InterfaceTour.css";
import backImg from "../img/back.png";

const modeButton = index => document.querySelectorAll('.mission-modes button')[index];
const toggleRow = id => document.getElementById(id)?.parentElement?.parentElement;
const steps = [
  { label: 'The modes', title: 'Start with Auto Mode.', target: () => modeButton(0), mode: 0,
    text: 'Auto Mode tries level 20, then resets the mission if no suitable NFTs are available.', detail: 'Rentals and mission resets are managed by this mode, so their switches stay locked on.' },
  { label: 'The modes', title: 'Manual gives you control.', target: () => modeButton(1), mode: 1,
    text: 'Choose whether to use rentals and mission resets yourself. When resets are enabled, set your own reset level.', detail: 'Manual refers to these settings. Start still runs the mission watcher.' },
  { label: 'The modes', title: 'Mission Mode rotates your NFTs.', target: () => modeButton(2), mode: 2,
    text: 'Resets missions at your chosen level and rotates through eligible NFTs before repeating.', detail: 'Rentals and mission resets stay on. NFT cooldown resets become available here.' },
  { label: 'Mission Mode', title: 'Save NFTs around your target rank.', target: () => document.querySelector('.finish-target-reveal-content'), mode: 2,
    text: 'Mission Mode only. Choose your finish range and leave the runner on. The app checks your competition rank periodically, pausing mission automation when you reach the range or better to help avoid unnecessary NFT use. If you drop below it, automation resumes on the next check.', detail: 'It keeps checking while paused, every 2½ minutes by default. For 11–13, it pauses at 13th or better and resumes at 14th or worse.' },
  { label: 'The toggles', title: 'Rentals are your fallback.', target: () => toggleRow('enableRentals'), mode: 1,
    text: 'In Manual Mode, this switch decides whether rentals can be used after your other NFTs.', detail: 'In Auto and Mission Mode it stays locked on. The helper text under the switch explains why.' },
  { label: 'The toggles', title: 'Choose when missions reset.', target: () => {
      const input = document.querySelector('[aria-label="Manual mission reset level"]');
      const row = toggleRow('enableResets');
      return [row, input?.parentElement?.parentElement].filter(Boolean);
    }, mode: 1,
    text: 'Enable mission resets to reset at your selected level. Turn them off if you don’t want automatic mission resets.', detail: 'When enabled in Manual Mode, the level field controls when to reset. Auto Mode manages this level for you.' },
  { label: 'The toggles', title: 'NFT cooldown resets are separate.', target: () => document.getElementById('enableNFTReset')?.closest('.mt-1.w-full'), mode: 2,
    text: 'This resets an NFT’s cooldown rather than the mission level. It is available in Mission Mode.', detail: 'Max PBP Cost limits the cost of a cooldown reset. Review that value before using the option.' },
  { label: 'Mission cards', title: 'Optional resets for each card.', target: () => document.querySelector('.missions__parent .card-mission'), mode: 2,
    text: 'The On / Off switch on the artwork includes this slot in automation. The smaller reset switch on the artwork lets this slot use its own reset level.', detail: 'Optional: enable the smaller reset switch and enter a level for this slot. With it off, the slot uses your mode’s reset settings. Other cards keep their own settings.' },
  { label: 'Start & status', title: 'Start when you’re ready.', target: () => document.querySelector('.status-row')?.closest('section'),
    text: 'Once you’ve chosen a mode and reviewed its controls, Start begins watching missions. The same button stops it.', detail: 'The counters show active missions, available NFTs, claimable rewards, and claims during this session.' },
];
function targetRect(target) {
  const elements = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (!elements.length) return null;
  const rects = elements.map(e => e.getBoundingClientRect());
  if (rects.some(rect => rect.width <= 0 || rect.height <= 0)) return null;
  const left = Math.min(...rects.map(r => r.left)) - 9;
  const top = Math.min(...rects.map(r => r.top)) - 9;
  const right = Math.max(...rects.map(r => r.right)) + 9;
  const bottom = Math.max(...rects.map(r => r.bottom)) + 9;
  return { left, top, width: right - left, height: bottom - top, right, bottom };
}
export default function InterfaceTour({ onClose, onModePreview, topInset = 0 }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);
  const [position, setPosition] = useState({ left: 24, top: 24 });
  const card = useRef(null);
  const current = steps[index];

  // Preview mode-dependent controls locally. Never invoke a mode's save or
  // runner command handlers simply to explain the interface.
  useEffect(() => {
    onModePreview?.(current.mode === undefined ? null : ['auto', 'normal', 'mission'][current.mode]);
  }, [current, onModePreview]);
  useEffect(() => () => onModePreview?.(null), [onModePreview]);

  useLayoutEffect(() => {
    let frame;
    function measure() {
      const targets = [current.target()].flat().filter(Boolean);
      const target = targets[0];
      const scroller = target?.closest('.main-wrapper');
      if (scroller) {
        const bounds = target.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        if (bounds.bottom > viewport.bottom - 12) scroller.scrollTop += bounds.bottom - viewport.bottom + 12;
        else if (bounds.top < viewport.top + 12) scroller.scrollTop -= viewport.top - bounds.top + 12;
      }
      const next = targetRect(targets);
      setRect(old => old && next && Object.keys(next).every(key => Math.abs(old[key] - next[key]) < .5) ? old : next);
      frame = requestAnimationFrame(measure);
    }
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [current]);

  useLayoutEffect(() => {
    if (!rect || !card.current) return;
    const w = card.current.offsetWidth, h = card.current.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, gap = 24;
    const minTop = topInset + 16;
    let left, top;
    if (vw - rect.right > w + gap + 16) { left = rect.right + gap; top = rect.top; }
    else if (rect.left > w + gap + 16) { left = rect.left - w - gap; top = rect.top; }
    else { left = (vw - w) / 2; top = rect.bottom + gap; }
    if (top + h > vh - 16 && rect.top - h - gap >= minTop) top = rect.top - h - gap;
    top = Math.max(minTop, Math.min(vh - h - 16, top));
    left = Math.max(16, Math.min(vw - w - 16, left));
    setPosition(old => old.left === left && old.top === top ? old : { left, top });
  }, [rect, index, topInset]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    card.current?.querySelector('[data-next]')?.focus({ preventScroll: true });
    function keydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const buttons = [...(card.current?.querySelectorAll('button:not(:disabled)') || [])];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!card.current?.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      }
    }
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(<>
    <div className="onboarding-overlay" aria-hidden="true">
      <div className="onboarding-shade onboarding-shade-top" style={{ top: topInset, height: rect ? Math.max(0, rect.top - topInset) : `calc(100dvh - ${topInset}px)` }} />
      {rect && <>
        <div className="onboarding-shade onboarding-shade-left" style={{ top: rect.top, width: Math.max(0, rect.left), height: rect.height }} />
        <div className="onboarding-shade onboarding-shade-right" style={{ top: rect.top, left: rect.right, height: rect.height }} />
        <div className="onboarding-shade onboarding-shade-bottom" style={{ top: rect.bottom }} />
        <div className="onboarding-spotlight" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      </>}
    </div>
    <section ref={card} className="onboarding-tour onboarding-tour-spotlight" style={{ ...position, backgroundImage: `url(${backImg})`, backgroundSize: "cover", backgroundPosition: "center" }} role="dialog" aria-modal="true" aria-labelledby="interface-tour-title">
      <div className="onboarding-tour-heading"><span>{String(index + 1).padStart(2, '0')} / {String(steps.length).padStart(2, '0')} <b>·</b> {current.label}</span><button className="onboarding-dismiss" onClick={onClose} aria-label="Close tour">×</button></div>
      <div className="onboarding-copy" key={index} aria-live="polite" aria-atomic="true">
        <h2 id="interface-tour-title">{current.title}</h2><p>{current.text}</p><div className="onboarding-detail">{current.detail}</div>
      </div>
      <div className="onboarding-tour-actions"><button className="onboarding-skip" onClick={onClose}>Skip tour</button><div><button className="onboarding-back" onClick={() => setIndex(index - 1)} disabled={index === 0}>Back</button><button className="onboarding-next" data-next onClick={() => index === steps.length - 1 ? onClose() : setIndex(index + 1)}>{index === steps.length - 1 ? 'Finish tour' : 'Next'} <span aria-hidden="true">→</span></button></div></div>
      <div className="onboarding-tour-progress" role="progressbar" aria-label="Tour progress" aria-valuenow={index + 1} aria-valuemin="0" aria-valuemax={steps.length}><span style={{ width: `${(index + 1) / steps.length * 100}%` }} /></div>
    </section>
  </>, document.body);
}
