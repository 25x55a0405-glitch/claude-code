import { useEffect, useId, useRef } from 'react';
import type { AgentState, AvatarCharacter, AvatarColor } from '../api';

type Pt = [number, number];

/** A polygon with softly rounded corners, as an SVG path. `r` is how far each corner is cut back. */
function soft(pts: Pt[], r: number | number[]) {
  const n = pts.length;
  let d = '';
  pts.forEach((p, i) => {
    const prev = pts[(i + n - 1) % n];
    const next = pts[(i + 1) % n];
    const k = Array.isArray(r) ? r[i % r.length] : r;
    const toward = (q: Pt) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const t = Math.min(k, len / 2) / len;
      return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t].map((v) => +v.toFixed(2));
    };
    const a = toward(prev);
    const b = toward(next);
    d += `${i === 0 ? 'M' : 'L'}${a[0]} ${a[1]}Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${b[0]} ${b[1]}`;
  });
  return d + 'Z';
}

/** Points of a star: `n` tips, alternating between an outer and an inner radius. */
function starPts(n: number, outer: number, inner: number, cx = 50, cy = 52, tilt = 0): Pt[] {
  return Array.from({ length: n * 2 }, (_, i) => {
    const a = ((-90 + tilt + (i * 180) / n) * Math.PI) / 180;
    const rad = i % 2 ? inner : outer;
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad] as Pt;
  });
}

interface Shape {
  d: string;
  eyes: [number, number][];
  cheeks: [number, number][];
  mouth: [number, number];
  /** Where the soft light sits, as a point on the 100 grid. */
  glint: [number, number];
}

// Body outlines on a 100×100 grid, with where each character's face sits.
const SHAPES: Record<AvatarCharacter, Shape> = {
  star: {
    d: soft(starPts(5, 46, 25.5, 50, 53), [9, 6]),
    eyes: [[41, 55], [59, 55]],
    cheeks: [[34, 63], [66, 63]],
    mouth: [50, 63],
    glint: [38, 36],
  },
  sparkle: {
    d: soft(starPts(4, 48, 20, 50, 50), [11, 4]),
    eyes: [[42, 50], [58, 50]],
    cheeks: [[36, 58], [64, 58]],
    mouth: [50, 58],
    glint: [45, 41],
  },
  nova: {
    d: soft(starPts(8, 46, 33, 50, 50, -22.5), [5, 5]),
    eyes: [[40, 49], [60, 49]],
    cheeks: [[31, 59], [69, 59]],
    mouth: [50, 59],
    glint: [36, 30],
  },
  comet: {
    d: 'M13 15Q11 11 17 12.5L67 29.4A30 30 0 1 1 29.4 67L13.5 18Z',
    eyes: [[52, 58], [69, 58]],
    cheeks: [[46, 67], [74, 67]],
    mouth: [60.5, 67],
    glint: [52, 40],
  },
  cloud: {
    d: 'M27 80C13.5 80 5 70.5 6.5 59.5 8 49.5 16.5 43.5 25.5 44.5 27 30 39 20.5 53 22.5 64.5 24 72 32 73.5 41.5 85.5 41 95 50.5 94 62 93 72.5 84.5 80 74 80Z',
    eyes: [[41, 57], [61, 57]],
    cheeks: [[33, 66], [69, 66]],
    mouth: [51, 66],
    glint: [34, 36],
  },
  dot: {
    d: 'M50 12C71 12 88 29 88 50 88 71 71 88 50 88 29 88 12 71 12 50 12 29 29 12 50 12Z',
    eyes: [[39, 48], [61, 48]],
    cheeks: [[30, 59], [70, 59]],
    mouth: [50, 58],
    glint: [35, 28],
  },
  drop: {
    d: 'M50 10C59 25 82 42 82 63 82 80 68 91 50 91 32 91 18 80 18 63 18 42 41 25 50 10Z',
    eyes: [[40, 60], [60, 60]],
    cheeks: [[31, 70], [69, 70]],
    mouth: [50, 70],
    glint: [38, 48],
  },
};

/** Every character, stars first: Stars are what Sky is about. */
export const CHARACTERS: { value: AvatarCharacter; label: string }[] = [
  { value: 'star', label: 'Star' },
  { value: 'sparkle', label: 'Sparkle' },
  { value: 'nova', label: 'Nova' },
  { value: 'comet', label: 'Comet' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'dot', label: 'Dot' },
  { value: 'drop', label: 'Drop' },
];

const STARRY: AvatarCharacter[] = ['star', 'sparkle', 'nova', 'comet'];

interface Props {
  state?: AgentState;
  character?: AvatarCharacter;
  color?: AvatarColor;
  size?: number;
  /** Eyes follow the pointer. Use on the large, featured avatar only. */
  track?: boolean;
  className?: string;
  /** Who this is, for screen readers. */
  label?: string;
}

/** A stable 0 to 1 from an id, so a row of characters don't all breathe in step. */
const spread = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
};

/**
 * Sky's face. It floats, sways and blinks when idle, glances about, reads side
 * to side while working, hops when it needs you, and dozes when paused. Big
 * enough, it has a soft grain, a rim of light and a little smile.
 */
export function Avatar({ state = 'idle', character = 'cloud', color = 'sky', size = 40, track = false, className = '', label = 'Sky' }: Props) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<SVGSVGElement>(null);
  const shape = SHAPES[character] ?? SHAPES.cloud;
  const rich = size >= 34;
  const starry = STARRY.includes(character);
  const r = spread(id);

  useEffect(() => {
    if (!track || state === 'paused' || state === 'offline') return;
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        const len = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, len / 240) * 3.2;
        el.style.setProperty('--look-x', `${(dx / len) * reach}px`);
        el.style.setProperty('--look-y', `${(dy / len) * reach * 0.8}px`);
      });
    };
    const onLeave = () => {
      el.style.setProperty('--look-x', '0px');
      el.style.setProperty('--look-y', '0px');
    };
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
    };
  }, [track, state]);

  // Tap the big one and it squashes, hops and squints, like being poked.
  const poke = () => {
    const el = ref.current;
    if (!track || !el || state === 'paused' || state === 'offline') return;
    el.removeAttribute('data-poke');
    void el.getBoundingClientRect();
    el.setAttribute('data-poke', '');
    window.setTimeout(() => el.removeAttribute('data-poke'), 760);
  };

  const [mx, my] = shape.mouth;
  const [gx, gy] = shape.glint;

  return (
    <svg
      ref={ref}
      className={`av ${className}`}
      data-state={state}
      data-av={color}
      data-shape={character}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      onPointerDown={track ? poke : undefined}
      aria-label={`${label}, ${state === 'waiting' ? 'needs you' : state}`}
      style={{ ['--av-delay' as string]: `${(-r * 5).toFixed(2)}s`, ['--av-pace' as string]: (0.9 + r * 0.25).toFixed(2) }}
    >
      <defs>
        <radialGradient id={`b${id}`} cx="34%" cy="26%" r="86%">
          <stop offset="0" style={{ stopColor: 'var(--av-1)' }} />
          <stop offset="0.5" style={{ stopColor: 'var(--av-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--av-3)' }} />
        </radialGradient>
        {/* Light from the top left, and a little warmth bouncing back up from below. */}
        <radialGradient id={`s${id}`} cx="50%" cy="115%" r="70%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.34" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`r${id}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.22" />
        </linearGradient>
        <clipPath id={`c${id}`}><path d={shape.d} /></clipPath>
        <filter id={`n${id}`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.round(r * 40)} result="t" />
          <feColorMatrix in="t" type="matrix" values="0.46 0.46 0.46 0 -0.2  0.46 0.46 0.46 0 -0.2  0.46 0.46 0.46 0 -0.2  0 0 0 0 1" result="g" />
          <feBlend in="g" in2="SourceGraphic" mode="soft-light" result="m" />
          <feComposite in="m" in2="SourceAlpha" operator="in" />
        </filter>
        <filter id={`f${id}`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.2" /></filter>
      </defs>
      <ellipse className="av-shadow" cx="50" cy="96" rx="26" ry="3" />
      {rich && starry && size >= 56 && (
        <g className="av-twinkles" aria-hidden>
          <path className="av-tw t1" d="M10 28q0 6 6 6-6 0-6 6 0-6-6-6 6 0 6-6z" />
          <path className="av-tw t2" d="M88 20q0 4.5 4.5 4.5-4.5 0-4.5 4.5 0-4.5-4.5-4.5 4.5 0 4.5-4.5z" />
          <path className="av-tw t3" d="M90 74q0 3.5 3.5 3.5-3.5 0-3.5 3.5 0-3.5-3.5-3.5 3.5 0 3.5-3.5z" />
        </g>
      )}
      <g className="av-body">
        <g className="av-squish">
          <g filter={rich ? `url(#n${id})` : undefined}>
            <path d={shape.d} fill={`url(#b${id})`} />
          </g>
          <path d={shape.d} fill={`url(#s${id})`} />
          {rich && <path className="av-rim" d={shape.d} fill="none" stroke={`url(#r${id})`} strokeWidth="1.6" strokeLinejoin="round" />}
          <g clipPath={`url(#c${id})`}>
            <ellipse className="av-glint-soft" cx={gx} cy={gy} rx="15" ry="9" fill="#ffffff" opacity="0.5" filter={`url(#f${id})`} transform={`rotate(-28 ${gx} ${gy})`} />
            <ellipse cx={gx - 3} cy={gy - 3} rx="4.2" ry="2.1" fill="#ffffff" opacity="0.7" transform={`rotate(-28 ${gx - 3} ${gy - 3})`} />
          </g>
          {shape.cheeks.map(([x, y]) => (
            <ellipse key={x} className="av-cheek" cx={x} cy={y} rx="5" ry="3" />
          ))}
          <g className="av-eyes">
            <g className="av-glance">
              {shape.eyes.map(([x, y]) => (
                <g key={x} className="av-eye">
                  <ellipse cx={x} cy={y} rx="4.2" ry="6" fill="#171a21" />
                  <ellipse cx={x} cy={y + 2.6} rx="3" ry="2.2" fill="#3b4660" opacity="0.55" />
                  <circle cx={x + 1.5} cy={y - 2.4} r="1.6" fill="#ffffff" />
                  <circle cx={x - 1.3} cy={y + 2.4} r="0.7" fill="#ffffff" opacity="0.7" />
                </g>
              ))}
              <path className="av-mouth" d={`M${mx - 3.6} ${my}Q${mx} ${my + 3.6} ${mx + 3.6} ${my}`} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
