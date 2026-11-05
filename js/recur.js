/*
 * Repeating reminders: works out when a reminder goes off next.
 *
 * This exact file is used twice — by the app (js/recur.js) and by the server
 * (functions/recur.js) — so both always agree. If you change one, copy it
 * over the other.
 *
 * Times are "wall clock" in the reminder's own time zone, so an 8:00 AM
 * reminder stays at 8:00 AM when daylight saving starts or ends.
 *
 * A rule looks like:
 *   { repeat: 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly' |
 *             'yearly' | 'days' | 'none',
 *     days: '1,3,5',          // for 'days': 0 = Sunday … 6 = Saturday
 *     anchor: '2026-11-04',   // first date — fixes the weekday / day of month
 *     time: '08:00',          // local time of day
 *     until: '2026-12-31',    // optional last date
 *     tz: 'America/New_York' }
 */

export const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly', 'days'];
const DAY_MS = 86400000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function pad(n) { return String(n).padStart(2, '0'); }
export function ymd(p) { return p.y + '-' + pad(p.m) + '-' + pad(p.d); }

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? { h: +m[1], min: +m[2] } : null;
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// Whole days between two calendar dates (no time zone involved).
function dayNumber(p) { return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS); }
function weekday(p) { return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(); }
function addDays(p, n) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// The calendar date and wall time of a moment, in a time zone.
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short'
  });
  const o = {};
  f.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: WEEKDAYS[o.weekday] };
}

// A wall-clock date and time in a time zone → the exact moment (ms).
export function zonedToMs(p, t, tz) {
  const want = Date.UTC(p.y, p.m - 1, p.d, t.h, t.min);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const l = localParts(guess, tz);
    const seen = Date.UTC(l.y, l.m - 1, l.d, l.h, l.min);
    const diff = want - seen;
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

function dayList(rule) {
  return String(rule.days || '').split(',').map(Number).filter((n) => n >= 0 && n <= 6);
}

// Does this calendar date have an occurrence?
function matches(rule, date, anchor) {
  if (dayNumber(date) < dayNumber(anchor)) return false;
  switch (rule.repeat) {
    case 'daily': return true;
    case 'weekdays': { const w = weekday(date); return w >= 1 && w <= 5; }
    case 'weekly': return weekday(date) === weekday(anchor);
    case 'biweekly': return weekday(date) === weekday(anchor) && ((dayNumber(date) - dayNumber(anchor)) / 7) % 2 === 0;
    case 'days': return dayList(rule).indexOf(weekday(date)) !== -1;
    // The 31st becomes the last day of shorter months.
    case 'monthly': return date.d === Math.min(anchor.d, daysInMonth(date.y, date.m));
    case 'yearly': return date.m === anchor.m && date.d === Math.min(anchor.d, daysInMonth(date.y, date.m));
    default: return false;
  }
}

export function isRepeating(rule) {
  return !!rule && REPEATS.indexOf(rule.repeat) > 0 && !!parseYmd(rule.anchor) && !!parseTime(rule.time) &&
    (rule.repeat !== 'days' || dayList(rule).length > 0);
}

// The first occurrence strictly after `afterMs`, or null if the rule has ended.
export function nextOccurrence(rule, afterMs) {
  if (!isRepeating(rule)) return null;
  const tz = rule.tz || 'America/New_York';
  const anchor = parseYmd(rule.anchor);
  const time = parseTime(rule.time);
  const until = parseYmd(rule.until);
  const start = localParts(afterMs, tz);
  let date = { y: start.y, m: start.m, d: start.d };
  if (dayNumber(date) < dayNumber(anchor)) date = anchor;
  for (let i = 0; i < 800; i++, date = addDays(date, 1)) {
    if (until && dayNumber(date) > dayNumber(until)) return null;
    if (!matches(rule, date, anchor)) continue;
    const ms = zonedToMs(date, time, tz);
    if (ms > afterMs) return ms;
  }
  return null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// "Every Tuesday", "Weekdays", "Every month on the 15th" …
export function describe(rule) {
  if (!isRepeating(rule)) return '';
  const a = parseYmd(rule.anchor);
  let text;
  switch (rule.repeat) {
    case 'daily': text = 'Every day'; break;
    case 'weekdays': text = 'Weekdays'; break;
    case 'weekly': text = 'Every ' + DAY_NAMES[weekday(a)]; break;
    case 'biweekly': text = 'Every other ' + DAY_NAMES[weekday(a)]; break;
    case 'days': text = 'Every ' + dayList(rule).sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7)).map((d) => SHORT[d]).join(' · '); break;
    case 'monthly': text = 'Every month on the ' + ordinal(a.d); break;
    case 'yearly': text = 'Every year on ' + new Date(Date.UTC(2000, a.m - 1, a.d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }); break;
    default: text = '';
  }
  const u = parseYmd(rule.until);
  if (u) text += ', until ' + new Date(Date.UTC(u.y, u.m - 1, u.d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return text;
}
