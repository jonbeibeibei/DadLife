// Commute options: drive, taxi, public transport (bus/train) and taxi+train combos.
//
// Live mode  (Google Maps key set): Google Routes API — real traffic + real bus/train timetables.
// Free mode  (no key):              OSRM road routing + a time-of-day traffic model + rough
//                                   public-transport estimate. Everything is labelled "estimate".
import { memo, fetchJson, haversineKm, addMin, minsBetween, fmtDur } from './util.js';

const googleCache = memo(5 * 60e3);
const osrmCache = memo(6 * 60 * 60e3);
let lastGoogleError = null;
export const googleError = () => lastGoogleError;

// ---------------------------------------------------------------- traffic model

/** Typical congestion multiplier for a departure time (used when no live traffic). */
export function trafficFactor(d) {
  const day = d.getDay(), h = d.getHours() + d.getMinutes() / 60;
  const bump = (c, w, amp) => amp * Math.exp(-((h - c) ** 2) / (2 * w * w));
  if (day === 0 || day === 6) return 1.05 + bump(13, 2.5, 0.12);
  return 1.04 + bump(8.2, 0.9, 0.5) + bump(18.1, 1.1, 0.55) + bump(12.75, 0.9, 0.1);
}

export function trafficLevel(ratio) {
  if (ratio < 1.12) return { key: 'light', label: 'Light traffic' };
  if (ratio < 1.35) return { key: 'moderate', label: 'Moderate traffic' };
  return { key: 'heavy', label: 'Heavy traffic' };
}

// ---------------------------------------------------------------- links

const ll = (p) => `${p.lat},${p.lon}`;
export const mapsUrl = (a, b, mode) =>
  `https://www.google.com/maps/dir/?api=1&origin=${ll(a)}&destination=${ll(b)}&travelmode=${mode}`;
const rideUrl = (a, b) =>
  `https://m.uber.com/ul/?action=setPickup&pickup[latitude]=${a.lat}&pickup[longitude]=${a.lon}` +
  `&dropoff[latitude]=${b.lat}&dropoff[longitude]=${b.lon}`;

function taxiFare(t, km, min) {
  const v = t.flag + t.perKm * km + t.perMin * min;
  const lo = Math.round(v * 0.9), hi = Math.round(v * 1.15);
  return `${t.currency}${lo}–${hi}`;
}

// ---------------------------------------------------------------- providers

async function freeFlow(a, b) {
  const key = `${(+a.lat).toFixed(4)},${(+a.lon).toFixed(4)}>${(+b.lat).toFixed(4)},${(+b.lon).toFixed(4)}`;
  return osrmCache(key, async () => {
    try {
      const j = await fetchJson(
        `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`, {}, 9000);
      if (j.code !== 'Ok' || !j.routes?.length) throw new Error('no route');
      // OSRM free-flow speeds are optimistic in cities; nudge them up a little.
      return { min: (j.routes[0].duration / 60) * 1.12 + 2, km: j.routes[0].distance / 1000 };
    } catch {
      const km = haversineKm(a, b) * 1.35;
      return { min: (km / 38) * 60 + 4, km };
    }
  });
}

const gSecs = (s) => (s ? parseFloat(String(s)) / 60 : 0);
const latLng = (p) => ({ location: { latLng: { latitude: +p.lat, longitude: +p.lon } } });
const roundTime = (d) => Math.round(d.getTime() / 300e3); // 5-min buckets for caching

async function googleRoutes(key, body, mask) {
  try {
    const j = await fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
      body: JSON.stringify(body),
    });
    lastGoogleError = null;
    return j.routes || [];
  } catch (e) {
    lastGoogleError = e.message;
    throw e;
  }
}

/** Live driving time departing at `when` (Google). */
function gDrive(key, a, b, when) {
  const t = new Date(Math.max(when.getTime(), Date.now() + 60e3));
  const ck = `D${ll(a)}>${ll(b)}@${roundTime(t)}`;
  return googleCache(ck, async () => {
    const routes = await googleRoutes(key, {
      origin: latLng(a), destination: latLng(b), travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE', departureTime: t.toISOString(),
    }, 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description');
    if (!routes.length) throw new Error('No driving route found');
    const r = routes[0];
    return { min: gSecs(r.duration), typical: gSecs(r.staticDuration) || gSecs(r.duration), km: r.distanceMeters / 1000, via: r.description || '' };
  });
}

const VEHICLE = {
  BUS: ['bus', '🚌'], INTERCITY_BUS: ['bus', '🚌'], TROLLEYBUS: ['bus', '🚌'], SHARE_TAXI: ['bus', '🚐'],
  SUBWAY: ['train', '🚇'], METRO_RAIL: ['train', '🚇'], MONORAIL: ['train', '🚝'], TRAM: ['train', '🚊'],
  HEAVY_RAIL: ['train', '🚆'], COMMUTER_TRAIN: ['train', '🚆'], RAIL: ['train', '🚆'],
  HIGH_SPEED_TRAIN: ['train', '🚄'], LONG_DISTANCE_TRAIN: ['train', '🚆'], FERRY: ['ferry', '⛴️'],
  CABLE_CAR: ['train', '🚡'], GONDOLA_LIFT: ['train', '🚡'], FUNICULAR: ['train', '🚞'],
};

/** Live public-transport routes (Google). */
function gTransit(key, a, b, { arriveBy, departAt }) {
  const now = Date.now() + 60e3;
  const useArrive = arriveBy && arriveBy.getTime() > now + 10 * 60e3;
  const when = useArrive ? arriveBy : new Date(Math.max((departAt || new Date()).getTime(), now));
  const ck = `T${ll(a)}>${ll(b)}@${useArrive ? 'A' : 'D'}${roundTime(when)}`;
  return googleCache(ck, async () => {
    const routes = await googleRoutes(key, {
      origin: latLng(a), destination: latLng(b), travelMode: 'TRANSIT', computeAlternativeRoutes: true,
      ...(useArrive ? { arrivalTime: when.toISOString() } : { departureTime: when.toISOString() }),
    }, 'routes.duration,routes.distanceMeters,routes.legs.steps.travelMode,routes.legs.steps.staticDuration,' +
       'routes.legs.steps.distanceMeters,routes.legs.steps.transitDetails,routes.travelAdvisory.transitFare');
    return routes.map((r) => parseTransit(r, when, useArrive)).filter(Boolean);
  });
}

function parseTransit(r, when, isArrive) {
  const raw = (r.legs || []).flatMap((l) => l.steps || []);
  const steps = [];
  for (const s of raw) {
    const min = gSecs(s.staticDuration);
    if (s.travelMode === 'TRANSIT' && s.transitDetails) {
      const td = s.transitDetails, line = td.transitLine || {};
      const [kind, icon] = VEHICLE[line.vehicle?.type] || ['bus', '🚌'];
      const dep = new Date(td.stopDetails?.departureTime), arr = new Date(td.stopDetails?.arrivalTime);
      steps.push({
        kind, icon, min: minsBetween(dep, arr) || min,
        line: line.nameShort || line.name || line.vehicle?.name?.text || 'Transit',
        from: td.stopDetails?.departureStop?.name || '', to: td.stopDetails?.arrivalStop?.name || '',
        fromLoc: td.stopDetails?.departureStop?.location?.latLng, stops: td.stopCount,
        dep, arr, headsign: td.headsign || '',
      });
    } else {
      const last = steps[steps.length - 1];
      if (last && last.kind === 'walk') last.min += min;
      else steps.push({ kind: 'walk', icon: '🚶', min });
    }
  }
  const transit = steps.filter((s) => s.kind !== 'walk');
  let leave, arrive;
  if (transit.length) {
    const first = steps.indexOf(transit[0]), last = steps.indexOf(transit[transit.length - 1]);
    const walkBefore = steps.slice(0, first).reduce((t, s) => t + s.min, 0);
    const walkAfter = steps.slice(last + 1).reduce((t, s) => t + s.min, 0);
    leave = addMin(transit[0].dep, -walkBefore);
    arrive = addMin(transit[transit.length - 1].arr, walkAfter);
  } else {
    const dur = gSecs(r.duration);
    if (!dur) return null;
    leave = isArrive ? addMin(when, -dur) : when;
    arrive = addMin(leave, dur);
  }
  const fare = r.travelAdvisory?.transitFare;
  const fareText = fare ? `${fare.currencyCode === 'USD' ? '$' : fare.currencyCode + ' '}${(+fare.units || 0) + (fare.nanos || 0) / 1e9}` : null;
  return { steps, leave, arrive, km: (r.distanceMeters || 0) / 1000, fare: fareText };
}

// ---------------------------------------------------------------- option builders

function transitTitle(steps) {
  const kinds = [...new Set(steps.filter((s) => s.kind !== 'walk').map((s) => s.kind))];
  const name = { bus: 'Bus', train: 'Train', ferry: 'Ferry' };
  return kinds.length ? kinds.map((k) => name[k]).join(' + ') : 'Walk';
}

function stepText(s) {
  if (s.kind === 'walk') return `Walk ${fmtDur(s.min)}`;
  if (s.kind === 'taxi') return `Taxi ${fmtDur(s.min)}${s.to ? ` to ${s.to}` : ''}`;
  return `${s.line}${s.from ? ` from ${s.from}` : ''}${s.stops ? ` · ${s.stops} stops` : ''}`;
}

/**
 * Plan a trip.
 *  - arriveBy: Date you must be there (options give the latest time to leave, incl. buffer)
 *  - departAt: Date you leave (used when no arriveBy)
 * Returns { live, note, options[] } where each option has
 *   { id, kind, icon, title, detail, min, leave, arrive, traffic?, cost, steps[], links[], estimate }
 */
export async function planTrip(from, to, { arriveBy = null, departAt = null, settings, weatherFactor = 1 }) {
  const key = settings.googleKey?.trim();
  const buffer = arriveBy ? settings.bufferMin || 0 : 0;
  const target = arriveBy ? addMin(arriveBy, -buffer) : null;
  const start = departAt || new Date();
  const taxi = settings.taxi;
  const options = [];
  let live = !!key, note = '';

  // --- Driving (and taxi, which shares the drive time)
  let drive = null;
  if (key) {
    try {
      let d = await gDrive(key, from, to, target ? addMin(target, -45) : start);
      if (target) d = await gDrive(key, from, to, addMin(target, -d.min)); // refine at real departure time
      drive = { ...d, ratio: d.min / (d.typical || d.min), estimate: false };
    } catch (e) {
      live = false;
      note = `Live traffic unavailable (${e.message}). Showing estimates.`;
    }
  }
  if (!drive) {
    const ff = await freeFlow(from, to);
    let when = target ? addMin(target, -ff.min * 1.3) : start;
    let f = trafficFactor(when) * weatherFactor;
    if (target) { when = addMin(target, -ff.min * f); f = trafficFactor(when) * weatherFactor; }
    drive = { min: ff.min * f, typical: ff.min * 1.04, km: ff.km, ratio: f / 1.04, estimate: true, via: '' };
  }
  const traffic = { ...trafficLevel(drive.ratio), ratio: drive.ratio, typical: drive.typical, extra: drive.min - drive.typical };
  {
    const leave = target ? addMin(target, -drive.min) : start;
    options.push({
      id: 'drive', kind: 'drive', icon: '🚗', title: 'Drive', min: drive.min, leave, arrive: addMin(leave, drive.min),
      detail: `${drive.km.toFixed(1)} km${drive.via ? ` via ${drive.via}` : ''}`, traffic, cost: null,
      steps: [], estimate: drive.estimate, links: [{ label: 'Navigate', url: mapsUrl(from, to, 'driving') }],
    });
    const tMin = drive.min + taxi.waitMin;
    const tLeave = target ? addMin(target, -tMin) : start;
    options.push({
      id: 'taxi', kind: 'taxi', icon: '🚕', title: 'Taxi / ride-hail', min: tMin, leave: tLeave, arrive: addMin(tLeave, tMin),
      detail: `Book by ${tLeave.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ~${taxi.waitMin} min pickup wait`,
      traffic, cost: taxiFare(taxi, drive.km, drive.min), steps: [], estimate: drive.estimate,
      links: [{ label: 'Book ride', url: rideUrl(from, to) }],
    });
  }

  // --- Public transport
  let transit = null;
  if (key && live) {
    try {
      transit = await gTransit(key, from, to, { arriveBy: target, departAt: start });
    } catch (e) {
      note ||= `Live bus/train times unavailable (${e.message}).`;
    }
  }
  if (transit && transit.length) {
    const seen = new Set();
    for (const [i, t] of transit.entries()) {
      const title = transitTitle(t.steps);
      const sig = t.steps.map((s) => s.line || s.kind).join('>');
      if (seen.has(sig)) continue;
      seen.add(sig);
      const min = minsBetween(t.leave, t.arrive);
      options.push({
        id: `transit${i}`, kind: 'transit', icon: t.steps.find((s) => s.kind !== 'walk')?.icon || '🚶', title,
        min, leave: t.leave, arrive: t.arrive, detail: t.steps.filter((s) => s.kind !== 'walk').map((s) => s.line).join(' → '),
        cost: t.fare, steps: t.steps.map((s) => ({ ...s, text: stepText(s) })), estimate: false,
        links: [{ label: 'Open in Maps', url: mapsUrl(from, to, 'transit') }],
      });
      // Taxi + train: take a cab to the first train station instead of the walk/bus feeder.
      const ri = t.steps.findIndex((s) => s.kind === 'train');
      if (ri > 0 && t.steps[ri].fromLoc) {
        const feeder = minsBetween(t.leave, t.steps[ri].dep);
        if (feeder >= 12) {
          const stop = { lat: t.steps[ri].fromLoc.latitude, lon: t.steps[ri].fromLoc.longitude };
          try {
            const leg = await gDrive(key, from, stop, addMin(t.steps[ri].dep, -20));
            const cabMin = leg.min + taxi.waitMin + 3; // +3 min to reach the platform
            const leave = addMin(t.steps[ri].dep, -cabMin);
            if (minsBetween(t.leave, leave) >= 5) {
              const rest = t.steps.slice(ri);
              options.push({
                id: `combo${i}`, kind: 'combo', icon: '🚕', title: `Taxi + ${transitTitle(rest)}`,
                min: minsBetween(leave, t.arrive), leave, arrive: t.arrive,
                detail: `Cab to ${t.steps[ri].from}, then ${rest.filter((s) => s.kind !== 'walk').map((s) => s.line).join(' → ')}` +
                  ` · leave ${Math.round(minsBetween(t.leave, leave))} min later`,
                cost: taxiFare(taxi, leg.km, leg.min),
                steps: [{ kind: 'taxi', icon: '🚕', min: leg.min, to: t.steps[ri].from }, ...rest].map((s) => ({ ...s, text: stepText(s) })),
                estimate: false,
                links: [{ label: 'Book ride', url: rideUrl(from, stop) }, { label: 'Train route', url: mapsUrl(stop, to, 'transit') }],
              });
            }
          } catch { /* combo is optional */ }
        }
      }
      if (options.filter((o) => o.kind === 'transit').length >= 3) break;
    }
  } else {
    // Rough public-transport estimate without live data.
    const km = drive.km;
    const min = 14 + (km / 22) * 60;
    const leave = target ? addMin(target, -min) : start;
    options.push({
      id: 'transit', kind: 'transit', icon: '🚆', title: 'Bus / train', min, leave, arrive: addMin(leave, min),
      detail: key ? 'Estimate — live timetable unavailable' : 'Rough estimate — add a Google Maps key in Settings for live bus & train routes',
      cost: null, steps: [], estimate: true, links: [{ label: 'Routes in Maps', url: mapsUrl(from, to, 'transit') }],
    });
    if (km > 6) {
      // Taxi to a station ~25% of the way, then train.
      const cab = (drive.min * 0.25) + taxi.waitMin + 3, rail = 8 + ((km * 0.75) / 32) * 60;
      const cmin = cab + rail, cleave = target ? addMin(target, -cmin) : start;
      options.push({
        id: 'combo', kind: 'combo', icon: '🚕', title: 'Taxi + train', min: cmin, leave: cleave, arrive: addMin(cleave, cmin),
        detail: 'Cab to the nearest train station, then train — rough estimate',
        cost: taxiFare(taxi, km * 0.25, drive.min * 0.25), steps: [], estimate: true,
        links: [{ label: 'Routes in Maps', url: mapsUrl(from, to, 'transit') }],
      });
    }
  }

  // --- Walk for short hops
  if (drive.km <= 2.5) {
    const min = (drive.km / 4.8) * 60 + 2;
    const leave = target ? addMin(target, -min) : start;
    options.push({
      id: 'walk', kind: 'walk', icon: '🚶', title: 'Walk', min, leave, arrive: addMin(leave, min),
      detail: `${drive.km.toFixed(1)} km`, cost: null, steps: [], estimate: true,
      links: [{ label: 'Directions', url: mapsUrl(from, to, 'walking') }],
    });
  }

  // Sort: by arrive-by → latest you can leave first; by depart → earliest arrival first.
  options.sort((x, y) => (target ? y.leave - x.leave : x.arrive - y.arrive));
  const fastest = options.reduce((a, o) => (o.min < a.min ? o : a), options[0]);
  fastest.fastest = true;
  return { live: live && !drive.estimate, note, options, target, buffer };
}

/** The option to headline, honouring the user's preference. */
export function pickPreferred(options, pref) {
  const by = (k) => options.filter((o) => o.kind === k).sort((a, b) => b.leave - a.leave)[0];
  if (pref === 'drive') return by('drive');
  if (pref === 'taxi') return by('taxi');
  if (pref === 'transit') return by('transit') || by('combo');
  return options.find((o) => o.fastest) || options[0];
}

/** Driving time if you leave at each of `times` — for the "when to leave" outlook. */
export async function driveOutlook(from, to, times, settings, weatherFactorAt = () => 1) {
  const key = settings.googleKey?.trim();
  let ff = null;
  return Promise.all(times.map(async (t) => {
    if (key) {
      try {
        const d = await gDrive(key, from, to, t);
        return { t, min: d.min, level: trafficLevel(d.min / (d.typical || d.min)).key, estimate: false };
      } catch { /* fall through */ }
    }
    ff ||= await freeFlow(from, to);
    const f = trafficFactor(t) * weatherFactorAt(t);
    return { t, min: ff.min * f, level: trafficLevel(f / 1.04).key, estimate: true };
  }));
}
