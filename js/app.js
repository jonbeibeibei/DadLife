// DadLife — the at-a-glance day planner for commuting parents.
import { $, $$, esc, uid, ymd, atTime, addMin, addDays, minsBetween, fmtTime, fmtDur, fmtUntil, DAYS, DAYS_LONG, hasCoords } from './util.js';
import { load, save, reset, CHORE_PRESETS } from './store.js';
import { getWeather, wx, advice, trafficWeatherFactor, windowSummary } from './weather.js';
import { planTrip, pickPreferred, driveOutlook, googleError, mapsUrl } from './routing.js';
import { searchPlaces, currentPosition, reverseGeocode } from './geo.js';

let S = load();
const persist = () => save(S);
const cfg = () => S.settings;
let tab = location.hash.slice(1) || 'today';
let token = 0;
const commuteView = { from: null, to: null, mode: null, time: null };

// =============================================================== day model

function dayInfo(date) {
  const s = cfg().schedule[date.getDay()];
  const place = cfg().places.find((p) => p.id === s.placeId) || cfg().places[0];
  return {
    ...s, place, startAt: atTime(date, s.start), endAt: atTime(date, s.end),
    isWork: s.mode === 'work' && !!place,
  };
}

function autoPhase(now) {
  const d = dayInfo(now);
  if (!d.isWork) return d.mode === 'wfh' ? 'wfh' : 'off';
  if (now < d.startAt) return 'commute';
  if (now < addMin(d.endAt, 150)) return 'work';
  return 'home';
}

function phase(now) {
  const o = S.override;
  if (o && o.date === ymd(now)) return o.phase;
  return autoPhase(now);
}

/** Where you are now (origin for "leave by" maths). */
function whereAmI(now) {
  const p = phase(now), d = dayInfo(now);
  if (p === 'work' && d.place && hasCoords(d.place)) return { ...d.place, name: d.place.name };
  return { ...cfg().home, name: cfg().home.name || 'Home' };
}

function plansOn(date) {
  const k = ymd(date), dow = date.getDay();
  return S.plans
    .filter((p) => p.enabled !== false && (p.date ? p.date === k : (p.days || []).includes(dow)))
    .map((p) => ({ ...p, at: atTime(date, p.time) }))
    .sort((a, b) => a.at - b.at);
}

const greeting = (now) => {
  const h = now.getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

const allPlaces = () => {
  const list = [{ key: 'home', ...cfg().home, name: cfg().home.name || 'Home' }];
  for (const p of cfg().places) list.push({ key: `place:${p.id}`, ...p });
  for (const p of S.plans) if (hasCoords(p.place)) list.push({ key: `plan:${p.id}`, ...p.place, name: `${p.place.name || p.title}` });
  return list.filter((p) => hasCoords(p));
};
const placeByKey = (k) => allPlaces().find((p) => p.key === k);

// =============================================================== chores

const DAY = 864e5;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

function choreStatus(c, now = new Date()) {
  const last = new Date(c.lastDone);
  const due = addDays(startOfDay(last), c.every);
  const diff = Math.round((due - startOfDay(now)) / DAY);
  const progress = Math.min(1, Math.max(0, (now - last) / (c.every * DAY)));
  let text, level;
  if (diff < 0) { text = `Overdue by ${-diff} day${diff < -1 ? 's' : ''}`; level = 'bad'; }
  else if (diff === 0) { text = 'Due today'; level = 'warn'; }
  else if (diff === 1) { text = 'Due tomorrow'; level = 'soon'; }
  else { text = `Due in ${diff} days`; level = 'ok'; }
  return { due, diff, progress, text, level };
}

const sortedChores = () =>
  S.chores.map((c) => ({ c, s: choreStatus(c) })).sort((a, b) => a.s.diff - b.s.diff || b.s.progress - a.s.progress);

function choreRow({ c, s }) {
  return `
  <div class="chore lvl-${s.level}" data-id="${c.id}">
    <button class="chore-main" data-act="edit-chore" data-id="${c.id}" aria-label="Edit ${esc(c.name)}">
      <span class="chore-emoji">${esc(c.emoji || '✅')}</span>
      <span class="chore-text">
        <span class="chore-name">${esc(c.name)}</span>
        <span class="chore-sub">${s.text} · every ${c.every === 1 ? 'day' : `${c.every} days`}</span>
        <span class="bar"><span style="width:${Math.round(s.progress * 100)}%"></span></span>
      </span>
    </button>
    <button class="done-btn" data-act="chore-done" data-id="${c.id}" aria-label="Mark ${esc(c.name)} done">✓</button>
  </div>`;
}

// =============================================================== shared bits

const skeleton = (h = 90) => `<div class="card skeleton" style="height:${h}px"></div>`;
const errCard = (e) => `<div class="card note bad">⚠️ ${esc(e?.message || e)}</div>`;

function trafficPill(t) {
  if (!t) return '';
  return `<span class="pill tr-${t.key}">${t.label}${t.extra > 2 ? ` +${Math.round(t.extra)}m` : ''}</span>`;
}

function optionRow(o, { compact = false, target = null, now = new Date() } = {}) {
  const lateBy = target ? minsBetween(target, o.arrive) : 0;
  const past = o.leave < addMin(now, -1);
  const right = target
    ? `<div class="opt-time"><span class="lbl">leave by</span><b>${fmtTime(o.leave)}</b><span class="sub ${past ? 'bad' : ''}">${past ? 'missed' : fmtUntil(o.leave, now)}</span></div>`
    : `<div class="opt-time"><span class="lbl">arrive</span><b>${fmtTime(o.arrive)}</b>${lateBy > 0 ? `<span class="sub bad">${Math.round(lateBy)}m late</span>` : ''}</div>`;
  const steps = !compact && o.steps?.length
    ? `<ol class="steps">${o.steps.map((s) => `<li><span>${s.icon}</span><span>${esc(s.text)}${s.dep ? ` <em>${fmtTime(s.dep)}</em>` : ''}</span><span class="m">${fmtDur(s.min)}</span></li>`).join('')}</ol>`
    : '';
  const links = !compact && o.links?.length
    ? `<div class="links">${o.links.map((l) => `<a class="btn small ghost" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}</div>`
    : '';
  return `
  <div class="opt ${compact ? 'compact' : ''}">
    <div class="opt-icon">${o.icon}</div>
    <div class="opt-body">
      <div class="opt-title">${esc(o.title)} <span class="dur">${fmtDur(o.min)}</span>
        ${o.fastest ? '<span class="pill good">fastest</span>' : ''}${o.estimate ? '<span class="pill muted">est.</span>' : ''}</div>
      <div class="opt-detail">${o.traffic && (o.kind === 'drive' || compact) && o.kind !== 'transit' ? trafficPill(o.traffic) : ''}
        ${o.cost ? `<span class="cost">${esc(o.cost)}</span>` : ''} ${compact ? '' : esc(o.detail || '')}</div>
      ${steps}${links}
    </div>
    ${right}
  </div>`;
}

async function homeWeather(loc) {
  if (!hasCoords(loc)) return null;
  try { return await getWeather(loc); } catch { return null; }
}

// =============================================================== TODAY

function todayHtml(now) {
  const d = dayInfo(now), p = phase(now);
  const ready = hasCoords(cfg().home);
  const dayChip = d.isWork
    ? `🏢 ${esc(d.place.name)} · ${fmtTime(d.startAt)} – ${fmtTime(d.endAt)}`
    : d.mode === 'wfh' ? '🏠 Working from home' : '🎉 Day off';
  const seg = [['commute', '🚗 Heading out'], ['work', '💼 At work'], ['home', '🏠 At home']];
  const segVal = p === 'off' || p === 'wfh' ? 'home' : p;
  return `
  <header class="top">
    <div>
      <div class="eyebrow">${DAYS_LONG[now.getDay()]} ${now.getDate()} ${now.toLocaleString([], { month: 'short' })}</div>
      <h1>${greeting(now)}</h1>
    </div>
    <button class="icon-btn" data-act="refresh" aria-label="Refresh">↻</button>
  </header>
  <div class="daychip">${dayChip}</div>
  ${d.isWork ? `<div class="seg">${seg.map(([k, l]) => `<button data-act="phase" data-phase="${k}" class="${segVal === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${S.override?.date === ymd(now) ? '<div class="hint">Manually set · <button class="link" data-act="phase" data-phase="auto">back to automatic</button></div>' : ''}` : ''}
  ${ready ? '' : `<div class="card cta"><h3>👋 Let’s set you up</h3><p>Add your home, work places and weekly schedule to get commute times, traffic and “leave by” alerts.</p><button class="btn" data-act="goto" data-tab="settings">Set up now</button></div>`}
  <section id="t-hero">${ready ? skeleton(150) : ''}</section>
  <section id="t-weather">${ready ? skeleton(120) : ''}</section>
  <section id="t-commute"></section>
  <section id="t-plans"></section>
  <section id="t-chores"></section>`;
}

function todayAfter(root, tok, now) {
  const fills = [];
  const fill = (sel, fn) => {
    const el = $(sel, root);
    fills.push(Promise.resolve().then(fn).then((h) => { if (tok === token) el.innerHTML = h ?? ''; })
      .catch((e) => { console.error(e); if (tok === token) el.innerHTML = errCard(e); }));
  };
  fill('#t-chores', () => choresSummary(now));
  if (!hasCoords(cfg().home)) return fills;

  const d = dayInfo(now), p = phase(now), here = whereAmI(now);
  const wHome = homeWeather(cfg().home);
  const wHere = hasCoords(here) && here !== cfg().home ? homeWeather(here) : wHome;

  // Morning commute (shared by hero + options list)
  let commuteP = null;
  if (p === 'commute' && hasCoords(d.place)) {
    commuteP = wHome.then((w) => planTrip(cfg().home, d.place, {
      arriveBy: d.startAt, settings: cfg(),
      weatherFactor: w ? trafficWeatherFactor(w, addMin(d.startAt, -90), d.startAt) : 1,
    }));
  }
  // Today's plans with "leave by" from where you are
  const plansP = planLeaveTimes(now);

  fill('#t-hero', () => hero(now, d, p, commuteP, plansP, wHome));
  fill('#t-weather', () => weatherCard(now, d, p, wHere, here));
  fill('#t-commute', () => commuteSection(now, d, p, commuteP));
  fill('#t-plans', () => plansSection(now, plansP));
  return fills;
}

/** Where you'll be setting off from for a plan: work if it falls in your work day, else home. */
function originFor(pl, now) {
  const d = dayInfo(now), p = phase(now);
  if (d.isWork && hasCoords(d.place) && (p === 'work' || (p === 'commute' && pl.at >= d.startAt))) return { ...d.place, atWork: true };
  return { ...cfg().home, name: cfg().home.name || 'Home' };
}

async function planLeaveTimes(now) {
  const list = plansOn(now).filter((pl) => pl.at > addMin(now, -30));
  return Promise.all(list.map(async (pl) => {
    const from = originFor(pl, now);
    if (!hasCoords(pl.place) || !hasCoords(from)) return { pl, res: null, from };
    try {
      const res = await planTrip(from, pl.place, { arriveBy: pl.at, settings: cfg() });
      return { pl, res, from, best: pickPreferred(res.options, cfg().preferred) };
    } catch (e) {
      return { pl, res: null, err: e };
    }
  }));
}

function heroBlock({ kicker, big, countdown, level = 'ok', lines = [], cta = '' }) {
  return `<div class="card hero lvl-${level}">
    <div class="kicker">${kicker}</div>
    <div class="big">${big}</div>
    ${countdown ? `<div class="countdown">${countdown}</div>` : ''}
    ${lines.map((l) => `<div class="line">${l}</div>`).join('')}
    ${cta}
  </div>`;
}

const urgency = (leave, now) => {
  const m = minsBetween(now, leave);
  return m < 0 ? 'bad' : m < 15 ? 'warn' : 'ok';
};

async function hero(now, d, p, commuteP, plansP) {
  if (commuteP) {
    const res = await commuteP;
    const o = pickPreferred(res.options, cfg().preferred);
    if (o.leave >= addMin(now, -1)) {
      return heroBlock({
        kicker: `To ${esc(d.place.name)} for ${fmtTime(d.startAt)}`,
        big: `Leave by ${fmtTime(o.leave)}`,
        countdown: fmtUntil(o.leave, now), level: urgency(o.leave, now),
        lines: [
          `${o.icon} ${esc(o.title)} · ${fmtDur(o.min)} ${o.traffic && o.kind !== 'transit' && o.kind !== 'combo' ? trafficPill(o.traffic) : ''}`,
          `Arrive ~${fmtTime(o.arrive)} · ${res.buffer} min spare${o.estimate ? ' · <span class="muted">estimate</span>' : ''}`,
        ],
        cta: `<button class="btn small ghost" data-act="goto" data-tab="commute">All options →</button>`,
      });
    }
    // Running late: what happens if you leave right now?
    const nowRes = await planTrip(cfg().home, d.place, { departAt: now, settings: cfg() });
    const n = pickPreferred(nowRes.options, cfg().preferred);
    const fastest = nowRes.options.find((x) => x.fastest);
    const late = minsBetween(d.startAt, n.arrive);
    return heroBlock({
      kicker: `To ${esc(d.place.name)} for ${fmtTime(d.startAt)}`, big: 'Leave now', level: late > 0 ? 'bad' : 'warn',
      countdown: late > 0 ? `you’ll be ~${Math.round(late)} min late` : 'you’ll just make it',
      lines: [
        `${n.icon} ${esc(n.title)} arrives ~${fmtTime(n.arrive)}`,
        fastest && fastest !== n ? `Fastest: ${fastest.icon} ${esc(fastest.title)} arrives ~${fmtTime(fastest.arrive)}` : '',
      ].filter(Boolean),
      cta: `<button class="btn small ghost" data-act="goto" data-tab="commute">All options →</button>`,
    });
  }

  const plans = (await plansP).filter((x) => x.best);
  const next = plans.filter((x) => x.pl.at > now).sort((a, b) => a.best.leave - b.best.leave)[0];
  if (next) {
    const o = next.best, from = next.from.atWork ? 'work' : 'home';
    return heroBlock({
      kicker: `${esc(next.pl.emoji || '📍')} ${esc(next.pl.title)} at ${fmtTime(next.pl.at)}`,
      big: o.leave < now ? 'Leave now' : `Leave ${from} by ${fmtTime(o.leave)}`,
      countdown: o.leave < now ? `you’ll arrive ~${fmtTime(addMin(now, o.min))}` : fmtUntil(o.leave, now),
      level: urgency(o.leave, now),
      lines: [`${o.icon} ${esc(o.title)} · ${fmtDur(o.min)} ${o.traffic && o.kind !== 'transit' && o.kind !== 'combo' ? trafficPill(o.traffic) : ''}`,
        `to ${esc(next.pl.place.name || next.pl.place.address || '')}`],
      cta: `<button class="btn small ghost" data-act="goto" data-tab="plans">Plans →</button>`,
    });
  }

  if (p === 'work' && hasCoords(d.place)) {
    const leaveAt = now > d.endAt ? now : d.endAt;
    const res = await planTrip(d.place, cfg().home, { departAt: leaveAt, settings: cfg() });
    const o = pickPreferred(res.options, cfg().preferred);
    return heroBlock({
      kicker: now > d.endAt ? 'Work’s done' : `Work ends ${fmtTime(d.endAt)} (${fmtUntil(d.endAt, now)})`,
      big: `Home by ~${fmtTime(o.arrive)}`, level: 'ok',
      lines: [`${o.icon} ${esc(o.title)} · ${fmtDur(o.min)} ${o.traffic && o.kind !== 'transit' ? trafficPill(o.traffic) : ''}`],
      cta: `<button class="btn small ghost" data-act="goto" data-tab="commute">Best time to leave →</button>`,
    });
  }

  // Evening / day off: preview tomorrow
  const tmr = addDays(now, 1), td = dayInfo(tmr);
  if (td.isWork && hasCoords(td.place)) {
    const res = await planTrip(cfg().home, td.place, { arriveBy: td.startAt, settings: cfg() });
    const o = pickPreferred(res.options, cfg().preferred);
    return heroBlock({
      kicker: `Tomorrow · ${DAYS_LONG[tmr.getDay()]}`, big: `Leave by ~${fmtTime(o.leave)}`, level: 'ok',
      lines: [`to ${esc(td.place.name)} for ${fmtTime(td.startAt)} · ${o.icon} ${esc(o.title)} ${fmtDur(o.min)}`,
        `<span class="muted">Typical traffic for that time — updates in the morning</span>`],
    });
  }
  const due = S.chores.filter((c) => choreStatus(c, now).diff <= 0).length;
  return heroBlock({
    kicker: p === 'wfh' ? 'Working from home' : 'Nothing scheduled', big: p === 'wfh' ? 'No commute today ☕' : 'Enjoy your day 🎉',
    lines: [due ? `${due} chore${due > 1 ? 's' : ''} due — see below` : 'All chores on track ✓'],
  });
}

async function weatherCard(now, d, p, wP, here) {
  const w = await wP;
  if (!w) return `<div class="card note">🌤️ Weather unavailable right now.</div>`;
  const c = w.current, x = wx(c.code, c.isDay);
  const hours = w.hours.filter((h) => h.t >= addMin(now, -59)).slice(0, 12);
  const windows = [];
  if (d.isWork) {
    windows.push({ label: 'the morning commute', from: addMin(d.startAt, -90), to: d.startAt });
    windows.push({ label: 'the trip home', from: d.endAt, to: addMin(d.endAt, 90) });
  }
  for (const pl of plansOn(now)) windows.push({ label: pl.title.toLowerCase(), from: addMin(pl.at, -45), to: pl.at });
  const tips = advice(w, windows.filter((wi) => wi.to > now));
  return `<div class="card weather">
    <div class="wx-now">
      <div class="wx-icon">${x.icon}</div>
      <div class="grow"><div class="wx-temp">${Math.round(c.temp)}°</div><div class="muted small">${x.label} · feels ${Math.round(c.feels)}°</div></div>
      <div class="wx-hl"><div>↑${Math.round(w.today.max)}° ↓${Math.round(w.today.min)}°</div><div class="muted small">💧${w.today.pop}% · UV ${Math.round(w.today.uv)}</div>
      <div class="muted small">📍 ${esc(here.name || '')}</div></div>
    </div>
    <div class="hours">${hours.map((h) => `<div class="hr"><span>${h.t.toLocaleTimeString([], { hour: 'numeric' })}</span><span>${wx(h.code, h.t.getHours() > 6 && h.t.getHours() < 19).icon}</span><b>${Math.round(h.temp)}°</b><span class="pop ${h.pop >= 50 ? 'hi' : ''}">${h.pop}%</span></div>`).join('')}</div>
    ${tips.length ? `<ul class="tips">${tips.map((t) => `<li class="lvl-${t.level}">${t.icon} ${esc(t.text)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

async function commuteSection(now, d, p, commuteP) {
  if (commuteP) {
    const res = await commuteP;
    return `<h2 class="sec">Ways to get to ${esc(d.place.name)} <button class="link" data-act="goto" data-tab="commute">details</button></h2>
      ${res.note ? `<div class="card note warn">${esc(res.note)}</div>` : ''}
      <div class="card list">${res.options.map((o) => optionRow(o, { compact: true, target: res.target, now })).join('')}</div>
      ${res.live ? '<div class="hint">Live traffic & timetables · Google</div>' : '<div class="hint">Estimates · typical traffic for this time of day</div>'}`;
  }
  if (p === 'work' && hasCoords(d.place)) {
    const base = now > d.endAt ? now : d.endAt;
    const times = [-60, -30, 0, 30, 60, 90].map((m) => addMin(base, m)).filter((t) => t >= addMin(now, -5));
    const out = await driveOutlook(d.place, cfg().home, times, cfg());
    return `<h2 class="sec">Drive home · when to leave</h2>${outlookChart(out)}`;
  }
  return '';
}

function outlookChart(out) {
  if (!out.length) return '';
  const max = Math.max(...out.map((o) => o.min)), min = Math.min(...out.map((o) => o.min));
  const best = out.find((o) => o.min === min);
  return `<div class="card outlook">
    <div class="bars">${out.map((o) => `<div class="b ${o === best ? 'best' : ''}">
      <span class="v">${Math.round(o.min)}m</span>
      <span class="col tr-${o.level}" style="height:${Math.max(18, (o.min / max) * 100)}%"></span>
      <span class="t">${fmtTime(o.t)}</span></div>`).join('')}</div>
    <div class="hint">Quickest: leave at <b>${fmtTime(best.t)}</b> (${fmtDur(best.min)})${out[0].estimate ? ' · typical traffic estimate' : ' · live traffic forecast'}</div>
  </div>`;
}

async function plansSection(now, plansP) {
  const rows = await plansP;
  if (!rows.length) {
    return `<h2 class="sec">Today’s plans <button class="link" data-act="add-plan">+ add</button></h2>
      <div class="card note">No pick-ups or plans today. Add one to get a “leave by” time.</div>`;
  }
  return `<h2 class="sec">Today’s plans</h2>
    <div class="card list">${rows.map((r) => planRow(r, now)).join('')}</div>`;
}

function planRow({ pl, res, best, err, from }, now) {
  const head = `<div class="plan-head"><span class="pe">${esc(pl.emoji || '📍')}</span>
    <div><div class="pt">${esc(pl.title)}</div><div class="muted small">${fmtTime(pl.at)} · ${esc(pl.place?.name || pl.place?.address || 'no location')}</div></div></div>`;
  if (!hasCoords(pl.place)) return `<div class="plan">${head}<button class="btn small ghost" data-act="edit-plan" data-id="${pl.id}">Add location</button></div>`;
  if (!best) return `<div class="plan">${head}<span class="muted small">${err ? 'Route unavailable' : '—'}</span></div>`;
  const lvl = urgency(best.leave, now);
  const alts = res.options.filter((o) => ['drive', 'transit', 'taxi', 'combo'].includes(o.kind) && o !== best)
    .slice(0, 3).map((o) => `<span class="alt">${o.icon} ${fmtTime(o.leave)}</span>`).join(' · ');
  return `<div class="plan lvl-${lvl}">
    ${head}
    <div class="plan-leave"><span class="lbl">leave by</span><b>${fmtTime(best.leave)}</b><span class="sub">${best.leave < now ? 'now!' : fmtUntil(best.leave, now)}</span></div>
    <div class="plan-alts">from ${esc(from?.name || 'home')} · ${best.icon} ${esc(best.title)} ${fmtDur(best.min)}${alts ? `<br>or leave by ${alts}` : ''}</div>
  </div>`;
}

function choresSummary(now) {
  const list = sortedChores();
  const urgent = list.filter((x) => x.s.diff <= 0);
  const show = urgent.length ? urgent : list.slice(0, 2);
  return `<h2 class="sec">Home chores <button class="link" data-act="goto" data-tab="chores">all ${list.length}</button></h2>
    ${urgent.length ? '' : '<div class="hint good">✓ Nothing due today — next up:</div>'}
    <div class="card list">${show.map(choreRow).join('') || '<div class="note">No chores yet.</div>'}</div>`;
}

// =============================================================== COMMUTE tab

function commuteDefaults(now) {
  const d = dayInfo(now), p = phase(now);
  const workKey = d.place ? `place:${d.place.id}` : null;
  if (!commuteView.from) {
    if (p === 'commute' && workKey) Object.assign(commuteView, { from: 'home', to: workKey, mode: 'arrive', time: d.start });
    else if (p === 'work' && workKey) Object.assign(commuteView, { from: workKey, to: 'home', mode: 'depart', time: d.end });
    else {
      const td = dayInfo(addDays(now, 1));
      Object.assign(commuteView, { from: 'home', to: td.place ? `place:${td.place.id}` : workKey || 'home', mode: 'arrive', time: td.start || '09:00' });
    }
  }
}

function commuteHtml(now) {
  commuteDefaults(now);
  const places = allPlaces();
  const opts = (sel) => places.map((p) => `<option value="${esc(p.key)}" ${p.key === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  if (places.length < 2) {
    return `<header class="top"><h1>Commute</h1></header>
      <div class="card cta"><p>Add your home and at least one work place to compare commute options.</p>
      <button class="btn" data-act="goto" data-tab="settings">Open settings</button></div>`;
  }
  return `<header class="top"><h1>Commute</h1><button class="icon-btn" data-act="swap" aria-label="Swap">⇅</button></header>
  <div class="card form">
    <label>From<select id="c-from">${opts(commuteView.from)}</select></label>
    <label>To<select id="c-to">${opts(commuteView.to)}</select></label>
    <div class="row">
      <div class="seg small">
        <button data-act="cmode" data-mode="arrive" class="${commuteView.mode === 'arrive' ? 'on' : ''}">Arrive by</button>
        <button data-act="cmode" data-mode="depart" class="${commuteView.mode === 'depart' ? 'on' : ''}">Leave at</button>
        <button data-act="cmode" data-mode="now" class="${commuteView.mode === 'now' ? 'on' : ''}">Now</button>
      </div>
    </div>
      ${commuteView.mode !== 'now' ? `<input type="time" id="c-time" class="mt" value="${esc(commuteView.time || '09:00')}">` : ''}
  </div>
  <section id="c-res">${skeleton(260)}</section>
  <section id="c-out"></section>
  <section id="c-wx"></section>`;
}

function commuteAfter(root, tok, now) {
  const a = placeByKey(commuteView.from), b = placeByKey(commuteView.to);
  if (!a || !b) return [];
  const t = commuteView.mode === 'now' ? now : atTime(now, commuteView.time);
  // a time already passed today means tomorrow
  const when = commuteView.mode !== 'now' && t < addMin(now, -30) ? addDays(t, 1) : t;
  const fills = [];
  const fill = (sel, fn) => {
    const el = $(sel, root);
    fills.push(Promise.resolve().then(fn).then((h) => { if (tok === token) el.innerHTML = h ?? ''; })
      .catch((e) => { console.error(e); if (tok === token) el.innerHTML = errCard(e); }));
  };
  if (a.key === b.key) { $('#c-res', root).innerHTML = '<div class="card note">Pick two different places.</div>'; return []; }
  const wP = homeWeather(a);
  const resP = wP.then((w) => planTrip(a, b, {
    ...(commuteView.mode === 'arrive' ? { arriveBy: when } : { departAt: when }),
    settings: cfg(), weatherFactor: w ? trafficWeatherFactor(w, addMin(when, -60), addMin(when, 60)) : 1,
  }));
  fill('#c-res', async () => {
    const res = await resP;
    const head = commuteView.mode === 'arrive'
      ? `Arrive at ${esc(b.name)} by <b>${fmtTime(when)}</b>${when.getDate() !== now.getDate() ? ' tomorrow' : ''} (incl. ${res.buffer} min buffer)`
      : `Leaving ${esc(a.name)} at <b>${fmtTime(when)}</b>`;
    return `<div class="hint">${head}</div>
      ${res.note ? `<div class="card note warn">${esc(res.note)}</div>` : ''}
      <div class="card list">${res.options.map((o) => optionRow(o, { target: res.target, now })).join('')}</div>
      <div class="hint">${res.live ? '🟢 Live traffic & timetables (Google)' : '⚪ Estimated from typical traffic for this time of day. Add a Google Maps key in Settings for live traffic & bus/train times.'}</div>`;
  });
  fill('#c-out', async () => {
    const res = await resP;
    const drive = res.options.find((o) => o.kind === 'drive');
    const base = drive ? drive.leave : when;
    const times = [-45, -30, -15, 0, 15, 30, 45].map((m) => addMin(base, m)).filter((x) => x >= addMin(now, -5));
    const w = await wP;
    const out = await driveOutlook(a, b, times, cfg(), (x) => (w ? trafficWeatherFactor(w, x, addMin(x, 60)) : 1));
    return `<h2 class="sec">Driving time by departure</h2>${outlookChart(out)}`;
  });
  fill('#c-wx', async () => {
    const res = await resP;
    const o = res.options[0];
    const [wa, wb] = await Promise.all([wP, homeWeather(b)]);
    const cell = (w, label, at) => {
      if (!w) return '';
      const s = windowSummary(w, at, addMin(at, 59));
      if (!s) return '';
      const x = wx(s.code);
      return `<div class="wxcell"><div class="muted small">${esc(label)} · ${fmtTime(at)}</div><div>${x.icon} ${Math.round(s.temp)}° · 💧${s.pop}%</div></div>`;
    };
    const html = cell(wa, a.name, o.leave) + cell(wb, b.name, o.arrive);
    return html ? `<h2 class="sec">Weather on the way</h2><div class="card wxrow">${html}</div>` : '';
  });
  return fills;
}

// =============================================================== PLANS tab

function plansHtml(now) {
  const all = [...S.plans].sort((a, b) => (a.time > b.time ? 1 : -1));
  const rep = (p) => p.date ? `One-off · ${new Date(p.date + 'T00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`
    : (p.days || []).length === 7 ? 'Every day' : (p.days || []).length ? (p.days || []).slice().sort().map((d) => DAYS[d]).join(' ') : 'Never';
  return `<header class="top"><h1>Plans</h1><button class="btn small" data-act="add-plan">+ Add</button></header>
  <p class="hint">Pick-ups, dinners, classes — anything you need to <b>be somewhere by</b>. You’ll get the latest time to leave from wherever you are.</p>
  <section id="p-today">${skeleton(120)}</section>
  <h2 class="sec">All plans</h2>
  <div class="card list">${all.length ? all.map((p) => `
    <button class="row-btn ${p.enabled === false ? 'dim' : ''}" data-act="edit-plan" data-id="${p.id}">
      <span class="pe">${esc(p.emoji || '📍')}</span>
      <span class="grow"><span class="pt">${esc(p.title)}</span><span class="muted small">${esc(p.time)} · ${rep(p)} · ${esc(p.place?.name || 'no location')}</span></span>
      <span class="chev">›</span>
    </button>`).join('') : '<div class="note">No plans yet.</div>'}</div>`;
}

function plansAfter(root, tok, now) {
  const el = $('#p-today', root);
  return [planLeaveTimes(now).then((rows) => {
    if (tok !== token) return;
    el.innerHTML = rows.length
      ? `<h2 class="sec">Today</h2><div class="card list">${rows.map((r) => planRow(r, now)).join('')}</div>`
      : '<div class="card note">Nothing planned for today.</div>';
  }).catch((e) => { el.innerHTML = errCard(e); })];
}

function planEditor(plan) {
  const isNew = !plan;
  const p = plan ? JSON.parse(JSON.stringify(plan)) : {
    id: uid(), emoji: '📍', title: '', time: '18:00', days: [], date: ymd(new Date()), place: { name: '', address: '', lat: null, lon: null }, enabled: true,
  };
  const repeat = () => (p.date ? 'once' : 'weekly');
  const body = () => `
    <h2>${isNew ? 'New plan' : 'Edit plan'}</h2>
    <div class="quick">${[['🎒', 'Pick up the kids'], ['🏫', 'School drop-off'], ['🍽️', 'Dinner'], ['⚽', 'Kids’ class'], ['🩺', 'Doctor']].map(([e, t]) => `<button class="chip" data-q="${esc(e)}|${esc(t)}">${e} ${esc(t)}</button>`).join('')}</div>
    <div class="row"><input id="pe-emoji" class="emoji-in" value="${esc(p.emoji)}" maxlength="4" aria-label="Emoji">
      <input id="pe-title" placeholder="e.g. Pick up the kids" value="${esc(p.title)}"></div>
    <label>Be there by<input type="time" id="pe-time" value="${esc(p.time)}"></label>
    <div class="seg small"><button data-rep="weekly" class="${repeat() === 'weekly' ? 'on' : ''}">Repeats weekly</button><button data-rep="once" class="${repeat() === 'once' ? 'on' : ''}">One-off</button></div>
    ${repeat() === 'weekly'
      ? `<div class="days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="chip ${p.days.includes(d) ? 'on' : ''}" data-day="${d}">${DAYS[d]}</button>`).join('')}</div>`
      : `<label>Date<input type="date" id="pe-date" value="${esc(p.date)}"></label>`}
    <label>Where</label>
    <button class="row-btn loc" data-pick>${hasCoords(p.place) ? `📍 <span class="grow"><b>${esc(p.place.name)}</b><span class="muted small">${esc(p.place.address)}</span></span>` : '📍 <span class="grow muted">Choose a location…</span>'}<span class="chev">›</span></button>
    <label class="toggle"><input type="checkbox" id="pe-on" ${p.enabled !== false ? 'checked' : ''}> Active</label>
    <div class="actions">${isNew ? '' : '<button class="btn danger ghost" data-del>Delete</button>'}<button class="btn" data-save>Save</button></div>`;
  const sheet = openSheet(body());
  const grab = () => {
    p.emoji = $('#pe-emoji', sheet).value || '📍';
    p.title = $('#pe-title', sheet).value.trim();
    p.time = $('#pe-time', sheet).value || p.time;
    p.enabled = $('#pe-on', sheet).checked;
    const di = $('#pe-date', sheet);
    if (di) p.date = di.value || ymd(new Date());
  };
  const redraw = () => { grab(); $('.sheet-body', sheet).innerHTML = body(); };
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.q) { const [em, ti] = t.dataset.q.split('|'); grab(); p.emoji = em; p.title = ti; $('.sheet-body', sheet).innerHTML = body(); }
    else if (t.dataset.rep) { grab(); if (t.dataset.rep === 'once') { p.date ||= ymd(new Date()); } else { p.date = null; if (!p.days.length) p.days = [1, 2, 3, 4, 5]; } $('.sheet-body', sheet).innerHTML = body(); }
    else if (t.dataset.day) { const d = +t.dataset.day; p.days = p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d]; redraw(); }
    else if ('pick' in t.dataset) { grab(); const loc = await pickLocation({ ...p.place }, `Where is “${p.title || 'it'}”?`); if (loc) { p.place = loc; } $('.sheet-body', sheet).innerHTML = body(); }
    else if ('del' in t.dataset) { if (confirm('Delete this plan?')) { S.plans = S.plans.filter((x) => x.id !== p.id); persist(); closeSheet(); render(); } }
    else if ('save' in t.dataset) {
      grab();
      if (!p.title) { toast('Give it a name'); return; }
      const i = S.plans.findIndex((x) => x.id === p.id);
      if (i >= 0) S.plans[i] = p; else S.plans.push(p);
      persist(); closeSheet(); render(); toast('Plan saved');
    }
  });
}

// =============================================================== CHORES tab

function choresHtml() {
  const list = sortedChores();
  const n = (f) => list.filter(f).length;
  return `<header class="top"><h1>Chores</h1><button class="btn small" data-act="add-chore">+ Add</button></header>
  <div class="stats">
    <div class="stat bad"><b>${n((x) => x.s.diff < 0)}</b><span>overdue</span></div>
    <div class="stat warn"><b>${n((x) => x.s.diff === 0)}</b><span>due today</span></div>
    <div class="stat ok"><b>${n((x) => x.s.diff > 0)}</b><span>on track</span></div>
  </div>
  <div class="card list">${list.map(choreRow).join('') || '<div class="note">No chores yet — add one.</div>'}</div>
  <p class="hint">Tap ✓ when done to restart its countdown. Tap a chore to change how often it repeats.</p>`;
}

function choreEditor(chore) {
  const isNew = !chore;
  const c = chore ? { ...chore } : { id: uid(), emoji: '🧽', name: '', every: 7, lastDone: new Date().toISOString(), count: 0 };
  const sheet = openSheet(`
    <h2>${isNew ? 'New chore' : 'Edit chore'}</h2>
    ${isNew ? `<div class="quick">${CHORE_PRESETS.filter((p) => !S.chores.some((x) => x.name === p.name)).map((p) => `<button class="chip" data-preset="${esc(p.emoji)}|${esc(p.name)}|${p.every}">${p.emoji} ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <div class="row"><input id="ce-emoji" class="emoji-in" value="${esc(c.emoji)}" maxlength="4" aria-label="Emoji"><input id="ce-name" placeholder="e.g. Wash bedsheets" value="${esc(c.name)}"></div>
    <label>Repeat every (days)<input type="number" id="ce-every" min="1" max="365" value="${c.every}"></label>
    <div class="quick">${[1, 2, 3, 7, 14, 30, 90].map((d) => `<button class="chip" data-every="${d}">${d === 1 ? 'Daily' : d === 7 ? 'Weekly' : d === 14 ? 'Fortnightly' : d === 30 ? 'Monthly' : d === 90 ? 'Quarterly' : `${d} days`}</button>`).join('')}</div>
    <label>Last done<input type="date" id="ce-last" value="${ymd(new Date(c.lastDone))}"></label>
    ${isNew ? '' : `<p class="hint">Done ${c.count || 0} time${c.count === 1 ? '' : 's'} with DadLife.</p>`}
    <div class="actions">${isNew ? '' : '<button class="btn danger ghost" data-del>Delete</button>'}<button class="btn" data-save>Save</button></div>`);
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.preset) { const [em, nm, ev] = t.dataset.preset.split('|'); $('#ce-emoji', sheet).value = em; $('#ce-name', sheet).value = nm; $('#ce-every', sheet).value = ev; }
    else if (t.dataset.every) $('#ce-every', sheet).value = t.dataset.every;
    else if ('del' in t.dataset) { if (confirm('Delete this chore?')) { S.chores = S.chores.filter((x) => x.id !== c.id); persist(); closeSheet(); render(); } }
    else if ('save' in t.dataset) {
      c.emoji = $('#ce-emoji', sheet).value || '✅';
      c.name = $('#ce-name', sheet).value.trim();
      c.every = Math.max(1, Math.min(365, parseInt($('#ce-every', sheet).value, 10) || 7));
      const ld = $('#ce-last', sheet).value;
      if (ld && ld !== ymd(new Date(c.lastDone))) {
        const d = new Date(ld + 'T12:00');
        c.lastDone = (ld === ymd(new Date()) ? new Date() : d).toISOString();
      }
      if (!c.name) { toast('Give it a name'); return; }
      const i = S.chores.findIndex((x) => x.id === c.id);
      if (i >= 0) S.chores[i] = c; else S.chores.push(c);
      persist(); closeSheet(); render(); toast('Chore saved');
    }
  });
}

// =============================================================== SETTINGS tab

function locRow(p, act, id = '') {
  return `<button class="row-btn loc" data-act="${act}" data-id="${id}">
    <span class="pe">${act === 'edit-home' ? '🏠' : '🏢'}</span>
    <span class="grow"><b>${esc(p.name || 'Unnamed')}</b><span class="muted small">${hasCoords(p) ? esc(p.address || `${(+p.lat).toFixed(4)}, ${(+p.lon).toFixed(4)}`) : '⚠️ Location not set — tap to choose'}</span></span>
    <span class="chev">›</span></button>`;
}

function settingsHtml() {
  const s = cfg();
  const placeOpts = (sel) => s.places.map((p) => `<option value="work:${p.id}" ${sel === `work:${p.id}` ? 'selected' : ''}>🏢 ${esc(p.name)}</option>`).join('');
  const t = s.taxi;
  return `<header class="top"><h1>Settings</h1></header>
  <h2 class="sec">Places</h2>
  <div class="card list">${locRow(s.home, 'edit-home')}${s.places.map((p) => locRow(p, 'edit-place', p.id)).join('')}
    <button class="row-btn add" data-act="add-place">＋ Add another work place</button></div>

  <h2 class="sec">Weekly schedule</h2>
  <div class="card list sched">${[1, 2, 3, 4, 5, 6, 0].map((d) => {
    const x = s.schedule[d], val = x.mode === 'work' ? `work:${x.placeId}` : x.mode;
    return `<div class="sched-row" data-day="${d}">
      <b>${DAYS[d]}</b>
      <select data-f="where">${placeOpts(val)}<option value="wfh" ${val === 'wfh' ? 'selected' : ''}>🏠 Work from home</option><option value="off" ${val === 'off' ? 'selected' : ''}>🎉 Day off</option></select>
      ${x.mode === 'work' ? `<span></span><label class="t">Start<input type="time" data-f="start" value="${esc(x.start)}"></label><label class="t">Finish<input type="time" data-f="end" value="${esc(x.end)}"></label>` : ''}
    </div>`;
  }).join('')}</div>

  <h2 class="sec">Commute preferences</h2>
  <div class="card form">
    <label>Headline option<select data-set="preferred">
      ${[['auto', 'Fastest available'], ['drive', 'I drive'], ['transit', 'Bus / train'], ['taxi', 'Taxi / ride-hail']].map(([k, l]) => `<option value="${k}" ${s.preferred === k ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <label>Arrive early by (minutes)<input type="number" min="0" max="60" data-set="bufferMin" value="${s.bufferMin}"></label>
  </div>

  <h2 class="sec">Taxi fare estimate</h2>
  <div class="card form grid2">
    <label>Currency<input data-taxi="currency" value="${esc(t.currency)}" maxlength="4"></label>
    <label>Flag-down<input type="number" step="0.1" data-taxi="flag" value="${t.flag}"></label>
    <label>Per km<input type="number" step="0.05" data-taxi="perKm" value="${t.perKm}"></label>
    <label>Per minute<input type="number" step="0.05" data-taxi="perMin" value="${t.perMin}"></label>
    <label>Pickup wait (min)<input type="number" step="1" data-taxi="waitMin" value="${t.waitMin}"></label>
  </div>

  <h2 class="sec">Live traffic & bus/train times</h2>
  <div class="card form">
    <p class="small">Without a key, DadLife estimates traffic from typical rush-hour patterns. For <b>live traffic</b>, <b>real bus & train timetables</b> and <b>taxi + train combos</b>, paste a Google Maps Platform API key with <b>Routes API</b> (and optionally <b>Places API (New)</b>) enabled. It stays on this device.</p>
    <label>Google Maps API key<input type="password" id="gkey" autocomplete="off" spellcheck="false" placeholder="AIza…" value="${esc(s.googleKey)}"></label>
    <div class="row"><button class="btn small ghost" data-act="show-key">Show</button><button class="btn small" data-act="test-key">Save & test</button></div>
    <div id="key-status" class="small">${googleError() ? `⚠️ ${esc(googleError())}` : ''}</div>
  </div>

  <h2 class="sec">Your data</h2>
  <div class="card form">
    <p class="small muted">Everything is stored only in this browser.</p>
    <div class="row wrap"><button class="btn small ghost" data-act="export">Export backup</button>
    <label class="btn small ghost file">Import backup<input type="file" id="import" accept="application/json" hidden></label>
    <button class="btn small danger ghost" data-act="reset">Reset everything</button></div>
  </div>
  <p class="hint center">DadLife · weather by Open-Meteo · maps © OpenStreetMap contributors</p>`;
}

function settingsChange(e) {
    const el = e.target;
    const row = el.closest('.sched-row');
    if (row) {
      const d = +row.dataset.day, x = cfg().schedule[d];
      if (el.dataset.f === 'where') {
        if (el.value.startsWith('work:')) { x.mode = 'work'; x.placeId = el.value.slice(5); } else x.mode = el.value;
        persist(); render(); return;
      }
      x[el.dataset.f] = el.value; persist(); return;
    }
    if (el.dataset.set) { cfg()[el.dataset.set] = el.type === 'number' ? +el.value : el.value; persist(); return; }
    if (el.dataset.taxi) { cfg().taxi[el.dataset.taxi] = el.dataset.taxi === 'currency' ? el.value : +el.value; persist(); return; }
    if (el.id === 'import' && el.files[0]) {
      el.files[0].text().then((txt) => {
        const data = JSON.parse(txt);
        if (!data.settings || !Array.isArray(data.chores)) throw new Error('Not a DadLife backup');
        S = { ...load(), ...data }; persist(); render(); toast('Backup restored');
      }).catch((err) => toast(`Import failed: ${err.message}`));
    }
}

// =============================================================== location picker

function pickLocation(initial = {}, title = 'Choose location') {
  return new Promise((resolve) => {
    let chosen = hasCoords(initial) ? { ...initial } : null;
    const sheet = openSheet(`
      <h2>${esc(title)}</h2>
      <label>Name<input id="lp-name" placeholder="e.g. Office, School" value="${esc(initial.name || '')}"></label>
      <form id="lp-form" class="row"><input id="lp-q" type="search" placeholder="Search address or place…" value="${esc(initial.address || '')}" enterkeyhint="search"><button class="btn small">Search</button></form>
      <button class="btn small ghost" data-here>📍 Use my current location</button>
      <div id="lp-res" class="results"></div>
      <div id="lp-chosen" class="small">${chosen ? `✓ ${esc(chosen.address || 'Location set')}` : ''}</div>
      <div class="actions"><button class="btn ghost" data-cancel>Cancel</button><button class="btn" data-ok>Use this place</button></div>`, () => resolve(null));
    let results = [];
    const showChosen = () => { $('#lp-chosen', sheet).innerHTML = chosen ? `✓ <b>${esc(chosen.address || 'Location set')}</b>` : ''; };
    $('#lp-form', sheet).addEventListener('submit', async (e) => {
      e.preventDefault();
      const box = $('#lp-res', sheet);
      box.innerHTML = '<div class="muted small">Searching…</div>';
      try {
        results = await searchPlaces($('#lp-q', sheet).value, cfg().googleKey);
        box.innerHTML = results.length
          ? results.map((r, i) => `<button class="row-btn" data-i="${i}"><span class="grow"><b>${esc(r.name)}</b><span class="muted small">${esc(r.address)}</span></span></button>`).join('')
          : '<div class="muted small">No matches — try adding the city or postcode.</div>';
      } catch (err) {
        box.innerHTML = `<div class="small bad">Search failed: ${esc(err.message)}</div>`;
      }
    });
    sheet.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.i !== undefined) {
        const r = results[+t.dataset.i];
        chosen = { address: r.address, lat: r.lat, lon: r.lon };
        if (!$('#lp-name', sheet).value) $('#lp-name', sheet).value = r.name;
        $$('.results .row-btn', sheet).forEach((b) => b.classList.toggle('on', b === t));
        showChosen();
      } else if ('here' in t.dataset) {
        t.textContent = 'Locating…';
        try {
          const p = await currentPosition();
          chosen = { ...p, address: (await reverseGeocode(p.lat, p.lon)) || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` };
          showChosen();
        } catch (err) { toast(err.message); }
        t.textContent = '📍 Use my current location';
      } else if ('cancel' in t.dataset) { closeSheet(); }
      else if ('ok' in t.dataset) {
        if (!chosen) { toast('Search and pick a place first'); return; }
        const out = { ...chosen, name: $('#lp-name', sheet).value.trim() || chosen.address.split(',')[0] };
        closeSheet(true); resolve(out);
      }
    });
  });
}

// =============================================================== sheet + toast

const sheets = []; // stack, so a picker can open on top of an editor
function openSheet(html, onCancel) {
  const el = document.createElement('div');
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div><div class="sheet-body">${html}</div></div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  const entry = { el, onCancel };
  sheets.push(entry);
  el.querySelector('[data-close]').addEventListener('click', () => closeSheet());
  return el;
}
function closeSheet(silent = false) {
  const top = sheets.pop();
  if (!top) return;
  top.el.remove();
  if (!silent && top.onCancel) top.onCancel();
}
const closeAllSheets = () => { while (sheets.length) closeSheet(); };

let toastT;
function toast(msg, action) {
  let el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}`;
  el.classList.add('show');
  if (action) el.querySelector('button').onclick = () => { action.fn(); el.classList.remove('show'); };
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2200);
}

// =============================================================== actions

const ACT = {
  goto: (el) => { location.hash = el.dataset.tab; },
  refresh: () => { location.reload(); },
  phase: (el) => {
    const now = new Date();
    S.override = el.dataset.phase === 'auto' ? null : { date: ymd(now), phase: el.dataset.phase };
    persist(); render();
  },
  'chore-done': (el) => {
    const c = S.chores.find((x) => x.id === el.dataset.id);
    const prev = { lastDone: c.lastDone, count: c.count };
    c.lastDone = new Date().toISOString(); c.count = (c.count || 0) + 1;
    persist();
    el.closest('.chore')?.classList.add('flash');
    setTimeout(render, 350);
    toast(`${c.emoji} ${c.name} — done! Next in ${c.every} day${c.every > 1 ? 's' : ''}`, {
      label: 'Undo', fn: () => { Object.assign(c, prev); persist(); render(); },
    });
  },
  'edit-chore': (el) => choreEditor(S.chores.find((x) => x.id === el.dataset.id)),
  'add-chore': () => choreEditor(null),
  'add-plan': () => planEditor(null),
  'edit-plan': (el) => planEditor(S.plans.find((x) => x.id === el.dataset.id)),
  'edit-home': async () => {
    const loc = await pickLocation(cfg().home, 'Home');
    if (loc) { cfg().home = { ...loc, name: loc.name || 'Home' }; persist(); render(); }
  },
  'edit-place': async (el) => {
    const p = cfg().places.find((x) => x.id === el.dataset.id);
    const loc = await pickLocation(p, 'Work place');
    if (loc) { Object.assign(p, loc); persist(); render(); }
    else if (cfg().places.length > 1 && !hasCoords(p) && confirm(`Remove “${p.name}”?`)) removePlace(p.id);
  },
  'add-place': async () => {
    const loc = await pickLocation({ name: '' }, 'New work place');
    if (loc) { cfg().places.push({ id: uid(), ...loc }); persist(); render(); }
  },
  swap: () => { [commuteView.from, commuteView.to] = [commuteView.to, commuteView.from]; render(); },
  cmode: (el) => { commuteView.mode = el.dataset.mode; render(); },
  'show-key': (el) => { const i = $('#gkey'); i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? 'Show' : 'Hide'; },
  'test-key': async () => {
    cfg().googleKey = $('#gkey').value.trim(); persist();
    const st = $('#key-status');
    if (!cfg().googleKey) { st.textContent = 'Key removed — using estimates.'; return; }
    const a = hasCoords(cfg().home) ? cfg().home : { lat: 51.5007, lon: -0.1246 };
    const b = { lat: +a.lat + 0.02, lon: +a.lon + 0.02 };
    st.textContent = 'Testing…';
    const r = await planTrip(a, b, { departAt: new Date(), settings: cfg() }).catch((e) => ({ note: e.message }));
    st.innerHTML = r.live ? '✅ Live traffic working.' : `⚠️ ${esc(r.note || googleError() || 'Key did not work')}`;
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ ...S, settings: { ...S.settings, googleKey: '' } }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `dadlife-backup-${ymd(new Date())}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  reset: () => { if (confirm('Erase all places, plans and chores on this device?')) { S = reset(); persist(); render(); } },
};

function removePlace(id) {
  cfg().places = cfg().places.filter((x) => x.id !== id);
  for (const d of Object.values(cfg().schedule)) if (d.placeId === id) { d.placeId = cfg().places[0]?.id; }
  persist(); render();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); ACT[el.dataset.act](el, e); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'c-from') { commuteView.from = e.target.value; render(); }
  if (e.target.id === 'c-to') { commuteView.to = e.target.value; render(); }
  if (e.target.id === 'c-time') { commuteView.time = e.target.value; render(); }
  if (tab === 'settings') settingsChange(e);
});

// =============================================================== router

const VIEWS = {
  today: { html: todayHtml, after: todayAfter },
  commute: { html: commuteHtml, after: commuteAfter },
  plans: { html: plansHtml, after: plansAfter },
  chores: { html: choresHtml },
  settings: { html: settingsHtml },
};

/** Render the current tab. `soft` builds off-screen and swaps in when ready (no flicker). */
async function render({ soft = false } = {}) {
  if (!VIEWS[tab]) tab = 'today';
  const tok = ++token, now = new Date(), v = VIEWS[tab];
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${tab}`));
  const due = S.chores.filter((c) => choreStatus(c, now).diff <= 0).length;
  const badge = $('#chore-badge');
  badge.textContent = due || ''; badge.hidden = !due;

  const view = $('#view');
  const root = soft ? document.createElement('div') : view;
  root.innerHTML = v.html(now);
  const fills = v.after ? v.after(root, tok, now) : [];
  if (soft) {
    await Promise.race([Promise.allSettled(fills), new Promise((r) => setTimeout(r, 6000))]);
    if (tok !== token) return;
    view.replaceChildren(...root.childNodes);
  } else {
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', () => { tab = location.hash.slice(1) || 'today'; closeAllSheets(); render(); });

// Refresh countdowns every minute (only when nothing is being edited).
setInterval(() => {
  if (document.hidden || $('.sheet-wrap') || ['settings'].includes(tab)) return;
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  render({ soft: true });
}, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && tab !== 'settings' && !$('.sheet-wrap')) render({ soft: true }); });

render();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
