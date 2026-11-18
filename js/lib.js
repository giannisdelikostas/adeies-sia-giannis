// Pure calendar logic — no DOM, no network. Unit-tested in tests/lib.test.mjs.
// Dates are ISO strings 'YYYY-MM-DD'. Internally we use "day numbers"
// (days since 1970-01-01 in UTC) so time zones and DST can never shift a day.

export const DAY_MS = 86400000;

export function toNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
export function toISO(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
/** 0 = Sunday … 6 = Saturday */
export function weekday(n) {
  return (((n + 4) % 7) + 7) % 7;
}
export function addDays(iso, k) {
  return toISO(toNum(iso) + k);
}
export function todayISO(now = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export function isValidISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toISO(toNum(s)) === s;
}

/** Orthodox Easter Sunday (Meeus Julian algorithm, converted to Gregorian; valid 1900–2099). */
export function orthodoxEaster(year) {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return toISO(Math.round(Date.UTC(year, month - 1, day) / DAY_MS) + 13);
}

/** Official Greek public holidays. `optional: true` = many private-sector employees work. */
export const HOLIDAY_DEFS = [
  { key: 'new_year', name: 'Πρωτοχρονιά', fixed: '01-01' },
  { key: 'epiphany', name: 'Θεοφάνια', fixed: '01-06' },
  { key: 'clean_monday', name: 'Καθαρά Δευτέρα', easter: -48 },
  { key: 'mar25', name: '25η Μαρτίου', fixed: '03-25' },
  { key: 'good_friday', name: 'Μεγάλη Παρασκευή', easter: -2 },
  { key: 'easter', name: 'Κυριακή του Πάσχα', easter: 0, hidden: true },
  { key: 'easter_monday', name: 'Δευτέρα του Πάσχα', easter: 1 },
  { key: 'may1', name: 'Πρωτομαγιά', fixed: '05-01' },
  { key: 'whit_monday', name: 'Αγίου Πνεύματος', easter: 50, optional: true },
  { key: 'aug15', name: 'Κοίμηση της Θεοτόκου', fixed: '08-15' },
  { key: 'oct28', name: '28η Οκτωβρίου', fixed: '10-28' },
  { key: 'christmas', name: 'Χριστούγεννα', fixed: '12-25' },
  { key: 'dec26', name: 'Σύναξη της Θεοτόκου', fixed: '12-26' },
];

export function greekHolidays(year) {
  const easter = orthodoxEaster(year);
  return HOLIDAY_DEFS.map((h) => ({
    key: h.key,
    name: h.name,
    date: h.fixed ? `${year}-${h.fixed}` : addDays(easter, h.easter),
  }));
}

/**
 * Calendar for a household. `people` rows need id, work_days, skip_holidays.
 * `extras` rows: { person_id|null, date, name, yearly }.
 */
export function createCalendar(people = [], extras = []) {
  const yearCache = new Map(); // year -> Map(iso -> [{key,name}])
  function base(iso) {
    const y = Number(iso.slice(0, 4));
    if (!yearCache.has(y)) {
      const m = new Map();
      for (const h of greekHolidays(y)) {
        if (!m.has(h.date)) m.set(h.date, []);
        m.get(h.date).push(h);
      }
      yearCache.set(y, m);
    }
    return yearCache.get(y).get(iso) || [];
  }
  /** Holiday names that apply to this person on this date. */
  function holidaysFor(person, iso) {
    const skip = person?.skip_holidays || [];
    const out = base(iso).filter((h) => !skip.includes(h.key)).map((h) => h.name);
    for (const x of extras) {
      if (x.person_id && person && x.person_id !== person.id) continue;
      const hit = x.yearly ? x.date.slice(5) === iso.slice(5) : x.date === iso;
      if (hit && !out.includes(x.name)) out.push(x.name);
    }
    return out;
  }
  /** All holidays on that date for anyone (for calendar display). */
  function holidaysOn(iso) {
    const out = base(iso).map((h) => h.name);
    for (const x of extras) {
      const hit = x.yearly ? x.date.slice(5) === iso.slice(5) : x.date === iso;
      if (hit && !out.includes(x.name)) out.push(x.name);
    }
    return out;
  }
  function isWorkday(person, n) {
    const wd = person?.work_days || [1, 2, 3, 4, 5];
    if (!wd.includes(weekday(n))) return false;
    return holidaysFor(person, toISO(n)).length === 0;
  }
  return { holidaysFor, holidaysOn, isWorkday, people };
}

/** Working days a leave costs (optionally only inside [from,to] day numbers). */
export function leaveDays(leave, person, cal, range) {
  let s = toNum(leave.start_date), e = toNum(leave.end_date);
  if (range) { s = Math.max(s, range[0]); e = Math.min(e, range[1]); }
  let n = 0;
  for (let d = s; d <= e; d++) if (cal.isWorkday(person, d)) n++;
  if (leave.half_day && n > 0) return 0.5;
  return n;
}

/** Breakdown for the form preview: working days, weekend days, holidays. */
export function leaveBreakdown(start, end, halfDay, person, cal) {
  const s = toNum(start), e = toNum(end);
  const res = { work: 0, off: 0, holidays: [], total: e - s + 1 };
  const wd = person?.work_days || [1, 2, 3, 4, 5];
  for (let d = s; d <= e; d++) {
    if (!wd.includes(weekday(d))) { res.off++; continue; }
    const h = cal.holidaysFor(person, toISO(d));
    if (h.length) res.holidays.push({ date: toISO(d), name: h[0] });
    else res.work++;
  }
  if (halfDay && res.work > 0) res.work = 0.5;
  return res;
}

export function yearBounds(year) {
  return [toNum(`${year}-01-01`), toNum(`${year}-12-31`)];
}

export function leaveTouchesYear(leave, year) {
  const [a, b] = yearBounds(year);
  return toNum(leave.start_date) <= b && toNum(leave.end_date) >= a;
}

/** Usage for one person in one year. Annual leave is split into taken (before today) and planned. */
export function yearUsage(person, leaves, cal, year, today, allowance) {
  const [y0, y1] = yearBounds(year);
  const t = toNum(today);
  const u = { taken: 0, planned: 0, sick: 0, special: 0, unpaid: 0 };
  for (const l of leaves) {
    if (l.person_id !== person.id || !leaveTouchesYear(l, year)) continue;
    if (l.type === 'annual') {
      u.taken += leaveDays(l, person, cal, [y0, Math.min(y1, t - 1)]);
      u.planned += leaveDays(l, person, cal, [Math.max(y0, t), y1]);
    } else if (u[l.type] !== undefined) {
      u[l.type] += leaveDays(l, person, cal, [y0, y1]);
    }
  }
  const total = Number(allowance?.total_days || 0);
  const carried = Number(allowance?.carried_over || 0);
  u.available = total + carried;
  u.used = u.taken + u.planned;
  u.left = u.available - u.used;
  u.hasAllowance = !!allowance;
  return u;
}

/** The leave happening now, or the next one. */
export function nextLeave(personId, leaves, today) {
  const mine = leaves
    .filter((l) => l.person_id === personId && l.end_date >= today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return mine[0] || null;
}

export function daysBetween(a, b) {
  return toNum(b) - toNum(a);
}

export function overlappingLeaves(personId, start, end, leaves, excludeId) {
  return leaves.filter(
    (l) => l.person_id === personId && l.id !== excludeId && l.start_date <= end && l.end_date >= start,
  );
}

function leaveIndex(people, leaves, from, to) {
  const idx = new Map(people.map((p) => [p.id, new Set()]));
  for (const l of leaves) {
    const set = idx.get(l.person_id);
    if (!set) continue;
    const s = Math.max(toNum(l.start_date), from), e = Math.min(toNum(l.end_date), to);
    for (let d = s; d <= e; d++) set.add(d);
  }
  return idx;
}

/**
 * Bridge finder ("γέφυρες"): short runs of 1–maxCost working days that sit
 * between days off and touch a public holiday. Taking them gives a long break.
 */
export function findBridges(people, leaves, cal, fromISO, { days = 365, maxCost = 2 } = {}) {
  if (!people.length) return [];
  const from = toNum(fromISO), to = from + days;
  const lo = from - 14, hi = to + 14;
  const onLeave = leaveIndex(people, leaves, lo, hi);
  const offFor = (p, d) => !cal.isWorkday(p, d) || onLeave.get(p.id).has(d);
  const memo = new Map();
  const offAll = (d) => {
    if (!memo.has(d)) memo.set(d, people.every((p) => offFor(p, d)));
    return memo.get(d);
  };
  const isHol = (d) => people.some((p) => cal.holidaysFor(p, toISO(d)).length > 0);
  const out = [];
  let d = from;
  while (d <= to) {
    if (offAll(d)) { d++; continue; }
    let b = d;
    while (b + 1 <= hi && !offAll(b + 1)) b++;
    const len = b - d + 1;
    if (len <= maxCost && offAll(d - 1) && offAll(b + 1)) {
      let l = d - 1, r = b + 1;
      while (l - 1 >= lo && offAll(l - 1)) l--;
      while (r + 1 <= hi && offAll(r + 1)) r++;
      let holiday = null;
      for (let x = l; x <= r && !holiday; x++) if (isHol(x)) holiday = cal.holidaysOn(toISO(x))[0];
      const length = r - l + 1;
      if (holiday && length >= len + 3) {
        const cost = {};
        for (const p of people) {
          let c = 0;
          for (let x = d; x <= b; x++) if (!offFor(p, x)) c++;
          cost[p.id] = c;
        }
        out.push({ take: [toISO(d), toISO(b)], span: [toISO(l), toISO(r)], length, cost, holiday });
      }
    }
    d = b + 1;
  }
  return out;
}

/**
 * Stretches where everybody in `people` is free together (weekend, holiday or leave),
 * at least `minLen` days long and containing a holiday or a leave — not just plain weekends.
 */
export function freeStretches(people, leaves, cal, fromISO, { days = 365, minLen = 3 } = {}) {
  if (!people.length) return [];
  const from = toNum(fromISO), to = from + days;
  const onLeave = leaveIndex(people, leaves, from - 30, to + 30);
  const offAll = (d) => people.every((p) => !cal.isWorkday(p, d) || onLeave.get(p.id).has(d));
  const special = (d) =>
    people.some((p) => onLeave.get(p.id).has(d) || cal.holidaysFor(p, toISO(d)).length > 0);
  const out = [];
  let d = from;
  // if today is inside a stretch, start from its beginning
  while (offAll(d - 1) && d > from - 30) d--;
  while (d <= to) {
    if (!offAll(d)) { d++; continue; }
    let e = d;
    while (offAll(e + 1) && e < to + 30) e++;
    let sp = false, withLeave = false;
    for (let x = d; x <= e; x++) {
      if (special(x)) sp = true;
      if (people.some((p) => onLeave.get(p.id).has(x))) withLeave = true;
    }
    if (sp && e - d + 1 >= minLen && e >= from) {
      out.push({ start: toISO(d), end: toISO(e), length: e - d + 1, withLeave });
    }
    d = e + 1;
  }
  return out;
}

/** Suggested carry-over into `year`: what was left in the previous year (never negative). */
export function suggestedCarry(person, leaves, cal, year, allowances) {
  const prev = allowances.find((a) => a.person_id === person.id && a.year === year - 1);
  if (!prev) return 0;
  const u = yearUsage(person, leaves, cal, year - 1, `${year}-01-01`, prev);
  return Math.max(0, u.left);
}

// ── iCalendar export ─────────────────────────────────────────
function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
/** Fold lines to 75 octets without splitting multi-byte (Greek) characters. */
export function icsFold(line) {
  const enc = new TextEncoder();
  const parts = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length ? 74 : 75; // continuation lines start with a space
    if (bytes + b > limit) { parts.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}
export function buildICS(leaves, peopleById, typeLabels, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Adeies//EL', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Άδειες'];
  for (const l of leaves) {
    const who = peopleById[l.person_id]?.name || '';
    const label = l.type !== 'annual' ? ` (${typeLabels[l.type] || l.type})` : '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${l.id}@adeies`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${l.start_date.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${addDays(l.end_date, 1).replace(/-/g, '')}`,
      `SUMMARY:${icsEscape(`${who}: ${l.title}${label}`)}`,
      ...(l.note ? [`DESCRIPTION:${icsEscape(l.note)}`] : []),
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** Convert data from the old (v1, localStorage) app into leave rows. */
export function convertV1(v1, personId, newId) {
  const rows = [];
  let skipped = 0;
  for (const ev of v1?.events || []) {
    const start = ev.start, end = ev.end || ev.start;
    if (!isValidISO(start) || !isValidISO(end) || end < start) { skipped++; continue; }
    const half = Number(ev.days) === 0.5 && start === end;
    rows.push({
      id: newId(),
      person_id: personId,
      type: 'annual',
      title: String(ev.name || 'Άδεια').trim().slice(0, 80) || 'Άδεια',
      start_date: start,
      end_date: end,
      half_day: half,
      note: null,
    });
  }
  return { rows, skipped };
}
