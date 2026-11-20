// Persistent state (kept on this device in localStorage).
import { uid } from './util.js';

const KEY = 'dadlife.v1';
const DAY = 864e5;

const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

export const CHORE_PRESETS = [
  { emoji: '🛏️', name: 'Wash bedsheets', every: 7 },
  { emoji: '🗑️', name: 'Take out the bins', every: 2 },
  { emoji: '🚽', name: 'Clean toilets', every: 7 },
  { emoji: '🪟', name: 'Clean windows', every: 30 },
  { emoji: '🧹', name: 'Vacuum & mop floors', every: 3 },
  { emoji: '🧺', name: 'Wash towels', every: 5 },
  { emoji: '🧊', name: 'Clean out the fridge', every: 14 },
  { emoji: '🌀', name: 'Dust fans & air-con filters', every: 30 },
  { emoji: '🪴', name: 'Water the plants', every: 3 },
  { emoji: '🧸', name: 'Wash kids’ soft toys', every: 30 },
];

function defaults() {
  const schedule = {};
  for (let d = 0; d < 7; d++) {
    schedule[d] = { mode: d === 0 || d === 6 ? 'off' : 'work', placeId: 'work1', start: '09:00', end: '18:00' };
  }
  return {
    version: 1,
    onboarded: false,
    settings: {
      home: { name: 'Home', address: '', lat: null, lon: null },
      places: [{ id: 'work1', name: 'Office', address: '', lat: null, lon: null }],
      schedule,
      preferred: 'auto', // auto | drive | transit | taxi
      bufferMin: 10,
      googleKey: '',
      taxi: { currency: '$', flag: 4.0, perKm: 0.7, perMin: 0.25, waitMin: 6 },
    },
    plans: [
      { id: uid(), emoji: '🎒', title: 'Pick up the kids', time: '17:45', days: [1, 2, 3, 4, 5], date: null,
        place: { name: 'School', address: '', lat: null, lon: null }, enabled: true },
    ],
    chores: [
      ['🛏️', 'Wash bedsheets', 7, 4],
      ['🗑️', 'Take out the bins', 2, 1],
      ['🚽', 'Clean toilets', 7, 7],
      ['🪟', 'Clean windows', 30, 12],
      ['🧹', 'Vacuum & mop floors', 3, 3],
      ['🧺', 'Wash towels', 5, 2],
    ].map(([emoji, name, every, ago]) => ({ id: uid(), emoji, name, every, lastDone: daysAgo(ago), count: 0 })),
    override: null, // { date: 'YYYY-MM-DD', phase }
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaults();
      // shallow-merge so new settings keys get defaults
      s.settings = { ...d.settings, ...s.settings, taxi: { ...d.settings.taxi, ...(s.settings?.taxi || {}) } };
      s.plans ||= [];
      s.chores ||= [];
      return s;
    }
  } catch (e) {
    console.warn('Could not read saved data', e);
  }
  return defaults();
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save', e);
  }
}

export function reset() {
  localStorage.removeItem(KEY);
  return defaults();
}
