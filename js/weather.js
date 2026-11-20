// Weather from Open-Meteo (free, no key needed).
import { memo, fetchJson } from './util.js';

const cache = memo(15 * 60e3);

const WMO = {
  0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Overcast'],
  45: ['🌫️', 'Fog'], 48: ['🌫️', 'Freezing fog'],
  51: ['🌦️', 'Light drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Heavy drizzle'],
  56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'],
  61: ['🌦️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'],
  66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'],
  71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'],
  80: ['🌦️', 'Showers'], 81: ['🌧️', 'Heavy showers'], 82: ['⛈️', 'Violent showers'],
  85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Heavy snow showers'],
  95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm, hail'], 99: ['⛈️', 'Severe thunderstorm'],
};

export function wx(code, isDay = 1) {
  const [icon, label] = WMO[code] || ['🌡️', 'Unknown'];
  if (!isDay && code <= 1) return { icon: '🌙', label };
  return { icon, label };
}

export const isStorm = (code) => code >= 95;

export function getWeather(loc) {
  const lat = (+loc.lat).toFixed(3), lon = (+loc.lon).toFixed(3);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m,is_day` +
    `&hourly=temperature_2m,precipitation_probability,precipitation,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max` +
    `&timezone=auto&forecast_days=2`;
  return cache(`${lat},${lon}`, async () => normalize(await fetchJson(url)));
}

function normalize(j) {
  const h = j.hourly, d = j.daily;
  const hours = h.time.map((t, i) => ({
    t: new Date(t), temp: h.temperature_2m[i], pop: h.precipitation_probability?.[i] ?? 0,
    precip: h.precipitation?.[i] ?? 0, code: h.weather_code[i],
  }));
  const day = (i) => d && d.time[i] ? {
    code: d.weather_code[i], max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
    pop: d.precipitation_probability_max?.[i] ?? 0, uv: d.uv_index_max?.[i] ?? 0,
  } : null;
  const c = j.current;
  return {
    current: { temp: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, wind: c.wind_speed_10m, isDay: c.is_day },
    today: day(0), tomorrow: day(1), hours,
  };
}

/** Rain/storm summary for the hours overlapping [from, to]. */
export function windowSummary(w, from, to) {
  const a = new Date(from); a.setMinutes(0, 0, 0);
  const hrs = w.hours.filter((h) => h.t >= a && h.t <= to);
  if (!hrs.length) return null;
  return {
    pop: Math.max(...hrs.map((h) => h.pop)),
    precip: hrs.reduce((s, h) => s + h.precip, 0),
    storm: hrs.some((h) => isStorm(h.code)),
    temp: hrs[0].temp,
    code: hrs.reduce((a, h) => (h.code > a ? h.code : a), 0),
  };
}

/** Multiplier applied to estimated driving time when the weather is bad. */
export function trafficWeatherFactor(w, from, to) {
  const s = w && windowSummary(w, from, to);
  if (!s) return 1;
  if (s.storm || s.precip >= 3) return 1.2;
  if (s.pop >= 60 || s.precip >= 1) return 1.1;
  return 1;
}

/** Practical, parent-oriented tips for the day. windows: [{label, from, to}] */
export function advice(w, windows, dayKey = 'today') {
  const tips = [];
  for (const win of windows) {
    const s = windowSummary(w, win.from, win.to);
    if (!s) continue;
    if (s.storm) tips.push({ icon: '⛈️', text: `Thunderstorms likely around ${win.label} — allow extra time`, level: 'bad' });
    else if (s.pop >= 50) tips.push({ icon: '☂️', text: `Rain likely during ${win.label} (${s.pop}%) — take umbrellas`, level: 'warn' });
    else if (s.pop >= 30) tips.push({ icon: '🌂', text: `Chance of showers during ${win.label} (${s.pop}%)`, level: 'info' });
  }
  const d = w[dayKey];
  if (d) {
    if (d.max >= 33) tips.push({ icon: '🥤', text: `Hot day (up to ${Math.round(d.max)}°) — water bottles for the kids`, level: 'warn' });
    if (d.min <= 6) tips.push({ icon: '🧥', text: `Cold (down to ${Math.round(d.min)}°) — jackets for everyone`, level: 'warn' });
    if (d.uv >= 8) tips.push({ icon: '🧴', text: `UV very high (${Math.round(d.uv)}) — sunscreen & hats`, level: 'warn' });
    else if (d.uv >= 6) tips.push({ icon: '🧢', text: `UV high (${Math.round(d.uv)}) — hats for outdoor play`, level: 'info' });
  }
  return tips;
}
