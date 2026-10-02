import { useEffect, useId, useRef } from 'react';
import type { AgentState, AvatarCharacter, AvatarColor } from '../api';

// Body outlines on a 100×100 grid, with where each character's eyes sit.
const SHAPES: Record<AvatarCharacter, { d: string; eyes: [number, number][]; cheeks: [number, number][] }> = {
  cloud: {
    d: 'M27 80C13.5 80 5 70.5 6.5 59.5 8 49.5 16.5 43.5 25.5 44.5 27 30 39 20.5 53 22.5 64.5 24 72 32 73.5 41.5 85.5 41 95 50.5 94 62 93 72.5 84.5 80 74 80Z',
    eyes: [[41, 57], [61, 57]],
    cheeks: [[33, 66], [69, 66]],
  },
  dot: {
    d: 'M50 12C71 12 88 29 88 50 88 71 71 88 50 88 29 88 12 71 12 50 12 29 29 12 50 12Z',
    eyes: [[39, 48], [61, 48]],
    cheeks: [[30, 59], [70, 59]],
  },
  drop: {
    d: 'M50 10C59 25 82 42 82 63 82 80 68 91 50 91 32 91 18 80 18 63 18 42 41 25 50 10Z',
    eyes: [[40, 60], [60, 60]],
    cheeks: [[31, 70], [69, 70]],
  },
};

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

/**
 * Sky's face. It floats and blinks when idle, reads side to side while working,
 * hops when it needs you, and dozes when paused.
 */
export function Avatar({ state = 'idle', character = 'cloud', color = 'sky', size = 40, track = false, className = '', label = 'Sky' }: Props) {
  const id = useId().replace(/:/g, '');
  const ref = useRef<SVGSVGElement>(null);
  const shape = SHAPES[character];

  useEffect(() => {
    if (!track || state === 'paused' || state === 'offline') return;
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
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

  return (
    <svg
      ref={ref}
      className={`av ${className}`}
      data-state={state}
      data-av={color}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`${label}, ${state === 'waiting' ? 'needs you' : state}`}
    >
      <defs>
        <radialGradient id={`b${id}`} cx="34%" cy="28%" r="80%">
          <stop offset="0" style={{ stopColor: 'var(--av-1)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--av-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--av-3)' }} />
        </radialGradient>
      </defs>
      <ellipse className="av-shadow" cx="50" cy="95" rx="26" ry="3" />
      <g className="av-body">
        <g className="av-squish">
          <path d={shape.d} fill={`url(#b${id})`} />
          <ellipse cx="34" cy={shape.eyes[0][1] - 20} rx="9" ry="5" fill="#ffffff" opacity="0.55" transform={`rotate(-20 34 ${shape.eyes[0][1] - 20})`} />
          {shape.cheeks.map(([x, y]) => (
            <ellipse key={x} className="av-cheek" cx={x} cy={y} rx="5" ry="3" />
          ))}
          <g className="av-eyes">
            {shape.eyes.map(([x, y]) => (
              <g key={x} className="av-eye">
                <ellipse cx={x} cy={y} rx="4.2" ry="6" fill="#161616" />
                <circle cx={x + 1.4} cy={y - 2.2} r="1.4" fill="#ffffff" />
              </g>
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}
