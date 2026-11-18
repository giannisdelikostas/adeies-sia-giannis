// Vercel Cron calls this once a day (see vercel.json) so the free Supabase
// project never counts as "inactive" and doesn't get paused.
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

export default async function handler(req, res) {
  const url = process.env.SUPABASE_URL || SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || SUPABASE_KEY;
  if (!url || !key) return res.status(200).json({ ok: true, skipped: 'no Supabase config' });
  try {
    const r = await fetch(`${url}/rest/v1/rpc/ping`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
}
