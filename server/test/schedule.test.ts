import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSchedule, nextRun, parseSchedule } from '../src/agent/schedule.ts';
import { zonedToUtc } from '../src/agent/time.ts';

test('reads common schedules', () => {
  const cases: [string, string][] = [
    ['Weekdays at 9:00', 'weekdays at 9:00'],
    ['every 3 hours', 'every 3 hours'],
    ['Every hour, 7:00 to 22:00', 'every hour, 7:00 to 22:00'],
    ['Mondays and Thursdays at 7pm', 'Mon, Thu at 19:00'],
    ['daily at 8am', 'every day at 8:00'],
    ['every morning', 'every day at 8:00'],
    ['hourly', 'every hour'],
    ['every 30 minutes', 'every 30 minutes'],
    ['weekends at 10', 'weekends at 10:00'],
    ['Every Sunday evening', 'Sun at 18:00'],
  ];
  for (const [input, expected] of cases) assert.equal(describeSchedule(parseSchedule(input)!), expected, input);
  assert.equal(parseSchedule('whenever you like'), null);
});

test('computes the next run in the person’s time zone', () => {
  const s = parseSchedule('Weekdays at 9:00')!;
  // Friday 2026-10-02 15:20 in Kolkata: the next weekday 9:00 is Monday.
  const next = nextRun(s, 'Asia/Kolkata', new Date('2026-10-02T09:50:00Z'));
  assert.equal(next.toISOString(), '2026-10-05T03:30:00.000Z');
});

test('handles daylight saving changes', () => {
  // Lisbon leaves summer time on 2026-10-25: 9:00 local is 08:00Z before and 09:00Z after.
  assert.equal(zonedToUtc(2026, 10, 24, 9, 0, 'Europe/Lisbon').toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(zonedToUtc(2026, 10, 26, 9, 0, 'Europe/Lisbon').toISOString(), '2026-10-26T09:00:00.000Z');
});

test('interval schedules stay inside their window', () => {
  const s = parseSchedule('Every hour, 7:00 to 22:00')!;
  const next = nextRun(s, 'UTC', new Date('2026-10-02T22:30:00Z'), new Date('2026-10-02T21:59:00Z'));
  assert.equal(next.toISOString(), '2026-10-03T07:00:00.000Z');
});
