import * as config from '../config.js';
import { createStore, newId } from './store.js';
import {
  DAY_MS, toNum, toISO, addDays, todayISO, weekday, isValidISO, HOLIDAY_DEFS, greekHolidays,
  createCalendar, leaveDays, leaveBreakdown, yearBounds, leaveTouchesYear, yearUsage, nextLeave,
  daysBetween, overlappingLeaves, findBridges, freeStretches, suggestedCarry, buildICS, convertV1,
} from './lib.js';

// ── State ────────────────────────────────────────────────────
const S = {
  store: null, user: null, me: null,
  people: [], allowances: [], leaves: [], extras: [],
  cal: createCalendar(),
  tab: 'leaves', personId: null,
  today: todayISO(),
  year: Number(todayISO().slice(0, 4)),
  month: null, // { y, m } m: 0–11
  open: new Set(),
  unsub: null,
};
S.month = { y: S.year, m: Number(S.today.slice(5, 7)) - 1 };

const TYPES = {
  annual: { label: 'Κανονική', title: 'Άδεια' },
  sick: { label: 'Ασθένεια', title: 'Ασθένεια' },
  special: { label: 'Ειδική', title: 'Ειδική άδεια' },
  unpaid: { label: 'Άνευ αποδοχών', title: 'Άδεια άνευ αποδοχών' },
};
const TYPE_LABELS = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.label]));
const COLORS = ['#0f766e', '#d9573b', '#4f46e5', '#9d4edd', '#c2410c', '#be185d', '#2f855a', '#0369a1'];
const WEEK = [[1, 'Δε'], [2, 'Τρ'], [3, 'Τε'], [4, 'Πε'], [5, 'Πα'], [6, 'Σα'], [0, 'Κυ']];
const V1_FLAG = 'adeies-v1-imported';

// ── Helpers ──────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#777777');
const dateOf = (iso) => new Date(toNum(iso) * DAY_MS);
const F = {
  short: new Intl.DateTimeFormat('el-GR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
  shortY: new Intl.DateTimeFormat('el-GR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
  dm: new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
  long: new Intl.DateTimeFormat('el-GR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
  month: new Intl.DateTimeFormat('el-GR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  dayMonth: new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'long', timeZone: 'UTC' }),
};
const curYear = () => Number(S.today.slice(0, 4));
function fmtRange(s, e) {
  const sameYearAsNow = s.slice(0, 4) === String(curYear()) && e.slice(0, 4) === String(curYear());
  const f = sameYearAsNow ? F.short : F.shortY;
  if (s === e) return f.format(dateOf(s));
  try { return f.formatRange(dateOf(s), dateOf(e)); } catch { return `${f.format(dateOf(s))} – ${f.format(dateOf(e))}`; }
}
const fmtDay = (iso) => F.short.format(dateOf(iso));
function n2s(n) {
  const neg = n < 0; n = Math.abs(n);
  const whole = Math.floor(n), half = n - whole >= 0.5;
  const s = half ? (whole ? `${whole}½` : '½') : String(whole);
  return (neg ? '−' : '') + s;
}
const daysWord = (n) => (n === 1 ? 'μέρα' : 'μέρες');
const workWord = (n) => (n === 1 || n === 0.5 ? 'εργάσιμη' : 'εργάσιμες');
const person = (id) => S.people.find((p) => p.id === id);
const allowanceOf = (pid, year) => S.allowances.find((a) => a.person_id === pid && Number(a.year) === year);
const pStyle = (p) => `--c:${safeColor(p?.color)}`;
const isMe = (p) => p && S.me && p.id === S.me.id;
function inDays(n) {
  if (n === 0) return 'σήμερα';
  if (n === 1) return 'αύριο';
  return `σε ${n} μέρες`;
}
function firstWorkdayAfter(p, iso) {
  let n = toNum(iso) + 1;
  for (let i = 0; i < 40 && !S.cal.isWorkday(p, n); i++) n++;
  return toISO(n);
}
const icon = {
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
};

// ── Toast ────────────────────────────────────────────────────
let toastTimer;
function toast(msg, { action, error = false, ms = 4000 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.fn(); };
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}
const fail = (e) => { console.error(e); toast(e?.message || 'Κάτι πήγε στραβά.', { error: true, ms: 6000 }); };

// ── Data ─────────────────────────────────────────────────────
async function loadData() {
  const d = await S.store.loadAll();
  S.people = d.people.map((p) => ({ ...p, work_days: (p.work_days || []).map(Number), skip_holidays: p.skip_holidays || [] }));
  S.allowances = d.allowances.map((a) => ({ ...a, year: Number(a.year), total_days: Number(a.total_days), carried_over: Number(a.carried_over) }));
  S.leaves = d.leaves;
  S.extras = d.extras;
  S.cal = createCalendar(S.people, S.extras);
  const email = (S.user?.email || '').toLowerCase();
  S.me = S.people.find((p) => (p.email || '').toLowerCase() === email) || null;
  if (!person(S.personId)) S.personId = S.me?.id || S.people[0]?.id || null;
  const root = document.documentElement.style;
  if (S.people[0]) root.setProperty('--p1', safeColor(S.people[0].color));
  if (S.people[1]) root.setProperty('--p2', safeColor(S.people[1].color));
}
let refreshTimer;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }
async function refresh() {
  try { await loadData(); render(); } catch (e) { fail(e); }
}
async function mutate(fn, okMsg, opts) {
  try { await fn(); await loadData(); render(); if (okMsg) toast(okMsg, opts); return true; } catch (e) { fail(e); return false; }
}

// ── Boot & auth ──────────────────────────────────────────────
function show(id) {
  for (const x of ['boot', 'auth', 'shell']) $(`#${x}`).hidden = x !== id;
}
function bootError(msg) {
  show('boot');
  $('#boot').innerHTML = `<div class="boot-mark" aria-hidden="true"><span></span><span></span></div>
    <p>${esc(msg)}</p><button class="btn btn-primary" type="button" onclick="location.reload()">Ξανά</button>`;
}
function showAuth(error) {
  show('auth');
  const form = $('#auth-form');
  $('#auth-error').hidden = !error;
  $('#auth-error').textContent = error || '';
  $('#auth-hint').hidden = S.store?.mode !== 'demo';
  form.querySelectorAll('input').forEach((i) => { i.required = S.store?.mode !== 'demo'; });
  setTimeout(() => form.email.focus(), 50);
}
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type="submit"]');
  const email = form.email.value.trim(), password = form.password.value;
  if (S.store.mode !== 'demo' && (!email || !password)) return showAuth('Συμπλήρωσε e-mail και κωδικό.');
  btn.disabled = true; btn.textContent = 'Σύνδεση…';
  try {
    const user = await S.store.signIn(email, password);
    form.password.value = '';
    await enter(user);
  } catch (err) {
    showAuth(err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Είσοδος';
  }
});

async function enter(user) {
  S.user = user;
  try { await loadData(); } catch (e) { return bootError(e.message || 'Δεν φόρτωσαν τα δεδομένα.'); }
  if (!S.me) {
    const email = user.email;
    await S.store.signOut();
    S.user = null;
    return showAuth(`Το ${email} δεν είναι στη λίστα. Πρόσθεσέ το στον πίνακα people στο Supabase.`);
  }
  $('#demo-banner').hidden = S.store.mode !== 'demo';
  show('shell');
  S.unsub?.();
  S.unsub = S.store.subscribe(refreshSoon);
  readHash();
  render();
}

async function signOut() {
  S.unsub?.(); S.unsub = null;
  await S.store.signOut();
  S.user = null; S.me = null;
  showAuth();
}

async function boot() {
  try {
    S.store = await createStore(config);
  } catch (e) {
    console.error(e);
    return bootError('Δεν φόρτωσε η σύνδεση με τη βάση. Έλεγξε το internet.');
  }
  S.store.onAuth((user) => {
    if (!user && S.user) { S.user = null; S.unsub?.(); showAuth(); }
  });
  let user = null;
  try { user = await S.store.getUser(); } catch { /* treat as signed out */ }
  if (user) await enter(user); else showAuth();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.user) return;
  const t = todayISO();
  if (t !== S.today) S.today = t;
  refreshSoon();
});

// ── Routing ──────────────────────────────────────────────────
const TABS = ['leaves', 'together', 'calendar', 'settings'];
function readHash() {
  const h = location.hash.slice(1);
  S.tab = TABS.includes(h) ? h : 'leaves';
}
addEventListener('hashchange', () => { readHash(); render(); scrollTo(0, 0); });
function go(tab) {
  if (location.hash.slice(1) !== tab) location.hash = tab; else render();
}

// ── Render ───────────────────────────────────────────────────
function render() {
  if (!S.user || !S.me) return;
  document.querySelectorAll('.tabbar [data-tab]').forEach((b) => {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#year-label').textContent = S.tab === 'calendar' ? S.month.y : S.year;
  const view = $('#view');
  view.innerHTML = ({ leaves: viewLeaves, together: viewTogether, calendar: viewCalendar, settings: viewSettings }[S.tab])();
  $('.fab').hidden = S.tab === 'settings';
}

function ring(p, u, size = 'big') {
  const r = 52, C = 2 * Math.PI * r;
  const av = u.available;
  const fTaken = av > 0 ? Math.min(1, u.taken / av) : 0;
  const fUsed = av > 0 ? Math.min(1, u.used / av) : 0;
  return `<div class="ring" style="${pStyle(p)}" role="img" aria-label="Μένουν ${n2s(u.left)} από ${n2s(av)} μέρες">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${r}"/>
      ${fUsed > 0 ? `<circle class="planned" cx="60" cy="60" r="${r}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - fUsed)}"/>` : ''}
      ${fTaken > 0 ? `<circle class="val" cx="60" cy="60" r="${r}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - fTaken)}"/>` : ''}
    </svg>
    <div class="ring-center"><div class="big${u.left < 0 ? ' neg' : ''}">${n2s(u.left)}</div><div class="cap">${size === 'big' ? 'μέρες μένουν' : `από ${n2s(av)}`}</div></div>
  </div>`;
}

function personSwitch() {
  if (S.people.length < 2) return '';
  return `<div class="person-switch" role="group" aria-label="Άτομο">${S.people.map((p) => `
    <button class="chip" type="button" data-action="person" data-id="${esc(p.id)}" aria-pressed="${p.id === S.personId}" style="${pStyle(p)}">
      <span class="dot"></span>${esc(p.name)}${isMe(p) ? ' <span class="visually-hidden">(εσύ)</span>' : ''}
    </button>`).join('')}</div>`;
}

function leaveRow(l, { showWho = false, year = null } = {}) {
  const p = person(l.person_id);
  const total = leaveDays(l, p, S.cal);
  const inYear = year ? leaveDays(l, p, S.cal, yearBounds(year)) : total;
  const now = l.start_date <= S.today && l.end_date >= S.today;
  const past = l.end_date < S.today;
  const unit = l.type === 'annual' ? workWord(total) : (total === 1 ? 'μέρα' : 'μέρες');
  return `<button type="button" class="leave${now ? ' now' : ''}${past ? ' past' : ''}" style="${pStyle(p)}" data-action="edit-leave" data-id="${esc(l.id)}">
    <span class="bar t-${esc(l.type)}" aria-hidden="true"></span>
    <span>
      <span class="t">${esc(l.title)}</span>${l.type !== 'annual' ? `<span class="tag">${esc(TYPE_LABELS[l.type])}</span>` : ''}${now ? '<span class="tag">τώρα</span>' : ''}
      <span class="d">${showWho ? `<span class="who"><i></i>${esc(p?.name)}</span> · ` : ''}${esc(fmtRange(l.start_date, l.end_date))}${l.half_day ? ' · μισή μέρα' : ''}</span>
    </span>
    <span class="n"><b>${n2s(total)}</b><small>${unit}${inYear !== total ? `<br>${n2s(inYear)} το ${year}` : ''}</small></span>
  </button>`;
}

function statusCard(p) {
  const nl = nextLeave(p.id, S.leaves, S.today);
  if (!nl) {
    return `<div class="card status" style="${pStyle(p)}"><div class="badge"><b>—</b></div>
      <div><h3>Καμία προγραμματισμένη άδεια</h3><p>Δες παρακάτω τις γέφυρες της χρονιάς.</p></div></div>`;
  }
  if (nl.start_date <= S.today) {
    const back = firstWorkdayAfter(p, nl.end_date);
    const n = daysBetween(S.today, back);
    return `<div class="card status" style="${pStyle(p)}"><div class="badge"><b>${n}</b><small>${n === 1 ? 'ΜΕΡΑ' : 'ΜΕΡΕΣ'}</small></div>
      <div><h3>${isMe(p) ? 'Είσαι' : `${esc(p.name)}:`} σε άδεια τώρα — ${esc(nl.title)}</h3><p>Επιστροφή ${esc(fmtDay(back))}</p></div></div>`;
  }
  const n = daysBetween(S.today, nl.start_date);
  return `<div class="card status" style="${pStyle(p)}"><div class="badge"><b>${n}</b><small>${n === 1 ? 'ΜΕΡΑ' : 'ΜΕΡΕΣ'}</small></div>
    <div><h3>Επόμενη άδεια ${inDays(n)}</h3><p>${esc(nl.title)} · ${esc(fmtRange(nl.start_date, nl.end_date))}</p></div></div>`;
}

function bridgesCard(people, title, { limitKey }) {
  const from = S.year === curYear() ? S.today : `${S.year}-01-01`;
  if (S.year < curYear()) return '';
  const all = findBridges(people, S.leaves, S.cal, from, { days: 400 })
    .filter((b) => b.take[0].startsWith(String(S.year)) && b.take[0] >= S.today)
    .filter((b) => people.some((p) => b.cost[p.id] > 0));
  if (!all.length) return '';
  const showAll = S.open.has(limitKey);
  const list = showAll ? all : all.slice(0, 4);
  return `<section class="card">
    <div class="card-title"><h2>${esc(title)}</h2><span class="sub">${all.length} για το ${S.year}</span></div>
    ${list.map((b) => {
      const who = people.filter((p) => b.cost[p.id] > 0).map((p) => p.id).join(',');
      const maxCost = Math.max(...people.map((p) => b.cost[p.id]));
      return `<div class="bridge">
        <div class="gain"><b>${b.length}</b><small>ΜΕΡΕΣ</small></div>
        <div>
          <h3>Πάρε ${esc(b.take[0] === b.take[1] ? fmtDay(b.take[0]) : fmtRange(b.take[0], b.take[1]))}</h3>
          <p>${esc(fmtRange(b.span[0], b.span[1]))} · ${esc(b.holiday)}</p>
          ${people.length > 1 ? `<div class="cost">${people.map((p) => `<span style="${pStyle(p)}"><i></i>${esc(p.name)}: ${b.cost[p.id] ? `${b.cost[p.id]} ${workWord(b.cost[p.id])}` : 'ελεύθερος/η'}</span>`).join('')}</div>`
            : `<p>κοστίζει ${maxCost} ${workWord(maxCost)}</p>`}
        </div>
        <button class="btn btn-small" type="button" data-action="book-bridge" data-start="${b.take[0]}" data-end="${b.take[1]}" data-who="${esc(who)}" data-holiday="${esc(b.holiday)}">Κλείσ’ το</button>
      </div>`;
    }).join('')}
    ${all.length > 4 ? `<button class="btn btn-ghost btn-small" type="button" data-action="toggle-open" data-key="${limitKey}">${showAll ? 'Λιγότερες' : `Όλες (${all.length})`}</button>` : ''}
  </section>`;
}

function viewLeaves() {
  const p = person(S.personId) || S.me;
  const a = allowanceOf(p.id, S.year);
  const u = yearUsage(p, S.leaves, S.cal, S.year, S.today, a);
  const mine = S.leaves.filter((l) => l.person_id === p.id && leaveTouchesYear(l, S.year));
  const upcoming = mine.filter((l) => l.end_date >= S.today).sort((x, y) => x.start_date.localeCompare(y.start_date));
  const past = mine.filter((l) => l.end_date < S.today).sort((x, y) => y.start_date.localeCompare(x.start_date));
  const others = [['sick', u.sick], ['special', u.special], ['unpaid', u.unpaid]].filter(([, n]) => n > 0);

  const hero = a
    ? `<section class="card hero">
        ${ring(p, u)}
        <div class="legend" style="${pStyle(p)}">
          <div class="legend-row"><span class="sw none"></span>Δικαιούσαι<b>${n2s(u.available)}</b></div>
          <div class="legend-row"><span class="sw"></span>Πήρες<b>${n2s(u.taken)}</b></div>
          <div class="legend-row"><span class="sw planned"></span>Προγραμματισμένες<b>${n2s(u.planned)}</b></div>
          ${a.carried_over ? `<div class="legend-row" style="font-size:12.5px">από τις οποίες ${n2s(a.carried_over)} μεταφορά από ${S.year - 1}</div>` : ''}
          ${u.left < 0 ? `<div class="warn">Έχεις ξεπεράσει το όριο κατά ${n2s(-u.left)}.</div>` : ''}
          <div class="legend-actions"><button class="btn btn-small" type="button" data-action="allowance" data-id="${esc(p.id)}">Αλλαγή ορίου</button></div>
        </div>
      </section>`
    : `<section class="card empty-hero">
        <h2>Πόσες μέρες άδεια ${isMe(p) ? 'έχεις' : `έχει ${esc(p.name)}`} το ${S.year};</h2>
        <p>Όρισέ το μία φορά και θα βλέπεις πόσες μένουν. Υπολογίζονται μόνο εργάσιμες.</p>
        <button class="btn btn-primary" type="button" data-action="allowance" data-id="${esc(p.id)}">Ορισμός ημερών</button>
      </section>`;

  return `${personSwitch()}
  <div class="grid-2">
    <div class="stack">
      ${hero}
      ${S.year >= curYear() ? statusCard(p) : ''}
      ${others.length ? `<div class="mini-stats">${others.map(([k, n]) => `<span class="mini-stat">${esc(TYPE_LABELS[k])} <b>${n2s(n)}</b></span>`).join('')}</div>` : ''}
      ${bridgesCard([p], 'Γέφυρες', { limitKey: `bridges-${p.id}` })}
    </div>
    <div class="stack">
      <h2 class="section-title">${S.year < curYear() ? `Άδειες ${S.year}` : 'Επόμενες'}</h2>
      ${upcoming.length ? `<div class="list">${upcoming.map((l) => leaveRow(l, { year: S.year })).join('')}</div>`
        : S.year >= curYear() ? `<div class="empty">Τίποτα προγραμματισμένο ακόμα.<br><button class="btn btn-small" style="margin-top:10px" type="button" data-action="new-leave">+ Νέα άδεια</button></div>` : ''}
      ${past.length ? `<details class="past-wrap" data-key="past" ${S.open.has('past') || S.year < curYear() ? 'open' : ''}>
          <summary class="section-title">${icon.chev}Παλαιότερες (${past.length})</summary>
          <div class="list">${past.map((l) => leaveRow(l, { year: S.year })).join('')}</div>
        </details>` : ''}
      ${!mine.length && S.year < curYear() ? '<div class="empty">Καμία άδεια αυτή τη χρονιά.</div>' : ''}
    </div>
  </div>`;
}

function viewTogether() {
  if (S.people.length < 2) return '<div class="empty">Χρειάζονται δύο άτομα στον πίνακα people.</div>';
  const [p1, p2] = S.people;
  const duo = S.people.slice(0, 2).map((p) => {
    const a = allowanceOf(p.id, S.year);
    const u = yearUsage(p, S.leaves, S.cal, S.year, S.today, a);
    return `<button type="button" class="card" style="${pStyle(p)}" data-action="person-go" data-id="${esc(p.id)}">
      ${ring(p, u, 'small')}
      <span class="name"><i></i>${esc(p.name)}</span>
      <span class="sub">${a ? `${n2s(u.planned)} προγραμματισμένες` : 'χωρίς όριο'}</span>
    </button>`;
  }).join('');

  const stretches = freeStretches([p1, p2], S.leaves, S.cal, S.today, { days: 365 });
  const next = stretches[0];
  let hero;
  if (next) {
    const nowIn = next.start <= S.today;
    const n = daysBetween(S.today, next.start);
    hero = `<section class="card together-hero">
      <div class="kicker">${nowIn ? 'Τώρα' : 'Επόμενη φορά'} ελεύθεροι μαζί</div>
      <h2>${esc(fmtRange(next.start, next.end))}</h2>
      <p>${next.length} ${daysWord(next.length)} μαζί${nowIn ? ` · μέχρι ${esc(fmtDay(next.end))}` : ` · ${inDays(n)}`}${next.withLeave ? '' : ' · μόνο με αργίες'}</p>
    </section>`;
  } else {
    hero = `<section class="card together-hero"><div class="kicker">Ελεύθεροι μαζί</div><h2>Τίποτα κοινό ακόμα</h2><p>Κλείστε μια γέφυρα από κάτω 👇</p></section>`;
  }

  const overlapLeaves = S.leaves
    .filter((l) => l.person_id === p1.id && l.end_date >= S.today)
    .flatMap((a) => S.leaves.filter((b) => b.person_id === p2.id && b.start_date <= a.end_date && b.end_date >= a.start_date)
      .map((b) => ({ s: a.start_date > b.start_date ? a.start_date : b.start_date, e: a.end_date < b.end_date ? a.end_date : b.end_date, a, b })));

  return `<div class="duo">${duo}</div>
  ${hero}
  <div class="grid-2">
    <div class="stack">
      <section class="card">
        <div class="card-title"><h2>Ελεύθεροι μαζί</h2><span class="sub">επόμενοι 12 μήνες</span></div>
        ${stretches.length ? stretches.slice(0, S.open.has('stretches-all') ? 50 : 6).map((s) => `
          <div class="stretch">
            <div class="len">${s.length}<small>ΜΕΡΕΣ</small></div>
            <div class="txt"><b>${esc(fmtRange(s.start, s.end))}</b><p>${esc(stretchReason(s, [p1, p2]))}</p></div>
            ${s.withLeave ? '<span class="pill leave-pill">με άδεια</span>' : '<span class="pill">αργία</span>'}
          </div>`).join('') : '<p class="sub">Κανένα κοινό διάστημα 3+ ημερών.</p>'}
        ${stretches.length > 6 ? `<button class="btn btn-ghost btn-small" type="button" data-action="toggle-open" data-key="stretches-all">${S.open.has('stretches-all') ? 'Λιγότερα' : `Όλα (${stretches.length})`}</button>` : ''}
      </section>
      ${overlapLeaves.length ? `<section class="card">
        <div class="card-title"><h2>Κοινές άδειες</h2></div>
        ${overlapLeaves.map((o) => `<div class="stretch"><div class="len">${daysBetween(o.s, o.e) + 1}<small>ΜΕΡΕΣ</small></div>
          <div class="txt"><b>${esc(fmtRange(o.s, o.e))}</b><p>${esc(o.a.title)}${o.a.title !== o.b.title ? ` / ${esc(o.b.title)}` : ''}</p></div></div>`).join('')}
      </section>` : ''}
    </div>
    <div class="stack">
      ${bridgesCard([p1, p2], 'Γέφυρες για τους δύο', { limitKey: 'bridges-both' }) || '<div class="empty">Δεν βρέθηκαν άλλες γέφυρες για φέτος.</div>'}
    </div>
  </div>`;
}

function stretchReason(s, people) {
  const names = new Set();
  for (let n = toNum(s.start); n <= toNum(s.end); n++) {
    const iso = toISO(n);
    for (const h of S.cal.holidaysOn(iso)) names.add(h);
    for (const l of S.leaves) if (people.some((p) => p.id === l.person_id) && l.start_date <= iso && l.end_date >= iso) names.add(l.title);
  }
  return [...names].slice(0, 3).join(' · ');
}

function dayInfo(iso) {
  const n = toNum(iso);
  const rows = S.people.map((p) => {
    const leaves = S.leaves.filter((l) => l.person_id === p.id && l.start_date <= iso && l.end_date >= iso);
    return { p, leaves, work: S.cal.isWorkday(p, n), hol: S.cal.holidaysFor(p, iso) };
  });
  return { rows, hol: S.cal.holidaysOn(iso), weekend: [0, 6].includes(weekday(n)) };
}

function viewCalendar() {
  const { y, m } = S.month;
  const first = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const lead = (weekday(toNum(first)) + 6) % 7; // Monday first
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="cal-day out" aria-hidden="true"></div>');
  const monthEvents = [];
  for (let d = 1; d <= daysIn; d++) {
    const iso = addDays(first, d - 1);
    const info = dayInfo(iso);
    const on = info.rows.filter((r) => r.leaves.length);
    const both = S.people.length > 1 && info.rows.every((r) => r.leaves.length || !r.work) && on.length > 0 && !info.weekend && !info.hol.length;
    const cls = ['cal-day', info.weekend && 'weekend', info.hol.length && 'holiday', iso === S.today && 'today', both && 'both'].filter(Boolean).join(' ');
    const marks = on.flatMap((r) => r.leaves.map((l) => `<i class="t-${esc(l.type)}${l.half_day ? ' half' : ''}" style="${pStyle(r.p)}"></i>`)).join('');
    const label = [F.long.format(dateOf(iso)), ...info.hol, ...on.map((r) => `${r.p.name}: ${r.leaves.map((l) => l.title).join(', ')}`)].join('. ');
    cells.push(`<button type="button" class="${cls}" data-action="day" data-date="${iso}" aria-label="${esc(label)}">
      <span class="dn">${d}</span><span></span><span class="marks">${marks}</span></button>`);
    for (const h of info.hol) monthEvents.push({ iso, html: `<span style="color:var(--holiday)">${esc(h)}</span>` });
  }
  for (const l of S.leaves) {
    const last = addDays(first, daysIn - 1);
    if (l.start_date <= last && l.end_date >= first) {
      const p = person(l.person_id);
      monthEvents.push({ iso: l.start_date < first ? first : l.start_date, html: `<span style="${pStyle(p)}"><b style="color:var(--c);width:auto">●</b> ${esc(p?.name)} — ${esc(l.title)} <span style="color:var(--muted)">(${esc(fmtRange(l.start_date, l.end_date))})</span></span>` });
    }
  }
  monthEvents.sort((a, b) => a.iso.localeCompare(b.iso));
  const label = F.month.format(dateOf(first));
  return `<section class="card">
    <div class="cal-head">
      <h2>${esc(label)}</h2>
      <div class="nav">
        ${S.month.y !== curYear() || S.month.m !== Number(S.today.slice(5, 7)) - 1 ? '<button class="btn btn-small" type="button" data-action="cal-today">Σήμερα</button>' : ''}
        <button class="icon-btn" type="button" data-action="cal-month" data-delta="-1" aria-label="Προηγούμενος μήνας">${icon.left}</button>
        <button class="icon-btn" type="button" data-action="cal-month" data-delta="1" aria-label="Επόμενος μήνας">${icon.chev}</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ', 'Κυρ'].map((d) => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('')}
      ${cells.join('')}
    </div>
    <div class="cal-legend">
      ${S.people.map((p) => `<span style="${pStyle(p)}"><i></i>${esc(p.name)}</span>`).join('')}
      <span><i class="h"></i>Αργία</span>
      ${S.people.length > 1 ? '<span><i class="b"></i>Μαζί σε άδεια</span>' : ''}
    </div>
  </section>
  <section class="card">
    <div class="card-title"><h2>Αυτόν τον μήνα</h2></div>
    ${monthEvents.length ? `<ul class="month-list">${monthEvents.map((e) => `<li><b>${esc(fmtDay(e.iso))}</b>${e.html}</li>`).join('')}</ul>` : '<p class="sub" style="color:var(--muted)">Ήσυχος μήνας.</p>'}
  </section>`;
}

function viewSettings() {
  const people = S.people.map((p) => {
    const a = allowanceOf(p.id, S.year);
    const hols = greekHolidays(S.year).filter((h) => !HOLIDAY_DEFS.find((d) => d.key === h.key).hidden);
    return `<section class="card settings-person" style="${pStyle(p)}">
      <div class="card-title" style="margin:0"><h2><span style="color:var(--c)">●</span> ${esc(p.name)}</h2>${isMe(p) ? '<span class="sub">εσύ</span>' : ''}</div>
      <label class="field"><span>Όνομα</span>
        <input type="text" maxlength="40" value="${esc(p.name)}" data-person-name="${esc(p.id)}" autocomplete="off" /></label>
      <div class="field"><span class="label" id="col-${esc(p.id)}">Χρώμα</span>
        <div class="swatches" role="radiogroup" aria-labelledby="col-${esc(p.id)}">${COLORS.map((c) =>
          `<button type="button" class="swatch" role="radio" style="--c:${c}" aria-checked="${c.toLowerCase() === (p.color || '').toLowerCase()}" aria-label="Χρώμα ${c}" data-action="person-color" data-id="${esc(p.id)}" data-color="${c}"></button>`).join('')}
        </div></div>
      <div class="field"><span class="label">Εργάσιμες μέρες</span>
        <div class="weekdays">${WEEK.map(([d, l]) =>
          `<button type="button" class="chip" aria-pressed="${p.work_days.includes(d)}" data-action="person-wd" data-id="${esc(p.id)}" data-day="${d}">${l}</button>`).join('')}
        </div></div>
      <div class="allow-line"><span>Άδεια ${S.year}<br><small style="color:var(--muted)">${a ? `${n2s(a.total_days)} + ${n2s(a.carried_over)} μεταφορά` : 'δεν έχει οριστεί'}</small></span>
        <span style="display:flex;align-items:center;gap:12px">${a ? `<b>${n2s(a.total_days + a.carried_over)}</b>` : ''}<button class="btn btn-small" type="button" data-action="allowance" data-id="${esc(p.id)}">${a ? 'Αλλαγή' : 'Ορισμός'}</button></span></div>
      <details class="block" data-key="hol-${esc(p.id)}" ${S.open.has(`hol-${p.id}`) ? 'open' : ''}>
        <summary>Αργίες που ισχύουν ${icon.chev}</summary>
        <div class="hol-list">${hols.map((h) => {
          const def = HOLIDAY_DEFS.find((d) => d.key === h.key);
          const on = !p.skip_holidays.includes(h.key);
          return `<label class="switch-row"><span>${esc(h.name)}<small>${esc(fmtDay(h.date))}${def.optional ? ' · πολλοί στον ιδιωτικό τομέα δουλεύουν' : ''}</small></span>
            <span class="switch"><input type="checkbox" ${on ? 'checked' : ''} data-person-hol="${esc(p.id)}" data-key="${h.key}" /><span></span></span></label>`;
        }).join('')}</div>
      </details>
    </section>`;
  }).join('');

  const extras = S.extras.slice().sort((a, b) => a.date.slice(5).localeCompare(b.date.slice(5)));
  const v1 = detectV1();
  return `<div class="grid-2"><div class="stack">${people}</div>
  <div class="stack">
    <section class="card">
      <div class="card-title"><h2>Επιπλέον αργίες</h2><button class="btn btn-small" type="button" data-action="extra-new">+ Προσθήκη</button></div>
      <p class="sub" style="color:var(--muted);font-size:13px;margin-bottom:6px">Τοπικές αργίες (π.χ. πολιούχος), μέρες που κλείνει η εταιρεία, ή η Πρωτομαγιά όταν μετατίθεται.</p>
      ${extras.length ? extras.map((x) => `<div class="extra">
          <div class="txt"><b>${esc(x.name)}</b><p>${x.yearly ? `κάθε χρόνο, ${esc(F.dayMonth.format(dateOf(x.date)))}` : esc(F.shortY.format(dateOf(x.date)))} · ${x.person_id ? esc(person(x.person_id)?.name) : 'και οι δύο'}</p></div>
          <button class="icon-btn" type="button" data-action="extra-del" data-id="${esc(x.id)}" aria-label="Διαγραφή ${esc(x.name)}">${icon.trash}</button>
        </div>`).join('') : '<p style="color:var(--muted)">Καμία.</p>'}
    </section>
    ${v1 ? v1Card(v1) : ''}
    <section class="card">
      <div class="card-title"><h2>Δεδομένα</h2></div>
      <div class="row-actions">
        <button class="btn" type="button" data-action="export-ics">Εξαγωγή στο ημερολόγιο (.ics)</button>
        <button class="btn" type="button" data-action="export-json">Αντίγραφο ασφαλείας (.json)</button>
      </div>
      <p class="note-box" style="margin-top:12px">Το .ics ανοίγει στο Google/Apple Calendar και προσθέτει όλες τις άδειες ως ολοήμερα γεγονότα.</p>
    </section>
    <section class="card">
      <div class="card-title"><h2>Λογαριασμός</h2></div>
      <p style="color:var(--muted);margin-bottom:12px">${esc(S.user.email)}${S.store.mode === 'demo' ? ' · demo' : ''}</p>
      <div class="row-actions">
        <button class="btn" type="button" data-action="sign-out">Αποσύνδεση</button>
        ${S.store.mode === 'demo' ? '<button class="btn btn-ghost" type="button" data-action="reset-demo">Επαναφορά demo</button>' : ''}
      </div>
    </section>
  </div></div>`;
}

// ── v1 import (old localStorage app on the same domain) ──────
function detectV1() {
  try {
    if (localStorage.getItem(V1_FLAG)) return null;
    const slots = ['user1', 'user2'].map((k) => {
      const raw = localStorage.getItem(`leave-tracker-${k}`);
      return raw ? { key: k, ...JSON.parse(raw) } : null;
    }).filter((x) => x && (x.events?.length || x.totalDays));
    return slots.length ? slots : null;
  } catch { return null; }
}
function v1Card(slots) {
  return `<section class="card">
    <div class="card-title"><h2>Δεδομένα από την παλιά έκδοση</h2></div>
    <p style="color:var(--muted);font-size:14px">Βρέθηκαν σε αυτόν τον browser. Διάλεξε σε ποιον ανήκουν και φέρ’ τα εδώ — οι μέρες θα ξαναϋπολογιστούν ως εργάσιμες.</p>
    <div class="import-map">${slots.map((s, i) => `<label class="field"><span>«${esc(s.name || s.key)}» · ${s.events?.length || 0} άδειες</span>
      <select data-v1="${s.key}">${S.people.map((p, j) => `<option value="${esc(p.id)}" ${i === j ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="">Παράλειψη</option></select></label>`).join('')}</div>
    <div class="row-actions"><button class="btn btn-primary" type="button" data-action="v1-import">Εισαγωγή</button>
      <button class="btn btn-ghost" type="button" data-action="v1-dismiss">Όχι, ευχαριστώ</button></div>
  </section>`;
}
async function importV1() {
  const slots = detectV1() || [];
  let rows = [], skipped = 0;
  const allowances = [];
  for (const s of slots) {
    const pid = $(`[data-v1="${s.key}"]`)?.value;
    if (!pid) continue;
    const r = convertV1(s, pid, newId);
    rows = rows.concat(r.rows); skipped += r.skipped;
    if (s.totalDays > 0 && !allowanceOf(pid, curYear())) allowances.push({ person_id: pid, year: curYear(), total_days: Number(s.totalDays), carried_over: 0 });
  }
  const ok = await mutate(async () => {
    if (rows.length) await S.store.saveLeaves(rows);
    for (const a of allowances) await S.store.saveAllowance(a);
    localStorage.setItem(V1_FLAG, '1');
  }, `Μεταφέρθηκαν ${rows.length} άδειες${skipped ? ` (${skipped} χωρίς ημερομηνίες παραλείφθηκαν)` : ''}.`);
  return ok;
}

// ── Sheet (dialog) ───────────────────────────────────────────
const sheet = $('#sheet');
let sheetDirty = false, downOnBackdrop = false;
sheet.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === sheet; });
sheet.addEventListener('click', (e) => {
  if (e.target !== sheet || !downOnBackdrop) return;
  if (sheetDirty) {
    const f = sheet.querySelector('.sheet-form');
    f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
    return;
  }
  sheet.close();
});
sheet.addEventListener('input', () => { sheetDirty = true; });
sheet.addEventListener('close', () => { sheet.innerHTML = ''; sheetDirty = false; });
function openSheet(title, body, { onSubmit, foot, onMount }) {
  sheet.innerHTML = `<form class="sheet-form" novalidate>
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2>
      <button class="icon-btn" type="button" data-close aria-label="Κλείσιμο">${icon.close}</button></div>
    ${body}
    <div class="sheet-foot">${foot ?? '<button class="btn btn-primary" type="submit">Αποθήκευση</button>'}</div>
  </form>`;
  sheetDirty = false;
  const form = sheet.querySelector('form');
  form.querySelector('[data-close]').onclick = () => sheet.close();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const done = await onSubmit?.(form);
      if (done !== false) sheet.close();
    } finally { if (btn && sheet.open) btn.disabled = false; }
  });
  if (!sheet.open) sheet.showModal();
  onMount?.(form);
}

// chips helpers inside sheets
function chipGroup(name, options, value, { label }) {
  return `<div class="field"><span class="label" id="lbl-${name}">${esc(label)}</span>
    <div class="chips" role="radiogroup" aria-labelledby="lbl-${name}">${options.map((o) =>
      `<button type="button" class="chip" role="radio" data-group="${name}" data-value="${esc(o.value)}" aria-checked="${o.value === value}" ${o.color ? `style="--c:${safeColor(o.color)}"` : ''}>${o.color ? '<span class="dot"></span>' : ''}${esc(o.label)}</button>`).join('')}
    </div></div>`;
}
function wireChips(form, name, onChange) {
  form.querySelectorAll(`[data-group="${name}"]`).forEach((b) => {
    b.addEventListener('click', () => {
      form.querySelectorAll(`[data-group="${name}"]`).forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      sheetDirty = true;
      onChange(b.dataset.value);
    });
  });
}

function openLeaveSheet({ leave = null, preset = {} } = {}) {
  const editing = !!leave;
  const st = {
    type: leave?.type || preset.type || 'annual',
    who: leave ? leave.person_id : preset.who || S.personId || S.me.id,
    start: leave?.start_date || preset.start || '',
    end: leave?.end_date || preset.end || preset.start || '',
    half: !!leave?.half_day,
  };
  const whoOpts = S.people.map((p) => ({ value: p.id, label: p.name, color: p.color }));
  if (!editing && S.people.length > 1) whoOpts.push({ value: 'both', label: 'Και οι δύο' });
  const body = `
    <label class="field"><span>Τίτλος</span>
      <input name="title" type="text" maxlength="80" placeholder="${esc(TYPES[st.type].title)}" value="${esc(leave?.title || preset.title || '')}" autocomplete="off" enterkeyhint="done" /></label>
    ${chipGroup('who', whoOpts, st.who, { label: 'Για' })}
    ${chipGroup('type', Object.entries(TYPES).map(([k, v]) => ({ value: k, label: v.label })), st.type, { label: 'Είδος' })}
    <div class="field-row">
      <label class="field"><span>Από</span><input name="start" type="date" value="${st.start}" required /></label>
      <label class="field"><span>Έως</span><input name="end" type="date" value="${st.end}" min="${st.start}" required /></label>
    </div>
    <label class="switch-row" id="half-row"><span>Μισή μέρα</span><span class="switch"><input type="checkbox" name="half" ${st.half ? 'checked' : ''} /><span></span></span></label>
    <div class="calc" id="calc" aria-live="polite"></div>
    <div id="warns" style="display:grid;gap:8px"></div>
    <details class="block" ${leave?.note ? 'open' : ''}><summary>Σημείωση ${icon.chev}</summary>
      <label class="field"><span class="visually-hidden">Σημείωση</span><textarea name="note" maxlength="500" rows="2">${esc(leave?.note || '')}</textarea></label></details>
    <p class="form-error" id="leave-error" role="alert" hidden></p>`;
  const foot = `${editing ? `<button class="btn btn-danger" type="button" data-del>${icon.trash}Διαγραφή</button>` : ''}
    <button class="btn btn-primary" type="submit">${editing ? 'Αποθήκευση' : 'Προσθήκη'}</button>`;

  const targets = () => (st.who === 'both' ? S.people.map((p) => p.id) : [st.who]);
  function update(form) {
    const s = form.start.value, e = form.end.value;
    form.end.min = s || '';
    const single = s && e && s === e;
    form.half.disabled = !single;
    if (!single) form.half.checked = false;
    $('#half-row', form).style.opacity = single ? '1' : '.45';
    const calc = $('#calc', form), warns = $('#warns', form);
    if (!isValidISO(s) || !isValidISO(e) || e < s) {
      calc.innerHTML = `<b>–</b><p>${s && e && e < s ? '<strong>Η λήξη είναι πριν την έναρξη.</strong>' : 'Διάλεξε ημερομηνίες.'}</p>`;
      warns.innerHTML = '';
      return;
    }
    const half = form.half.checked;
    const per = targets().map((pid) => {
      const p = person(pid);
      return { p, br: leaveBreakdown(s, e, half, p, S.cal) };
    });
    const br = per[0].br;
    const offTxt = [br.off ? `${br.off} ${br.off === 1 ? 'μέρα' : 'μέρες'} Σ/Κ` : '', ...br.holidays.map((h) => h.name)].filter(Boolean).join(', ');
    const sameForAll = per.every((x) => x.br.work === br.work);
    calc.innerHTML = sameForAll
      ? `<b>${n2s(br.work)}</b><p><strong>${workWord(br.work)} ${st.type === 'annual' ? 'από την άδεια' : ''}</strong><br>${br.total} ${br.total === 1 ? 'μέρα' : 'ημερολογιακές'}${offTxt ? ` · εκτός: ${esc(offTxt)}` : ''}</p>`
      : `<b>${per.map((x) => n2s(x.br.work)).join('/')}</b><p><strong>${per.map((x) => `${esc(x.p.name)} ${n2s(x.br.work)}`).join(' · ')}</strong><br>διαφορετικές εργάσιμες/αργίες</p>`;
    const w = [];
    for (const { p } of per) {
      const ov = overlappingLeaves(p.id, s, e, S.leaves, leave?.id);
      if (ov.length) w.push(`${esc(p.name)}: επικαλύπτεται με «${esc(ov[0].title)}» (${esc(fmtRange(ov[0].start_date, ov[0].end_date))}).`);
      if (st.type === 'annual') {
        for (let y = Number(s.slice(0, 4)); y <= Number(e.slice(0, 4)); y++) {
          const a = allowanceOf(p.id, y);
          if (!a) continue;
          const others = S.leaves.filter((l) => l.id !== leave?.id);
          const u = yearUsage(p, others, S.cal, y, S.today, a);
          const add = leaveDays({ start_date: s, end_date: e, half_day: half }, p, S.cal, yearBounds(y));
          if (u.left - add < 0) w.push(`${esc(p.name)}: ξεπερνά το όριο του ${y} κατά ${n2s(add - u.left)}.`);
        }
      }
      if (br.work === 0 && per.length === 1) w.push('Δεν περιλαμβάνει καμία εργάσιμη μέρα.');
    }
    warns.innerHTML = w.map((x) => `<div class="warn">${x}</div>`).join('');
  }

  openSheet(editing ? 'Επεξεργασία άδειας' : 'Νέα άδεια', body, {
    foot,
    onMount(form) {
      wireChips(form, 'who', (v) => { st.who = v; update(form); });
      wireChips(form, 'type', (v) => { st.type = v; form.title.placeholder = TYPES[v].title; update(form); });
      form.start.addEventListener('change', () => {
        if (form.start.value && (!form.end.value || form.end.value < form.start.value)) form.end.value = form.start.value;
        update(form);
      });
      form.end.addEventListener('change', () => update(form));
      form.half.addEventListener('change', () => update(form));
      form.querySelector('[data-del]')?.addEventListener('click', async () => {
        sheet.close();
        const backup = { ...leave };
        await mutate(() => S.store.deleteLeave(leave.id), 'Η άδεια διαγράφηκε', {
          action: { label: 'Αναίρεση', fn: () => mutate(() => S.store.saveLeaves([backup]), 'Επανήλθε') },
        });
      });
      update(form);
      if (!editing && !st.start) setTimeout(() => form.title.focus(), 80);
    },
    async onSubmit(form) {
      const err = $('#leave-error', form);
      const s = form.start.value, e = form.end.value;
      const show = (m) => { err.textContent = m; err.hidden = false; return false; };
      if (!isValidISO(s) || !isValidISO(e)) return show('Συμπλήρωσε ημερομηνίες έναρξης και λήξης.');
      if (e < s) return show('Η λήξη πρέπει να είναι μετά την έναρξη.');
      if (daysBetween(s, e) > 366) return show('Μέγιστη διάρκεια ένας χρόνος.');
      const title = (form.title.value.trim() || TYPES[st.type].title).slice(0, 80);
      const half = form.half.checked && s === e;
      const note = form.note.value.trim() || null;
      const rows = targets().map((pid) => ({
        id: editing ? leave.id : newId(), person_id: pid, type: st.type, title,
        start_date: s, end_date: e, half_day: half, note,
      }));
      const ok = await mutate(() => S.store.saveLeaves(rows),
        editing ? 'Αποθηκεύτηκε' : rows.length > 1 ? 'Προστέθηκε και για τους δύο' : 'Η άδεια προστέθηκε',
        editing ? undefined : { action: { label: 'Αναίρεση', fn: () => mutate(async () => { for (const r of rows) await S.store.deleteLeave(r.id); }, 'Αναιρέθηκε') } });
      if (ok && !editing) {
        S.year = Number(s.slice(0, 4));
        if (S.tab === 'leaves' && rows.length === 1) S.personId = rows[0].person_id;
        render();
      }
      return ok;
    },
  });
}

function openAllowanceSheet(pid) {
  const p = person(pid);
  const a = allowanceOf(pid, S.year);
  const prev = allowanceOf(pid, S.year - 1);
  const sugg = suggestedCarry(p, S.leaves, S.cal, S.year, S.allowances);
  const body = `
    <p style="color:var(--muted);font-size:14px">${isMe(p) ? 'Οι μέρες σου' : `Οι μέρες του/της ${esc(p.name)}`} για το ${S.year}. Μετράνε μόνο εργάσιμες (5νθήμερο: συνήθως 20–26, 6ήμερο: 24–31).</p>
    <div class="field-row">
      <label class="field"><span>Μέρες ${S.year}</span><input name="total" type="number" inputmode="decimal" min="0" max="366" step="0.5" value="${a ? a.total_days : prev ? prev.total_days : ''}" required /></label>
      <label class="field"><span>Μεταφορά από ${S.year - 1}</span><input name="carry" type="number" inputmode="decimal" min="0" max="366" step="0.5" value="${a ? a.carried_over : ''}" placeholder="0" /></label>
    </div>
    ${prev ? `<button class="btn btn-small" type="button" data-auto style="justify-self:start">Υπόλοιπο ${S.year - 1}: ${n2s(sugg)} → μεταφορά</button>` : ''}
    <p class="form-error" id="al-error" role="alert" hidden></p>`;
  openSheet(`Άδεια ${S.year} · ${p.name}`, body, {
    onMount(form) {
      form.querySelector('[data-auto]')?.addEventListener('click', () => { form.carry.value = sugg; sheetDirty = true; });
      setTimeout(() => form.total.focus(), 80);
    },
    async onSubmit(form) {
      const total = Number(form.total.value), carry = Number(form.carry.value || 0);
      const err = $('#al-error', form);
      if (form.total.value === '' || !Number.isFinite(total) || total < 0 || total > 366 || !Number.isFinite(carry) || carry < 0 || carry > 366) {
        err.textContent = 'Βάλε αριθμό από 0 έως 366.'; err.hidden = false; return false;
      }
      const round = (x) => Math.round(x * 2) / 2;
      return mutate(() => S.store.saveAllowance({ person_id: pid, year: S.year, total_days: round(total), carried_over: round(carry) }), 'Αποθηκεύτηκε');
    },
  });
}

function openDaySheet(iso) {
  const info = dayInfo(iso);
  const rows = info.rows.map(({ p, leaves, work, hol }) => {
    const status = leaves.length ? leaves.map((l) => `${esc(l.title)}${l.type !== 'annual' ? ` (${esc(TYPE_LABELS[l.type])})` : ''}${l.half_day ? ' · μισή μέρα' : ''}`).join(', ')
      : hol.length ? 'αργία' : work ? 'δουλεύει' : 'ρεπό';
    return `<div class="leave" style="${pStyle(p)};grid-template-columns:4px 1fr" ${leaves[0] ? `data-day-leave="${esc(leaves[0].id)}" role="button" tabindex="0"` : ''}>
      <span class="bar ${leaves[0] ? `t-${esc(leaves[0].type)}` : ''}" ${leaves.length ? '' : 'style="background:var(--line)"'}></span>
      <span><span class="t">${esc(p.name)}</span><span class="d">${status}</span></span></div>`;
  }).join('');
  openSheet(F.long.format(dateOf(iso)), `
    ${info.hol.length ? `<p style="color:var(--holiday);font-weight:600">${info.hol.map(esc).join(' · ')}</p>` : ''}
    <div class="day-people">${rows}</div>`, {
    foot: '<button class="btn btn-primary" type="button" data-new>+ Νέα άδεια από εδώ</button>',
    onMount(form) {
      form.querySelector('[data-new]').onclick = () => openLeaveSheet({ preset: { start: iso, end: iso } });
      form.querySelectorAll('[data-day-leave]').forEach((el) => {
        const open = () => { const l = S.leaves.find((x) => x.id === el.dataset.dayLeave); if (l) openLeaveSheet({ leave: l }); };
        el.addEventListener('click', open);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    },
  });
}

function openExtraSheet() {
  const body = `
    <label class="field"><span>Όνομα</span><input name="name" type="text" maxlength="60" placeholder="π.χ. Αγίου Δημητρίου" required autocomplete="off" /></label>
    <label class="field"><span>Ημερομηνία</span><input name="date" type="date" required /></label>
    ${chipGroup('xwho', [{ value: '', label: 'Και οι δύο' }, ...S.people.map((p) => ({ value: p.id, label: p.name, color: p.color }))], '', { label: 'Για' })}
    <label class="switch-row"><span>Κάθε χρόνο</span><span class="switch"><input type="checkbox" name="yearly" checked /><span></span></span></label>
    <p class="form-error" id="x-error" role="alert" hidden></p>`;
  let who = '';
  openSheet('Επιπλέον αργία', body, {
    onMount(form) { wireChips(form, 'xwho', (v) => { who = v; }); setTimeout(() => form.name.focus(), 80); },
    async onSubmit(form) {
      const name = form.name.value.trim(), date = form.date.value;
      const err = $('#x-error', form);
      if (!name || !isValidISO(date)) { err.textContent = 'Συμπλήρωσε όνομα και ημερομηνία.'; err.hidden = false; return false; }
      return mutate(() => S.store.saveExtra({ id: newId(), person_id: who || null, date, name: name.slice(0, 60), yearly: form.yearly.checked }), 'Η αργία προστέθηκε');
    },
  });
}

// ── Exports ──────────────────────────────────────────────────
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Events ───────────────────────────────────────────────────
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return go(tabBtn.dataset.tab);
  const el = e.target.closest('[data-action]');
  if (!el || sheet.contains(el)) return;
  const { action, id } = el.dataset;
  switch (action) {
    case 'year': {
      const d = Number(el.dataset.delta);
      if (S.tab === 'calendar') { S.month = { y: S.month.y + d, m: S.month.m }; S.year = S.month.y; }
      else { S.year = Math.min(2100, Math.max(2000, S.year + d)); S.month = { y: S.year, m: S.month.m }; }
      return render();
    }
    case 'person': S.personId = id; return render();
    case 'person-go': S.personId = id; return go('leaves');
    case 'new-leave': return openLeaveSheet({ preset: { who: S.tab === 'leaves' ? S.personId : S.me.id } });
    case 'edit-leave': { const l = S.leaves.find((x) => x.id === id); return l && openLeaveSheet({ leave: l }); }
    case 'allowance': return openAllowanceSheet(id);
    case 'book-bridge': {
      const who = el.dataset.who.split(',');
      return openLeaveSheet({ preset: { start: el.dataset.start, end: el.dataset.end, title: `Γέφυρα · ${el.dataset.holiday}`, who: who.length > 1 ? 'both' : who[0] } });
    }
    case 'toggle-open': { const k = el.dataset.key; S.open.has(k) ? S.open.delete(k) : S.open.add(k); return render(); }
    case 'day': return openDaySheet(el.dataset.date);
    case 'cal-month': {
      let { y, m } = S.month; m += Number(el.dataset.delta);
      if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
      S.month = { y, m }; S.year = y; return render();
    }
    case 'cal-today': S.month = { y: curYear(), m: Number(S.today.slice(5, 7)) - 1 }; S.year = curYear(); return render();
    case 'person-color': return mutate(() => S.store.updatePerson(id, { color: el.dataset.color }));
    case 'person-wd': {
      const p = person(id), d = Number(el.dataset.day);
      const wd = p.work_days.includes(d) ? p.work_days.filter((x) => x !== d) : [...p.work_days, d].sort();
      if (!wd.length) return toast('Χρειάζεται τουλάχιστον μία εργάσιμη μέρα.', { error: true });
      return mutate(() => S.store.updatePerson(id, { work_days: wd }));
    }
    case 'extra-new': return openExtraSheet();
    case 'extra-del': {
      const x = S.extras.find((y) => y.id === id);
      return x && mutate(() => S.store.deleteExtra(id), 'Η αργία διαγράφηκε', { action: { label: 'Αναίρεση', fn: () => mutate(() => S.store.saveExtra(x)) } });
    }
    case 'export-ics': {
      const byId = Object.fromEntries(S.people.map((p) => [p.id, p]));
      return download('adeies.ics', buildICS(S.leaves, byId, TYPE_LABELS), 'text/calendar;charset=utf-8');
    }
    case 'export-json':
      return download(`adeies-backup-${S.today}.json`, JSON.stringify({ exported: new Date().toISOString(), people: S.people, allowances: S.allowances, leaves: S.leaves, extras: S.extras }, null, 2), 'application/json');
    case 'v1-import': return importV1();
    case 'v1-dismiss': try { localStorage.setItem(V1_FLAG, 'dismissed'); } catch { /* ignore */ } return render();
    case 'sign-out': return signOut();
    case 'reset-demo': S.store.resetDemo?.(); return refresh();
    default:
  }
});

// settings inputs that save on change
document.addEventListener('change', (e) => {
  const t = e.target;
  if (sheet.contains(t)) return;
  if (t.dataset.personName) {
    const name = t.value.trim().slice(0, 40);
    const p = person(t.dataset.personName);
    if (!name) { t.value = p.name; return toast('Το όνομα δεν μπορεί να είναι κενό.', { error: true }); }
    if (name !== p.name) mutate(() => S.store.updatePerson(p.id, { name }), 'Αποθηκεύτηκε');
  } else if (t.dataset.personHol) {
    const p = person(t.dataset.personHol), key = t.dataset.key;
    const skip = t.checked ? p.skip_holidays.filter((k) => k !== key) : [...new Set([...p.skip_holidays, key])];
    mutate(() => S.store.updatePerson(p.id, { skip_holidays: skip }));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset?.personName) e.target.blur();
});
// remember which <details> are open across re-renders
document.addEventListener('toggle', (e) => {
  const k = e.target.dataset?.key;
  if (!k || sheet.contains(e.target)) return;
  if (e.target.open) S.open.add(k); else S.open.delete(k);
}, true);

boot();
