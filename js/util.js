// Small shared helpers: DOM, time formatting, caching, geometry.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => Math.random().toString(36).slice(2, 10);
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A Date on the same calendar day as `base`, at "HH:MM". */
export function atTime(base, hm) {
  const [h, m] = String(hm || '00:00').split(':').map(Number);
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}
export const addMin = (d, m) => new Date(d.getTime() + m * 60000);
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const minsBetween = (a, b) => (b - a) / 60000;

export const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${pad(m)}m` : `${h}h`;
}

/** Human countdown from now until `d`. */
export function fmtUntil(d, now = new Date()) {
  const m = Math.round(minsBetween(now, d));
  if (m === 0) return 'now';
  return m > 0 ? `in ${fmtDur(m)}` : `${fmtDur(-m)} ago`;
}

export function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const hasCoords = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon) && p.lat !== null && p.lat !== '';

/** Promise cache with TTL; failed promises are evicted so they retry. */
export function memo(ttlMs) {
  const m = new Map();
  return (key, fn) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.t < ttlMs) return hit.p;
    const p = Promise.resolve().then(fn);
    m.set(key, { t: Date.now(), p });
    p.catch(() => m.delete(key));
    return p;
  };
}

export async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error?.message || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return j;
  } finally {
    clearTimeout(t);
  }
}
