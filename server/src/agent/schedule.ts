import { addLocalDays, inWindow, zonedParts, zonedToUtc } from './time.ts';

/**
 * Turns the free-text schedules people type ("Weekdays at 9:00", "every 3
 * hours", "Mondays and Thursdays at 7pm", "Every hour, 7:00 to 22:00") into
 * a structured rule, and computes the next run in the user's time zone.
 */
export type Schedule =
  | { type: 'interval'; minutes: number; window?: { start: number; end: number } }
  | { type: 'times'; days: number[]; times: number[] };

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, wednesday: 3, wednesdays: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5, sat: 6, saturday: 6, saturdays: 6,
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, fifteen: 15, thirty: 30 };

/** Parses "9", "9am", "9:30", "21:15", "7 pm", "noon". Returns minutes after midnight. */
function parseTime(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (t === 'noon' || t === 'midday') return 12 * 60;
  if (t === 'midnight') return 0;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.[0];
  if (ampm === 'p' && h < 12) h += 12;
  if (ampm === 'a' && h === 12) h = 0;
  return h < 24 && min < 60 ? h * 60 + min : null;
}

const TIME_RE = /(noon|midday|midnight|\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)/;

export function parseSchedule(text: string): Schedule | null {
  const s = text.toLowerCase().replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // Optional active window: "7:00 to 22:00", "between 9 and 5pm", "from 8am-6pm".
  let window: { start: number; end: number } | undefined;
  const w = new RegExp(`(?:between|from)?\\s*${TIME_RE.source}\\s*(?:to|-|–|and|until)\\s*${TIME_RE.source}`).exec(s);

  // Intervals: "every 3 hours", "hourly", "every 30 min", "every other day".
  const iv = /every\s+(\d+|a|an|one|two|three|four|five|six|twelve|fifteen|thirty)?\s*(minute|min|hour|hr|day)s?\b/.exec(s);
  const hourly = /\bhourly\b/.test(s);
  if (iv || hourly) {
    const n = iv ? (iv[1] ? (Number(iv[1]) || WORDS[iv[1]] || 1) : 1) : 1;
    const unit = iv ? iv[2] : 'hour';
    const minutes = unit.startsWith('min') ? n : unit.startsWith('h') ? n * 60 : n * 1440;
    if (w) {
      const a = parseTime(w[1]);
      const b = parseTime(w[2]);
      if (a !== null && b !== null) window = { start: a, end: b };
    }
    if (minutes >= 1440 && !iv?.[1]) {
      // "every day" is a daily schedule, handled below with its time.
    } else {
      return { type: 'interval', minutes: Math.max(5, minutes), ...(window ? { window } : {}) };
    }
  }

  // Days.
  let days: number[] | null = null;
  if (/\bweekdays?\b|\bwork ?days?\b|monday to friday|mon-fri/.test(s)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(s)) days = [0, 6];
  else {
    const named = [...s.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?s?\b/g)]
      .map((m) => DAY_NAMES[m[0]] ?? DAY_NAMES[m[1]])
      .filter((d) => d !== undefined);
    if (named.length) days = [...new Set(named)].sort();
  }
  const daily = /\b(daily|every ?day|each day|every morning|every evening|every night|nightly|each morning)\b/.test(s);
  const weekly = /\bweekly\b|every week/.test(s);

  // Times.
  const times: number[] = [];
  for (const m of s.matchAll(new RegExp(`\\b(?:at|@)\\s*${TIME_RE.source}(?:\\s*and\\s*${TIME_RE.source})?`, 'g'))) {
    for (const g of [m[1], m[2]]) {
      const t = g ? parseTime(g) : null;
      if (t !== null) times.push(t);
    }
  }
  if (!times.length) {
    if (/morning/.test(s)) times.push(8 * 60);
    else if (/noon|lunch/.test(s)) times.push(12 * 60);
    else if (/afternoon/.test(s)) times.push(15 * 60);
    else if (/evening/.test(s)) times.push(18 * 60);
    else if (/night/.test(s)) times.push(21 * 60);
    else {
      const bare = new RegExp(`^${TIME_RE.source}$`).exec(s);
      const t = bare ? parseTime(bare[1]) : null;
      if (t !== null) times.push(t);
    }
  }

  if (!days && !daily && !weekly && !times.length) return null;
  return {
    type: 'times',
    days: days ?? (weekly ? [1] : ALL_DAYS),
    times: times.length ? [...new Set(times)].sort((a, b) => a - b) : [9 * 60],
  };
}

/** The next run strictly after `after`. For intervals, `lastRun` anchors the cadence. */
export function nextRun(schedule: Schedule, tz: string, after: Date = new Date(), lastRun?: Date): Date {
  if (schedule.type === 'interval') {
    let t = new Date(Math.max(after.getTime() + 1, (lastRun?.getTime() ?? after.getTime()) + schedule.minutes * 60_000));
    if (lastRun && t.getTime() <= after.getTime()) t = new Date(after.getTime() + 60_000);
    if (!schedule.window) return t;
    // Outside the window, jump to the window's next start.
    const p = zonedParts(t, tz);
    const now = p.hour * 60 + p.minute;
    const { start, end } = schedule.window;
    if (inWindow(now, start, end)) return t;
    const day = now < start ? p : addLocalDays(p, 1);
    return zonedToUtc(day.year, day.month, day.day, Math.floor(start / 60), start % 60, tz);
  }
  const today = zonedParts(after, tz);
  for (let offset = 0; offset <= 8; offset++) {
    const d = addLocalDays(today, offset);
    if (!schedule.days.includes(d.weekday)) continue;
    for (const minute of schedule.times) {
      const at = zonedToUtc(d.year, d.month, d.day, Math.floor(minute / 60), minute % 60, tz);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return new Date(after.getTime() + 86_400_000);
}

const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Plain-English rendering, used in task steps so people can see how Skys read their schedule. */
export function describeSchedule(s: Schedule): string {
  if (s.type === 'interval') {
    const every = s.minutes % 1440 === 0 ? `${s.minutes / 1440} day` : s.minutes % 60 === 0 ? `${s.minutes / 60} hour` : `${s.minutes} minute`;
    const plural = /^1 /.test(every) ? every.replace(/^1 /, '') : `${every}s`;
    return `every ${plural}${s.window ? `, ${fmt(s.window.start)} to ${fmt(s.window.end)}` : ''}`;
  }
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = s.days.length === 7 ? 'every day' : s.days.join() === '1,2,3,4,5' ? 'weekdays' : s.days.join() === '0,6' ? 'weekends' : s.days.map((d) => names[d]).join(', ');
  return `${days} at ${s.times.map(fmt).join(' and ')}`;
}
