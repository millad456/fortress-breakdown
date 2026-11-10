# Fortress Breakdown

Interactive 3D breakdowns of the world's great fortifications, built with [three.js](https://threejs.org) and Vite.

**First fortress: the Old City of Dubrovnik.** A fully procedural 3D reconstruction of the walls — Minčeta, Bokar, St John, Revelin, Lovrijenac, both gates, the moat and outer wall, the Old Port with its breakwaters, ~1,200 terracotta roofs, Mount Srđ and Lokrum — with five ways to read it:

| Mode | What it shows |
| --- | --- |
| **Explore** | Fly around, click glowing markers for the story of each work, its defensive logic, how it fared under fire, trivia and real photographs (Wikimedia Commons). |
| **Anatomy** | Wall-thickness heat map (4–6 m land front vs 1.5–3 m sea walls), city faded out, annotated cross-section of moat → outer wall → main wall. |
| **Fields of fire** | Animated arcs of fire from every fort showing how each approach is covered twice, plus the harbour chain. |
| **Timeline** | Scrub from 700 AD to today and watch the circuit grow: square Minčeta → round Minčeta, Bokar, outer wall, Kaše, Revelin, Fort Imperial… |
| **Sieges** | Replay the Saracen siege of 866–867 (fleets), the Russian–Montenegrin bombardment of 1806 and the JNA siege of 1991–92 (shelling, fires, the 6 December climax, damaged roofs → new tiles). |

Plus a cinematic intro, a guided tour, and a time-of-day slider (press **N** for night: the walls floodlit, windows lit, stars out).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

Visual QA (headless screenshots into `shots/`): `npm i -D playwright && npx playwright install chromium && node scripts/shots.mjs`

## Structure

```
src/
  main.js                 hash router: landing page + viewer
  app/
    engine.js             renderer, sky/sun, lights, post-processing, camera flights
    viewer.js             mounts a fortress into the engine
    ui.js                 hotspots, side panel, mode dock, timeline, sieges, tour, intro
    terrain.js            centre-dense terrain mesh builder
    water.js              Adriatic water shader (depth tint, fresnel, glitter, foam)
    siegefx.js            shells, smoke, fires, scorch marks, fleets
    ambient.js            gulls, boats, clouds, flags, night lights
    textures.js           procedural canvas textures (limestone, tiles, facades…)
    geom.js / noise.js    helpers
  fortresses/
    index.js              registry (add new fortresses here)
    dubrovnik/
      layout.js           coordinates of every wall, tower, fort and landmark
      terrain.js          height field + ground colouring
      build.js            builds the 3D world
      modes.js            anatomy / fields of fire / timeline / siege orchestration
      content.js          all text, stats, timeline, sieges, tour, photo references
      index.js            fortress module entry
```

## Adding a fortress

Create `src/fortresses/<id>/` with a `content.js` (same schema as Dubrovnik's) and an `index.js` exporting `{ content, build(engine, onProgress) → world }`, then register it in `src/fortresses/index.js`. The engine, UI, siege FX and ambient modules are fortress-agnostic.

## Notes

- Geometry is a stylised reconstruction derived from historical plans and real positions — not survey data.
- Photographs are loaded live from Wikimedia Commons under their stated licences, with credits shown.
- Deploys to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
