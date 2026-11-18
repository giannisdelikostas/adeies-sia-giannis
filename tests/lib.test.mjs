// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/lib.js';

const me = { id: 'a', work_days: [1, 2, 3, 4, 5], skip_holidays: [] };
const her = { id: 'b', work_days: [1, 2, 3, 4, 5], skip_holidays: ['whit_monday'] };
const extras = [{ person_id: null, date: '2020-10-26', name: 'Αγίου Δημητρίου', yearly: true }];
const cal = L.createCalendar([me, her], extras);

test('day numbers are timezone-safe', () => {
  assert.equal(L.toISO(L.toNum('2026-03-29')), '2026-03-29'); // DST change day
  assert.equal(L.weekday(L.toNum('2026-11-18')), 3); // Wednesday
  assert.equal(L.addDays('2026-12-31', 1), '2027-01-01');
  assert.ok(L.isValidISO('2028-02-29'));
  assert.ok(!L.isValidISO('2026-02-30'));
  assert.ok(!L.isValidISO(''));
});

test('Orthodox Easter', () => {
  assert.equal(L.orthodoxEaster(2024), '2024-05-05');
  assert.equal(L.orthodoxEaster(2025), '2025-04-20');
  assert.equal(L.orthodoxEaster(2026), '2026-04-12');
  assert.equal(L.orthodoxEaster(2027), '2027-05-02');
  assert.equal(L.orthodoxEaster(2028), '2028-04-16');
});

test('movable holidays 2026', () => {
  const h = Object.fromEntries(L.greekHolidays(2026).map((x) => [x.key, x.date]));
  assert.equal(h.clean_monday, '2026-02-23');
  assert.equal(h.good_friday, '2026-04-10');
  assert.equal(h.easter_monday, '2026-04-13');
  assert.equal(h.whit_monday, '2026-06-01');
});

test('working days skip weekends, holidays, local holiday and per-person skips', () => {
  // Thu 24 Dec – Mon 28 Dec 2026: Thu, Mon working; Fri 25 + Sat 26 holidays; Sun
  assert.equal(L.leaveDays({ start_date: '2026-12-24', end_date: '2026-12-28' }, me, cal), 2);
  // Easter week Mon 6 – Mon 13 Apr 2026: Mon-Thu work (4), Fri GF, Mon EM
  assert.equal(L.leaveDays({ start_date: '2026-04-06', end_date: '2026-04-13' }, me, cal), 4);
  // Whit Monday 2026-06-01: holiday for me, workday for her
  assert.equal(L.leaveDays({ start_date: '2026-06-01', end_date: '2026-06-01' }, me, cal), 0);
  assert.equal(L.leaveDays({ start_date: '2026-06-01', end_date: '2026-06-01' }, her, cal), 1);
  // yearly local holiday (Mon 26 Oct 2026)
  assert.equal(L.leaveDays({ start_date: '2026-10-26', end_date: '2026-10-26' }, me, cal), 0);
  // half day
  assert.equal(L.leaveDays({ start_date: '2026-11-18', end_date: '2026-11-18', half_day: true }, me, cal), 0.5);
  // 6-day week
  const six = { id: 'c', work_days: [1, 2, 3, 4, 5, 6], skip_holidays: [] };
  assert.equal(L.leaveDays({ start_date: '2026-11-16', end_date: '2026-11-22' }, six, cal), 6);
});

test('year usage splits across years and taken/planned', () => {
  const leaves = [
    { id: '1', person_id: 'a', type: 'annual', start_date: '2026-12-28', end_date: '2027-01-08' },
    { id: '2', person_id: 'a', type: 'annual', start_date: '2026-07-06', end_date: '2026-07-10' },
    { id: '3', person_id: 'a', type: 'sick', start_date: '2026-03-02', end_date: '2026-03-03' },
  ];
  const u = L.yearUsage(me, leaves, cal, 2026, '2026-11-18', { total_days: 22, carried_over: 3 });
  assert.equal(u.taken, 5);
  assert.equal(u.planned, 4); // Mon 28 – Thu 31 Dec
  assert.equal(u.sick, 2);
  assert.equal(u.available, 25);
  assert.equal(u.left, 16);
  const u27 = L.yearUsage(me, leaves, cal, 2027, '2026-11-18', { total_days: 22, carried_over: 0 });
  assert.equal(u27.planned, 4); // Jan 1 (Fri) & 6 (Wed) holidays → Mon 4, Tue 5, Thu 7, Fri 8
});

test('bridges find the obvious ones', () => {
  // 2026: 28 Oct is Wednesday; 26 Oct Monday (local). Tue 27 is a 1-day bridge: Sat 24 – Wed 28 = 5 days
  const b = L.findBridges([me], [], cal, '2026-10-01', { days: 60 });
  const tue = b.find((x) => x.take[0] === '2026-10-27');
  assert.ok(tue, JSON.stringify(b));
  assert.equal(tue.length, 5);
  assert.deepEqual(tue.span, ['2026-10-24', '2026-10-28']);
  assert.equal(tue.cost.a, 1);
  // plain weeks never show up
  assert.ok(b.every((x) => x.holiday));
});

test('bridges for two people count each person separately', () => {
  // Tue 27 Oct 2026 for both; she already has that day off → costs her 0
  const leaves = [{ id: 'z', person_id: 'b', type: 'annual', start_date: '2026-10-27', end_date: '2026-10-27' }];
  const b = L.findBridges([me, her], leaves, cal, '2026-10-01', { days: 60 });
  const tue = b.find((x) => x.take[0] === '2026-10-27');
  assert.ok(tue, JSON.stringify(b));
  assert.equal(tue.cost.a, 1);
  assert.equal(tue.cost.b, 0);
});

test('free stretches together', () => {
  const leaves = [
    { id: 'x', person_id: 'a', type: 'annual', start_date: '2026-12-21', end_date: '2026-12-24' },
    { id: 'y', person_id: 'b', type: 'annual', start_date: '2026-12-22', end_date: '2026-12-31' },
  ];
  const s = L.freeStretches([me, her], leaves, cal, '2026-12-01', { days: 40 });
  const xmas = s.find((x) => x.start <= '2026-12-25' && x.end >= '2026-12-25');
  assert.deepEqual([xmas.start, xmas.end], ['2026-12-22', '2026-12-27']);
  assert.ok(xmas.withLeave);
});

test('overlaps', () => {
  const leaves = [{ id: '1', person_id: 'a', start_date: '2026-05-04', end_date: '2026-05-08' }];
  assert.equal(L.overlappingLeaves('a', '2026-05-08', '2026-05-10', leaves).length, 1);
  assert.equal(L.overlappingLeaves('a', '2026-05-09', '2026-05-10', leaves).length, 0);
  assert.equal(L.overlappingLeaves('a', '2026-05-04', '2026-05-04', leaves, '1').length, 0);
});

test('carry-over suggestion', () => {
  const leaves = [{ id: '1', person_id: 'a', type: 'annual', start_date: '2026-07-06', end_date: '2026-07-10' }];
  const allow = [{ person_id: 'a', year: 2026, total_days: 20, carried_over: 0 }];
  assert.equal(L.suggestedCarry(me, leaves, cal, 2027, allow), 15);
  assert.equal(L.suggestedCarry(me, leaves, cal, 2026, allow), 0);
});

test('ICS export folds Greek safely', () => {
  const ics = L.buildICS(
    [{ id: 'u1', person_id: 'a', type: 'sick', title: 'Πολύ μεγάλος τίτλος άδειας, με κόμμα; και ερωτηματικό', start_date: '2026-12-24', end_date: '2026-12-28' }],
    { a: { name: 'Γιάννης' } }, { sick: 'Ασθένεια' }, new Date('2026-11-18T00:00:00Z'));
  assert.match(ics, /DTSTART;VALUE=DATE:20261224/);
  assert.match(ics, /DTEND;VALUE=DATE:20261229/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /SUMMARY:Γιάννης: Πολύ μεγάλος τίτλος άδειας\\, με κόμμα\\; και ερωτηματικό \(Ασθένεια\)/);
});

test('v1 import', () => {
  let i = 0;
  const { rows, skipped } = L.convertV1(
    { events: [{ name: 'Καλοκαίρι', start: '2026-08-03', end: '2026-08-07', days: 5 }, { name: 'x', start: '', end: '', days: 2 }, { name: 'Μισή', start: '2026-02-02', end: '', days: 0.5 }] },
    'a', () => `id${i++}`);
  assert.equal(rows.length, 2);
  assert.equal(skipped, 1);
  assert.equal(rows[1].end_date, '2026-02-02');
  assert.equal(rows[1].half_day, true);
});
