// Data layer. Same interface for Supabase (real) and Demo (localStorage) modes.
import { addDays, todayISO } from './lib.js';

const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export async function createStore({ SUPABASE_URL, SUPABASE_KEY }) {
  const demo = new URLSearchParams(location.search).has('demo');
  if (demo || !SUPABASE_URL || !SUPABASE_KEY) return createDemoStore();
  return createSupabaseStore(SUPABASE_URL, SUPABASE_KEY);
}

export const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// ── Supabase ────────────────────────────────────────────────
async function createSupabaseStore(url, key) {
  const { createClient } = await import(SUPABASE_CDN);
  const sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  const ok = ({ data, error }) => {
    if (error) throw new Error(translateError(error.message));
    return data;
  };
  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(translateError(error.message));
      return data.user;
    },
    async signOut() { await sb.auth.signOut(); },
    onAuth(cb) {
      // never await Supabase calls inside this callback (known deadlock) — defer instead
      sb.auth.onAuthStateChange((_evt, session) => setTimeout(() => cb(session?.user ?? null), 0));
    },
    async loadAll() {
      const [p, a, l, x] = await Promise.all([
        sb.from('people').select('*').order('sort'),
        sb.from('allowances').select('*'),
        sb.from('leaves').select('*').order('start_date'),
        sb.from('extra_holidays').select('*').order('date'),
      ]);
      return { people: ok(p), allowances: ok(a), leaves: ok(l), extras: ok(x) };
    },
    async saveLeaves(rows) { ok(await sb.from('leaves').upsert(rows)); },
    async deleteLeave(id) { ok(await sb.from('leaves').delete().eq('id', id)); },
    async saveAllowance(row) { ok(await sb.from('allowances').upsert(row)); },
    async updatePerson(id, patch) { ok(await sb.from('people').update(patch).eq('id', id)); },
    async saveExtra(row) { ok(await sb.from('extra_holidays').upsert(row)); },
    async deleteExtra(id) { ok(await sb.from('extra_holidays').delete().eq('id', id)); },
    subscribe(cb) {
      const ch = sb
        .channel('adeies-sync')
        .on('postgres_changes', { event: '*', schema: 'public' }, () => cb())
        .subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

function translateError(msg = '') {
  if (/Invalid login credentials/i.test(msg)) return 'Λάθος e-mail ή κωδικός.';
  if (/Email not confirmed/i.test(msg)) return 'Το e-mail δεν έχει επιβεβαιωθεί (Supabase → Users → Confirm).';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg))
    return 'Δεν υπάρχει σύνδεση με τη βάση. Έλεγξε το internet — ή μήπως το Supabase project είναι σε παύση;';
  if (/row-level security/i.test(msg)) return 'Δεν έχεις δικαίωμα γι’ αυτό (ο λογαριασμός δεν είναι στη λίστα).';
  if (/leaves_dates_ok/.test(msg)) return 'Η λήξη πρέπει να είναι μετά την έναρξη.';
  return msg || 'Κάτι πήγε στραβά.';
}

// ── Demo (localStorage) ─────────────────────────────────────
const DEMO_KEY = 'adeies-demo-v2';

function demoSeed() {
  const t = todayISO();
  const y = Number(t.slice(0, 4));
  const a = newId(), b = newId();
  const L = (person_id, title, s, e, type = 'annual', half_day = false) =>
    ({ id: newId(), person_id, type, title, start_date: s, end_date: e, half_day, note: null });
  return {
    people: [
      { id: a, email: 'demo@adeies.local', name: 'Γιάννης', color: '#0f766e', work_days: [1, 2, 3, 4, 5], skip_holidays: [], sort: 0 },
      { id: b, email: 'moraki@adeies.local', name: 'Μωράκι', color: '#d9573b', work_days: [1, 2, 3, 4, 5], skip_holidays: ['whit_monday'], sort: 1 },
    ],
    allowances: [
      { person_id: a, year: y, total_days: 22, carried_over: 2 },
      { person_id: b, year: y, total_days: 24, carried_over: 0 },
    ],
    leaves: [
      L(a, 'Καλοκαίρι στη Χαλκιδική', `${y}-08-10`, `${y}-08-21`),
      L(b, 'Καλοκαίρι στη Χαλκιδική', `${y}-08-10`, `${y}-08-21`),
      L(a, 'Ίωση', `${y}-02-16`, `${y}-02-17`, 'sick'),
      L(b, 'Οδοντίατρος', `${y}-03-04`, `${y}-03-04`, 'annual', true),
      L(a, 'Μετακόμιση', `${y}-05-14`, `${y}-05-15`),
      L(b, 'Σεμινάριο', `${y}-06-08`, `${y}-06-09`, 'special'),
      L(a, 'Ρεπό', addDays(t, 9), addDays(t, 10)),
      L(b, 'Χριστούγεννα στο χωριό', `${y}-12-21`, `${y}-12-31`),
      L(a, 'Χριστούγεννα στο χωριό', `${y}-12-23`, `${y}-12-31`),
    ],
    extras: [{ id: newId(), person_id: null, date: `${y}-10-26`, name: 'Αγίου Δημητρίου', yearly: true }],
  };
}

function createDemoStore() {
  const read = () => {
    try { const raw = localStorage.getItem(DEMO_KEY); if (raw) return JSON.parse(raw); } catch { /* ignore */ }
    const s = demoSeed(); write(s); return s;
  };
  const write = (s) => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
  const mutate = (fn) => { const s = read(); fn(s); write(s); };
  const upsert = (arr, row, key = (r) => r.id) => {
    const i = arr.findIndex((r) => key(r) === key(row));
    if (i >= 0) arr[i] = { ...arr[i], ...row }; else arr.push(row);
  };
  let user = null;
  try { user = sessionStorage.getItem('adeies-demo-user') ? { email: 'demo@adeies.local' } : null; } catch { /* ignore */ }
  return {
    mode: 'demo',
    async getUser() { return user; },
    async signIn() {
      user = { email: 'demo@adeies.local' };
      try { sessionStorage.setItem('adeies-demo-user', '1'); } catch { /* ignore */ }
      return user;
    },
    async signOut() {
      user = null;
      try { sessionStorage.removeItem('adeies-demo-user'); } catch { /* ignore */ }
    },
    onAuth() {},
    async loadAll() { return structuredClone(read()); },
    async saveLeaves(rows) { mutate((s) => rows.forEach((r) => upsert(s.leaves, r))); },
    async deleteLeave(id) { mutate((s) => { s.leaves = s.leaves.filter((l) => l.id !== id); }); },
    async saveAllowance(row) { mutate((s) => upsert(s.allowances, row, (r) => `${r.person_id}:${r.year}`)); },
    async updatePerson(id, patch) { mutate((s) => upsert(s.people, { id, ...patch })); },
    async saveExtra(row) { mutate((s) => upsert(s.extras, row)); },
    async deleteExtra(id) { mutate((s) => { s.extras = s.extras.filter((x) => x.id !== id); }); },
    subscribe(cb) {
      const h = (e) => { if (e.key === DEMO_KEY) cb(); };
      addEventListener('storage', h);
      return () => removeEventListener('storage', h);
    },
    resetDemo() { try { localStorage.removeItem(DEMO_KEY); } catch { /* ignore */ } },
  };
}
