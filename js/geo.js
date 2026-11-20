// Address search. Uses Google Places (if a key is set) or OpenStreetMap Nominatim.
import { fetchJson } from './util.js';

export async function searchPlaces(q, googleKey) {
  q = q.trim();
  if (!q) return [];
  if (googleKey) {
    try {
      const j = await fetchJson('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': googleKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({ textQuery: q, pageSize: 6 }),
      });
      const res = (j.places || []).map((p) => ({
        name: p.displayName?.text || '', address: p.formattedAddress || '',
        lat: p.location.latitude, lon: p.location.longitude,
      }));
      if (res.length) return res;
    } catch (e) {
      console.warn('Google place search failed, falling back to OpenStreetMap', e);
    }
  }
  const j = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`,
    { headers: { 'Accept-Language': navigator.language || 'en' } },
  );
  return j.map((x) => ({
    name: x.name || x.display_name.split(',')[0], address: x.display_name, lat: +x.lat, lon: +x.lon,
  }));
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      (e) => reject(new Error(e.message || 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

export async function reverseGeocode(lat, lon) {
  try {
    const j = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
    return j.display_name || '';
  } catch {
    return '';
  }
}
