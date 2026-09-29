import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Agent, ChatMessage } from "../shared/types";
import { MindCard, useMind } from "./MindCard";

// Each collaborator carries a card of what it brings. Clicking its row in the rail pours the card out
// of its avatar; clicking again draws it back in, the way a macOS window genies into the Dock. The card
// is cut into thin strips and each strip is bent onto the funnel between the avatar and the card, so the
// content itself stretches through the neck instead of a shape being faked around it.

const STRIPS = 28;
const OPEN_MS = 560;
const CLOSE_MS = 480;

type Geometry = { left: number; top: number; width: number; height: number; sourceX: number; sourceY: number; neck: number };
type Strip = { element: HTMLDivElement; x0: number; x1: number };

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const easeInOut = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// The projective map from a strip's own rectangle onto a four-cornered shape (Heckbert's square-to-quad),
// written as a CSS matrix3d. Neighbouring strips share corners, so the funnel's edges stay continuous.
function warp(width: number, height: number, [[x0, y0], [x1, y1], [x2, y2], [x3, y3]]: number[][]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, sumX = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sumY = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = det ? (sumX * dy2 - dx2 * sumY) / det : 0;
  const h = det ? (dx1 * sumY - sumX * dy1) / det : 0;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return `matrix3d(${a / width},${d / width},0,${g / width},${b / height},${e / height},0,${h / height},0,0,1,0,${x0},${y0},0,1)`;
}

// One moment of the genie: at 0 the card is inside the avatar, at 1 it is open. Opening, the content
// slides out through the funnel far edge first, then the funnel relaxes into the card's own shape.
// Closing runs the same path backwards: the card bends toward the avatar, then pours into it.
function draw(strips: Strip[], geo: Geometry, progress: number) {
  const { left, top, width, height, sourceX, sourceY, neck } = geo;
  const slide = easeInOut(clamp(progress / 0.62));
  const bend = 1 - easeInOut(clamp((progress - 0.38) / 0.62));
  const shift = (1 - slide) * (left + width - sourceX);
  const reach = Math.max(1, left + width * 0.35 - sourceX);
  const edges = (x: number) => {
    const open = smoother(clamp((x - sourceX) / reach));
    return [lerp(top, lerp(sourceY - neck, top, open), bend) - top, lerp(top + height, lerp(sourceY + neck, top + height, open), bend) - top];
  };
  for (const strip of strips) {
    const right = left + strip.x1 - shift;
    const start = Math.max(left + strip.x0 - shift, sourceX);
    if (right - start < 0.4) { strip.element.style.opacity = "0"; continue; }
    const [top0, bottom0] = edges(start); const [top1, bottom1] = edges(right);
    const x0 = start - left - strip.x0, x1 = right - left - strip.x0;
    strip.element.style.transform = warp(strip.x1 - strip.x0, height, [[x0, top0], [x1, top1], [x1, bottom1], [x0, bottom0]]);
    // The content surfaces from within the avatar rather than at its rim.
    strip.element.style.opacity = String(clamp((right - sourceX) / 18));
  }
}

// Each strip holds a copy of the whole card, shifted so only its own column shows.
function cut(overlay: HTMLDivElement, surface: HTMLElement, width: number, height: number): Strip[] {
  overlay.replaceChildren();
  return Array.from({ length: STRIPS }, (_, index) => {
    const x0 = (width * index) / STRIPS, x1 = (width * (index + 1)) / STRIPS;
    const element = document.createElement("div");
    element.className = "genie-strip";
    Object.assign(element.style, { left: `${x0}px`, width: `${x1 - x0 + 1}px`, height: `${height}px` });
    const copy = surface.cloneNode(true) as HTMLElement;
    copy.style.left = `${-x0}px`;
    element.append(copy);
    overlay.append(element);
    return { element, x0, x1 };
  });
}

type ChipProps = {
  roomId: string; agent: Agent; subtitle: string; messages: ChatMessage[]; live: boolean; closing: boolean; railKey: string;
  onGone: () => void; onClose: () => void; onChooseContext: (agent: Agent) => void; onRemove: (agent: Agent) => void;
};

function GenieChip({ roomId, agent, subtitle, messages, live, closing, railKey, onGone, onClose, onChooseContext, onRemove }: ChipProps) {
  const { mind, ready } = useMind(roomId, agent, live);
  const surface = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [shown, setShown] = useState(false);
  const progress = useRef(0);
  const motion = useRef<{ frame: number; timer?: number; strips: Strip[] } | null>(null);
  const gone = useRef(onGone); gone.current = onGone;

  // The card sits beside the rail with its heading level with the avatar, kept on screen.
  const measure = (): Geometry | null => {
    const card = surface.current; if (!card) return null;
    const avatar = document.querySelector(`.participant[data-agent-id="${CSS.escape(agent.id)}"] .avatar`)?.getBoundingClientRect();
    const rail = document.querySelector(".participants")?.getBoundingClientRect();
    const width = card.offsetWidth, height = card.offsetHeight;
    const sourceX = avatar ? avatar.left + avatar.width / 2 : rail?.right ?? 0;
    const sourceY = avatar ? avatar.top + avatar.height / 2 : 120;
    const left = Math.min(Math.max((rail?.right ?? 0) + 16, 8), Math.max(8, innerWidth - width - 8));
    const top = Math.min(Math.max(sourceY - 30, 72), Math.max(72, innerHeight - height - 12));
    return { left, top, width, height, sourceX, sourceY, neck: avatar ? avatar.height * 0.42 : 12 };
  };

  const settle = () => { if (overlay.current) { overlay.current.style.display = "none"; overlay.current.replaceChildren(); } motion.current = null; };

  const stop = () => { cancelAnimationFrame(motion.current?.frame ?? 0); clearTimeout(motion.current?.timer); };

  const animate = (to: 0 | 1, done: () => void) => {
    const geo = measure();
    stop();
    if (geo) setPlace({ left: geo.left, top: geo.top });
    // With reduced motion the card simply appears and disappears. A hidden page gets no animation
    // frames at all, so there it goes straight to where it was heading.
    if (!geo || !surface.current || !overlay.current || reducedMotion() || document.hidden) { progress.current = to; settle(); motion.current = { frame: 0, timer: window.setTimeout(done), strips: [] }; return; }
    // A reversal mid-flight keeps the strips already in the air.
    const strips = motion.current?.strips.length ? motion.current.strips : cut(overlay.current, surface.current, geo.width, geo.height);
    Object.assign(overlay.current.style, { display: "block", left: `${geo.left}px`, top: `${geo.top}px`, width: `${geo.width}px`, height: `${geo.height}px` });
    const from = progress.current;
    draw(strips, geo, from);
    const duration = (to ? OPEN_MS : CLOSE_MS) * Math.abs(to - from);
    // One clock throughout: frame timestamps can run on a different time base.
    const started = performance.now();
    const tick = () => {
      const amount = duration ? clamp((performance.now() - started) / duration) : 1;
      progress.current = lerp(from, to, amount);
      draw(strips, geo, progress.current);
      if (amount < 1) motion.current = { frame: requestAnimationFrame(tick), strips };
      else done();
    };
    motion.current = { frame: requestAnimationFrame(tick), strips };
  };

  useLayoutEffect(() => {
    if (closing) { setShown(false); animate(0, () => { settle(); gone.current(); }); return; }
    if (!ready) return;
    // Show the real card in the same frame the strips leave, so the hand-off never flickers.
    animate(1, () => { flushSync(() => setShown(true)); settle(); });
  }, [closing, ready]);

  useEffect(() => () => stop(), []);

  // Follow the rail when the window changes size or the rail folds.
  useEffect(() => {
    if (!shown) return;
    const follow = () => { const geo = measure(); if (geo) setPlace({ left: geo.left, top: geo.top }); };
    follow();
    addEventListener("resize", follow);
    return () => removeEventListener("resize", follow);
  }, [shown, railKey]);

  return <>
    <div className="mind-chip" role="dialog" aria-label={`What ${agent.name} brings`} aria-hidden={!shown} style={{ left: place?.left ?? -9999, top: place?.top ?? 0, visibility: shown ? "visible" : "hidden" }}>
      <div ref={surface} className="mind-chip-surface">
        <header className="mind-chip-head">
          <div><strong>What {agent.name} brings</strong><small>{subtitle}</small></div>
          <button type="button" className="mind-chip-close" onClick={onClose} aria-label={`Put away what ${agent.name} brings`}>×</button>
        </header>
        <MindCard agent={agent} mind={mind} messages={messages} />
        <footer className="mind-chip-actions">
          <button type="button" onClick={() => onChooseContext(agent)}>Choose context</button>
          <button type="button" className="danger" onClick={() => onRemove(agent)}>Remove from room</button>
        </footer>
      </div>
    </div>
    <div ref={overlay} className="genie" aria-hidden="true" />
  </>;
}

// Opening one collaborator's card puts away the one that was out; both animate at once.
export function MindChips({ openId, agents, subtitleOf, ...rest }: Omit<ChipProps, "agent" | "subtitle" | "closing" | "onGone"> & { openId: string | null; agents: Agent[]; subtitleOf: (agent: Agent) => string }) {
  const [chips, setChips] = useState<Array<{ id: string; closing: boolean }>>([]);
  useEffect(() => {
    setChips((current) => {
      const next = current.map((chip) => chip.closing === (chip.id !== openId) ? chip : { ...chip, closing: chip.id !== openId });
      return openId && !next.some((chip) => chip.id === openId) ? [...next, { id: openId, closing: false }] : next;
    });
  }, [openId]);
  useEffect(() => { setChips((current) => current.every((chip) => agents.some((agent) => agent.id === chip.id)) ? current : current.filter((chip) => agents.some((agent) => agent.id === chip.id))); }, [agents]);
  return <>{chips.map((chip) => {
    const agent = agents.find((candidate) => candidate.id === chip.id);
    return agent ? <GenieChip key={chip.id} {...rest} agent={agent} subtitle={subtitleOf(agent)} closing={chip.closing} onGone={() => setChips((current) => current.filter((item) => item.id !== chip.id || !item.closing))} /> : null;
  })}</>;
}
