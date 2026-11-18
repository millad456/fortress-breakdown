# Fortress Breakdown

Interactive 3D breakdowns of the world's great fortifications, built with [three.js](https://threejs.org) and Vite.

**First fortress: the Old City of Dubrovnik.** A 3D reconstruction built on the real ground plan from OpenStreetMap: the wall circuit, towers, ~1,400 building footprints and the coastline are surveyed, with heights, terrain and detail modelled procedurally. It covers the walls — Minčeta, Bokar, St John, Revelin, Lovrijenac, both gates, the moat and outer wall, the Old Port with its breakwaters, the terracotta roofscape, Mount Srđ and Lokrum — with five ways to read it:

| Mode | What it shows |
| --- | --- |
| **Explore** | Fly around; hover a tower, gate or wall to light up its 3D model, click it for the story of each work, its defensive logic, how it fared under fire, trivia and real photographs (Wikimedia Commons). |
| **Anatomy** | Wall-thickness heat map (4–6 m land front vs 1.5–3 m sea walls), city faded out, annotated cross-section of moat → outer wall → main wall. |
| **Fields of fire** | The ground each fort, wall tower and outer bastion can really reach, computed from the plan (stopping at the town and at rising ground), plus the harbour chain. |
| **Timeline** | Scrub from 700 AD to today and watch the circuit and the town inside it grow: square Minčeta → round Minčeta, Bokar, outer wall, Kaše, Revelin, Fort Imperial; the 1667 earthquake and rebuilding; the sieges of 866, 1806 and 1991 staged as dioramas. |
| **Sieges** | Replay the Saracen siege of 866–867 (fleets), the Russian–Montenegrin bombardment of 1806 and the JNA siege of 1991–92 (shelling, fires, the 6 December climax, damaged roofs → new tiles). |

Plus a short cinematic intro, a hideable list of places (**L**), a guided tour, and a time-of-day slider (press **N** for night: the walls floodlit, windows lit, stars out).

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
      data/geo.json       surveyed geometry (walls, towers, footprints, coast) derived from OpenStreetMap
      layout.js           the circuit, towers, forts, landmarks and camera poses in a local metric frame
      terrain.js          height field + ground colouring
      build.js            builds the 3D world
      modes.js            anatomy / fields of fire / timeline / siege orchestration
      content.js          all text, stats, timeline, sieges, tour, photo references
      index.js            fortress module entry
```

## Adding a fortress

Create `src/fortresses/<id>/` with a `content.js` (same schema as Dubrovnik's) and an `index.js` exporting `{ content, build(engine, onProgress) → world }`, then register it in `src/fortresses/index.js`. The engine, UI, siege FX and ambient modules are fortress-agnostic.

## Made with

Built with Anthropic's Claude in Claude Code: **Claude Fable 5.1** wrote the first version; **Claude Fable 5.2** rebuilt it on OpenStreetMap geometry and added the new intro, model highlighting, the living timeline with siege dioramas and the computed fields of fire; **Claude Opus 5.5** prepared the release and the rebuild spec in [docs/rebuild-spec.md](docs/rebuild-spec.md).

## Notes

- Plan geometry (walls, towers, building footprints, coastline) is © OpenStreetMap contributors, ODbL. Heights and terrain are modelled, not surveyed.
- To refresh the map data: `node scripts/fetch-osm.mjs && node scripts/build-geo.mjs` (the raw download is cached in `scripts/cache/`, git-ignored; `data/geo.json` is committed).
- Photographs are loaded live from Wikimedia Commons under their stated licences, with credits shown.
- Deploys to GitHub Pages via `.github/workflows/deploy.yml` on push to `main`.
