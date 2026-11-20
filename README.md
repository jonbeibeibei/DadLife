# DadLife

A mobile web app for parents who commute — everything that matters today, at a glance.

- **Commute to work** — home address plus a different work place per weekday (or WFH / day off), with start and finish times for each day. You get a big **"Leave by"** time and a countdown.
- **Traffic and weather** — traffic level for your departure time, a chart of driving time against departure time, and an hourly forecast with tips for parents (umbrellas for pick-up, water bottles on hot days, sunscreen when UV is high, jackets when it's cold).
- **Commute options** — drive, taxi or ride-hail (with a fare estimate), bus, train, bus + train, **taxi + train** (take a cab to the station, then the train), and walking for short trips. Options are recalculated for the time of day.
- **Leave work on time** — add plans like *"Pick up the kids, 5:45pm, school"* or *"Dinner, 7:30pm, restaurant"*. These can repeat weekly or happen once. DadLife works out the latest time to leave work for each one.
- **Chore countdowns** — recurring chores (bedsheets, bins, toilets, windows…) with countdowns, overdue alerts, one-tap ✓ done and undo.

The app is set up automatically by time of day: **Heading out** (before work) → **At work** → **At home** (with a preview of tomorrow's commute). You can override it with the toggle on the Today screen.

## Live data

| Feature | Without a key (free) | With a Google Maps key |
|---|---|---|
| Weather | Open-Meteo (live) | same |
| Driving time | OpenStreetMap routing + rush-hour model + rain slow-down | **Live traffic** (Google Routes API) |
| Bus / train | Rough estimate + link to Google Maps | **Real timetables, lines, stops, fares** |
| Taxi + train | Rough estimate | Real station, train, and taxi leg |
| Address search | OpenStreetMap Nominatim | Google Places (finds schools, restaurants by name) |

To turn on live data, create a key in Google Cloud Console and enable the **Routes API** (and, if you want, **Places API (New)**). Restrict the key to your site's URL (HTTP referrer). Paste it into **Settings → Live traffic**. The key is only stored in your browser.

## Run / install

It's a static site with no build step:

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

**Hosting on GitHub Pages:** go to the repo's *Settings → Pages* and set *Source* to **GitHub Actions**. The included workflow then deploys on every push to `main`. Open the site on your phone and choose **Add to Home Screen** to use it like an app (it works offline for chores and plans).

## Privacy

All places, plans, chores and the API key are stored in `localStorage` on your device only. Use **Settings → Export backup** to move your data to another phone.

## Code

```
index.html          app shell + tab bar
css/app.css         mobile-first styles (light/dark)
js/app.js           screens, day phases, plans, chores, settings
js/routing.js       commute options, traffic model, Google Routes integration
js/weather.js       Open-Meteo forecast + parent tips
js/geo.js           address search / current location
js/store.js         local storage + default chores
sw.js               offline cache
```
