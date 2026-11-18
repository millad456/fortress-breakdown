# Build spec: an interactive 3D breakdown of the walls of Dubrovnik

You are building a website, from scratch, that lets anyone explore the fortifications of Dubrovnik (Croatia) in 3D in the browser: what each wall, tower and fort is, how they defended each other, how the city grew, and how it fared in its sieges. This document is the whole brief. Read it to the end before writing code, then work through the task list in section 10 in order.

Work autonomously. Make sensible decisions where this spec is silent and note them in the README. After each phase, check your work by looking at screenshots of the running site (section 9). Do not treat a phase as done because the code compiles.

---

## 1. Product goals

1. **Accurate plan, stylised look.** The ground plan (wall line, towers, forts, every building footprint, coastline, breakwater) comes from real survey data (OpenStreetMap). Heights, terrain, textures and detail are modelled procedurally. Someone who knows Dubrovnik should recognise it from the air.
2. **Explain the defences, not just show them.** Every major work has a story, its defensive logic, what happened to it under fire, and real photographs.
3. **Make history visible.** A timeline grows the walls *and* the town inside them, and stages the city's major sieges as 3D dioramas.
4. **Feel cinematic but stay usable.** A short, striking intro; clean UI that never covers itself; 60 fps on a mid-range laptop.
5. **Extensible.** The engine and UI know nothing about Dubrovnik. A second fortress is a new folder of data and content.

## 2. Tech constraints

- **three.js** (r170 or similar) + **Vite**, plain JavaScript ES modules, no UI framework. Only runtime dependency: `three` (and its `examples/jsm` addons).
- Static site: `npm run build` produces `dist/`, deployed to **GitHub Pages** by a GitHub Actions workflow on push to `main`. Use `base: './'` in Vite so it works under a project subpath.
- Geometry data is fetched **once, offline**, by a Node script, and committed as a compact JSON file. The site never calls the OpenStreetMap APIs at runtime.
- Photos load live from Wikimedia Commons (`Special:FilePath/<file>?width=N`), with credit and licence shown under each.
- Dev tooling: Playwright for headless screenshots (prefer the system Chrome, `channel: 'chrome'`, with SwiftShader WebGL flags; fall back to bundled Chromium).
- Credit OpenStreetMap (ODbL) in the README and the site.

## 3. The experience, end to end

1. **Landing page** (`#/`): title, one card per fortress (Dubrovnik live; a few "coming soon" cards are fine).
2. **Loading** (`#/dubrovnik`): a progress bar with themed step labels ("Quarrying limestone", "Raising the walls", ...). The scene builds in under ~3 s on a laptop.
3. **Intro (about 10–12 s, skippable).** The camera starts low over the sea at dawn, skims towards the sea walls, climbs the cliff, sweeps across the roofs to Minčeta, then pulls back to the overview. A wide lens (FOV ~64°) eases to the normal lens (~46°); the sun rises during the approach. Title, coordinates and tagline animate in; "Explore the walls" and "Skip intro" buttons. **No labels, list or toolbar appear until the intro ends.** It should feel faster and more dramatic than a slow orbit: arrive fast, settle slowly.
4. **Main view.** Top bar: brand, fortress name, mode tabs (Explore 1, Anatomy 2, Fields of fire 3, Timeline 4, Sieges 5), time-of-day slider, Guided tour button. Left: a **hideable** list of places (toggle button + `L` key; hidden by default on narrow screens). Right: a detail panel that slides in when a place is opened. Bottom centre: a "dock" card for the current mode.
5. **Layout rule: no UI element ever overlaps another.** When the left list is open, the dock and toast shift right of it; when the right panel is open, the dock shrinks to end before it. Labels in 3D never sit under the top bar. Check this at 1600×900, 1280×720 and 390×844.

## 4. Geometry and data

### 4.1 Coordinate frame
Local metric frame: **x = east, z = south, y = up, metres**, origin just inside the Pile Gate (≈ 42.64145 N, 18.10650 E). Convert lat/lon with an equirectangular approximation (`mPerLon = 111320·cos(lat0)`). Keep every number in the code in this frame.

### 4.2 Fetch (`scripts/fetch-osm.mjs`)
One Overpass API query (with a fallback endpoint), output to a git-ignored cache. Use a generic User-Agent. Query, for the old town bbox (roughly 42.636–42.650 N, 18.098–18.120 E) and a wider bbox for the coast and hills:
- `building` ways/relations; `historic=citywalls`, `barrier=city_wall|wall`; `historic=castle|fort|tower|city_gate`
- `natural=coastline`; `man_made=pier|breakwater`; `natural=wood|scrub|beach|cliff`, `landuse=forest`, `leisure=park|garden`
- streets (to get the Stradun / `Placa` axis); `natural=peak` and `place` nodes.

### 4.3 Derive (`scripts/build-geo.mjs` → `data/geo.json`, aim for under 200 kB)
- **Main wall ring.** The circuit is mapped as many separate `citywalls` ways. Stitch an explicit, ordered list of way IDs (some reversed) into one closed ring of the **outer face**, running clockwise from Pile Gate (north → east → south → west). Plot the candidates on a map image first, then hard-code the list. Simplify (Douglas–Peucker, ~0.7 m) and drop the overlapping last points at Pile.
- **Outer (scarp) wall.** The western stretch with its semicircular bastions is mapped; use it. The northern stretch is not; synthesise it by offsetting the land front ~14–19 m outward, and place semicircular bastions along it.
- **Towers and forts.** Footprints by OSM `name`: Minčeta (and its inner ring), Bokar, Puncjela, Sv. Barbara, Sv. Lucija, Sv. Vid, Drezvenik, Sv. Jakov, Asimon (Ploče inner gate), Sv. Luka, Sv. Ivan (St John), Sv. Spasitelj, Sv. Stjepan, Sv. Margarita, Sv. Petar (Mrtvo Zvono), Vrata od Pila, Vrata od Ploča, Revelin, Lovrijenac, Tvrđava Imperial.
- **Coastline → one land polygon.** Stitch the mainland coastline ways (east → west), simplify with tolerance growing with distance from town (0.6 m near, 14 m far), close it far inland. Lokrum is its own closed coastline. Kaše breakwater is its own polygon.
- **Buildings.** Every footprint within ~1 km of town: simplified ring, `i: 1` if its centroid is inside the wall ring, `k: 'church'` for churches and chapels, `n` = name, `l` = `building:levels`.
- **Green areas and beaches** (for tree scatter and sand colour), the Stradun axis, and named points (Srđ summit, the cross, Porporela, Fort Royal on Lokrum).

### 4.4 Terrain (`heightAt(x, z)`)
Use spatial indexes (chunked edges with bounding boxes) for distance-to-coast and point-in-ring queries, so 360k samples take under 0.5 s.
- **Sea:** depth grows with distance from shore; the Old Port is shallow and flat; Lokrum rises to ~96 m around Fort Royal.
- **Inside the walls:** the Stradun is the low filled channel at ~3–4 m; the north side climbs ~27 m towards Minčeta; the south-west climbs to the cliff-top sea walls; the south-east stays at harbour level. Almost no noise inside.
- **Mainland:** rises from the shore to the Srđ crest (412 m, about 1 km north) along a ridge polyline, then falls inland. Rugged noise grows with distance from the walls.
- Cliffs: steep rise under the sea walls and Lovrijenac, gentle ramp at Banje beach. A 37 m rock under Lovrijenac. A dry moat ~4.5 m deep between the land walls and the outer wall. Quays and moles of the Old Port stand just above the water.
- Vertex colour by height, slope, beaches, moat and town ground.

## 5. Building the scene

- **Walls.** Extrude the ring inward by thickness per side: land 5.5 m / west 4.5 m / harbour 3 m / sea 2.4 m (the real ranges, 4–6 m and 1.5–3 m, go in the text). Crest height = ground outside + side height (land ~20 m, sea ~14 m), never lower than the lanes behind it, smoothed. Outer parapet, inner kerb, instanced merlons along the outer edge, one mesh per side.
- **Towers on the circuit:** extrude the surveyed footprint from below ground to just above the wall walk. Towers rise 4–6 m with loopholes; low bastions sit level with the walk. Merlons round every rim.
- **Specific works:**
  - **Minčeta:** a broad drum on its footprint, a tall round tower, a machicolation band, a wider crowned top with blind arches. A hidden square tower for the 1319 phase of the timeline.
  - **Bokar:** a casemated horseshoe on its footprint with embrasures on the seaward faces, plus a round upper tier (a separate object, so the timeline can add it in 1570).
  - **St John:** the whole surveyed footprint as one massive fort, two rows of embrasures towards the sea and the harbour mouth, plus a hidden 1346 tower at the tip.
  - **Revelin:** the surveyed footprint, cordon, inner raised tier, embrasures.
  - **Lovrijenac:** three stepped tiers on the rock, embrasures facing the sea.
  - **Pile:** a round outer barbican on its footprint, a three-arch stone bridge, a dark gate passage. **Ploče:** two bridges, an outer gate, a passage through Asimon.
  - **Old Port:** Kaše breakwater, Porporela mole with a green light, an arsenal with three arches.
  - **Lazareti:** five long halls east of Ploče. **Fort Imperial** on Srđ.
- **Town inside the walls, from real footprints:** rectangular plots (minimum-area bounding box fill > 0.8) become instanced houses, cut into house-width units along terraces, each with its own gable roof. Irregular plots become extruded facades with a hipped roof (merge them per century). Churches become stone bodies with hipped roofs; named monuments get domes (Cathedral, St Blaise) and bell towers (Franciscan, Dominican). Add the City Bell Tower, Orlando's Column, Onofrio's Fountain and a paved Stradun and Luža.
- **Outside the walls:** one simple house per footprint, plainer and slightly greyer than the old town.
- **Trees:** dense forest on Lokrum, the mapped woods and parks, scrub on the Srđ slopes. Never on a building.
- **Water:** custom shader with a baked depth texture (shallow tint, fresnel, sun glitter, foam).
- **Ambient:** gulls, moored and cruising boats, clouds, Libertas flags on the forts, night lights along the walls and Stradun.
- **Lighting:** sky model, sun with shadows, hemisphere light, bloom, light grain. Time of day 05:00–23:00 drives the sun, sky, fog and emissive windows; at night the walls are floodlit and stars show.

## 6. Interaction

- **Labels:** one small text tag per place in 3D (no dots), hidden when occluded by terrain or walls (raycast against colliders every few frames), smaller when far.
- **Highlighting the actual model, not a marker.** Hovering a list item, a label or **the 3D model itself** makes that place's model glow (an emissive copy of its materials, with a flash on select and then a slow pulse). Clicking the model opens it. The selection stays lit while its panel is open. Map each place to its meshes: forts → their groups; Pile → barbican + bridge; land walls → land wall mesh + its towers; sea walls → sea and west walls + their towers; Old Port → Kaše, arsenal, harbour wall and towers; Stradun → paving, bell tower, column, fountain. Only places with no model of their own (Lokrum) fall back to a pulsing ground ring.
- **Detail panel:** era, title, subtitle, stat tiles, photo gallery with lightbox, "The story", "How it worked", "Under fire", "Did you know", Wikipedia link, "Fly here again".
- Camera flights with an arc, an ease and per-place poses. Double-click the ground to fly there.
- Keyboard: `1`–`5` modes, `N` toggles night, `L` toggles the list, `Esc` closes, arrows step the tour.

## 7. Modes

1. **Explore:** default.
2. **Anatomy:** walls coloured by thickness class (land / west / harbour / sea / outer / thick forts); buildings faded to ~12% opacity; suburbs and trees hidden; a dock card with a legend and an SVG cross-section (attacker → outer wall → dry moat → main wall → town).
3. **Fields of fire:** the ground each work can *really* cover, computed from the plan rather than hand-drawn sectors. For each gun position, cast rays every 3° out to its range and stop each ray at the first point inside the town ring, or where the ground rises above the guns (the guns can elevate a little: allow `gunY + 6 + 0.22·distance`). Draw a terrain-hugging fan over the reachable ground with an animated pulse.
   - Ranges: forts 260–420 m; **every tower and bastion on the circuit** ~150–170 m, in one shared colour and fainter; **every outer-wall bastion** ~120 m in its own colour.
   - Add the harbour chain as a dashed line. Use a high camera so the town is not seen through the fans.
   - **Acceptance:** no fan covers any point inside the walls; every bastion has a fan.
4. **Timeline (700 AD → today):**
   - Structures appear in their construction year and glow for about 35 years after (Minčeta square 1319 → round 1464, St John tower 1346 → fort 1557, Bokar 1461 / complete 1570, outer wall 1470, Pile bridge 1471, Kaše 1485, Revelin 1551, Lazareti 1647, Fort Imperial 1812).
   - **The town updates too.** Every house gets a construction year: the rocky south (old Laus) from ~690–1130, the slope north of the Stradun from ~1140–1350, churches and monuments at their own dates, the town outside the walls from the 19th century outward. These dates are a modelled estimate; say so.
   - In **1667** (the earthquake) about 70% of houses become low, smoke-blackened shells and are rebuilt one by one over ~1669–1715. In **1991** the roofs that were hit go dark; from 1996 they are relaid in bright new tile, which weathers back to normal by ~2015.
   - **Siege markers** on the slider (⚔ sieges, ✦ disasters): 866, 1667, 1806, 1991. Scrubbing into a window around one, clicking its marker, or reaching it in Play flies the camera to a set pose and **stages that event as a looping diorama**:
     - 866: the galley fleet ringing the islet, a relief fleet on the horizon.
     - 1806: cannon fire from Srđ.
     - 1991: shelling from the hills, gunboats, fires, damaged roofs.
     - 1667: fires breaking out across the fallen town.
   - A card shows the event and a "Watch the full replay" button that jumps to Sieges mode. Play pauses ~8 s on each diorama, and moves slower through dense building periods.
5. **Sieges:** full replays with a progress bar, pause/stop, story beats and stat chips. Use instanced low-poly galleys and warships, shells with flight time, trails, flashes, smoke, fires and scorch marks, aimed at random points inside the town.
   - **Saracen siege 866–867:** 36 Aghlabid ships, 15 months; ~100 Byzantine ships lift it.
   - **Russian–Montenegrin bombardment 1806:** about 3,000 cannonballs from Srđ; Fort Imperial follows.
   - **JNA siege 1991–92:** began 1 October; the climax on 6 December (600+ shells on the Old Town); ~56% of buildings damaged; 82–88 civilians killed.
6. **Guided tour:** about 13 stops that switch modes and fly the camera:
   - overview → land walls (anatomy) → Minčeta → Pile and Bokar → Lovrijenac → sea walls → harbour → Revelin → fields of fire
   - → "the fifth wall" (diplomacy and tribute) → 6 April 1667 (timeline) → December 1991 (siege) → today.

## 8. Content model (one file per fortress)

`meta` (name, country, coords, tagline, summary), `features[]` (id, name, subtitle, kind: tower|fort|gate|wall|place, era, builders, stats[{label,value}], description, howItWorked, underFire, trivia[], photos[{file, credit, license}], wiki), `timeline[]` ({year, label, text, structures[], optional siege id + window [from,to], disaster flag}), `sieges[]` ({id, name, years, attacker, summary, outcome, stats[], beats[{t 0..1, title, text}]}), `tour[]`, `sources[]`.

The 15 features: Minčeta Tower, Fort Bokar, Fort Lovrijenac, St John's Fortress, Revelin, Pile Gate, Ploče Gate, Outer Wall + Bastions + Moat, the Land Walls, the Sea Walls, Old Port + Kaše, Stradun, Mount Srđ + Fort Imperial, Lokrum, Lazareti.

Baseline facts (check each against a source and cite sources in `sources[]`):
- **Circuit:** 1,940 m, up to 25 m high; land walls 4–6 m thick; sea walls 1.5–3 m.
- **Minčeta:** square tower 1319, round rebuild 1461–1464 (Michelozzo, then Juraj Dalmatinac), up to 6 m thick.
- **Bokar:** 1461–1570, among the oldest preserved casemate forts in Europe.
- **Lovrijenac:** recorded 1301, on a 37 m rock; seaward walls up to 12 m thick, the city-facing wall ~60 cm.
- **St John:** first tower 1346, unified 1552–1557.
- **Revelin:** 1462, rebuilt 1538–1551.
- **Port and bridges:** Pile bridge 1471, Kaše breakwater 1485.
- **Lazareti and quarantine:** quarantine law 27 July 1377, the Lazareti complex 1590–1640s.
- **Disasters, sieges and recognition:** earthquake 6 April 1667 (~2,000 dead in the city); Republic abolished 1808; UNESCO listing 1979; on the World Heritage in Danger list 1991–1998.

## 9. Quality bar and verification

- A Playwright script (`scripts/shots.mjs`) loads the site headless, waits for `window.__fb.world` (expose `{engine, world, ui}` as a debug hook), skips the intro, and **sets camera poses directly** (headless WebGL runs at a few fps, so do not wait for animated flights). It steps the siege simulation by hand.
- It saves:
  - the overview and a top-down plan;
  - every place's camera pose;
  - every mode, plus the layout with list and panel open together;
  - a highlighted model, with and without the list;
  - the timeline at 1000, 1200, 1667 and 1690;
  - each diorama, night, morning, Lokrum and Srđ.
- It must print "Console issues: none".
- After every phase, look at the screenshots and fix what looks wrong: overlapping UI, floating or buried models, labels under the top bar, water on land, fans over the town. Compare the top-down plan with the OSM plan; they should match.
- **Performance:** instance everything repeated (houses, roofs, merlons, trees, ships); merge static meshes per material; target 60 fps on integrated graphics at 1080p, and a `medium` quality tier for phones.
- **Accessibility:** visible keyboard focus, readable text contrast over the scene (glass panels with blur), `prefers-reduced-motion` shortens the intro.

## 10. Task list

Do these in order. Each ends with a check you must pass.

- [ ] **T1 Scaffold.** Vite + three, landing page, hash router, viewer shell with loading screen, GitHub Pages workflow.
  *Check:* `npm run build` works; the landing page renders.
- [ ] **T2 Engine.** Renderer, sky and sun, shadows, bloom, fog, orbit controls with limits, `flyTo` and `flyPath` (with `onProgress`), time of day, CSS2D label layer, update registry.
  *Check:* an empty scene renders at any hour.
- [ ] **T3 Data pipeline.** `fetch-osm.mjs` and `build-geo.mjs`; plot the stitched ring over the OSM buildings and check every tower sits on it.
  *Check:* `geo.json` under 200 kB; the ring is closed, clockwise and runs through all 16 named towers.
- [ ] **T4 Terrain and water.** Indexed `heightAt`, `colorAt`, terrain mesh denser at the centre, depth-baked water, Lokrum.
  *Check:* spot heights are plausible (Stradun ~4 m, under Minčeta ~30 m, Srđ ~410 m, harbour < 0); 360k samples in < 0.5 s.
- [ ] **T5 Walls and works.** Wall ring, parapets, merlons, every tower and fort in section 5, outer wall and moat, bridges, gates, port, Lazareti, Fort Imperial.
  *Check:* each work sits on its footprint, nothing floats or sinks, and every fort is recognisable in its close-up shot.
- [ ] **T6 Town.** Houses from footprints (terraces cut into units), irregular blocks, churches with domes and bell towers, landmarks, suburbs, trees off buildings.
  *Check:* the top-down plan matches the OSM street pattern.
- [ ] **T7 Content.** All 15 features, timeline, three sieges, tour and sources, with real photos.
  *Check:* every panel fills; no broken images.
- [ ] **T8 UI shell.** Top bar, tabs, hideable list (`L`), detail panel, dock, toast, and the overlap rules from section 3.
  *Check:* screenshots at three sizes with the list and panel open show no overlap.
- [ ] **T9 Model highlighting.** Feature → mesh map, glow on hover and selection, raycast picking on the canvas, labels without dots.
  *Check:* every place lights up its own model; Lokrum shows the ring.
- [ ] **T10 Anatomy.**
  *Check:* the colours match the legend and the town is faded.
- [ ] **T11 Fields of fire, computed.**
  *Check:* the programmatic test that no fan triangle covers a point inside the walls passes; every bastion has a fan.
- [ ] **T12 Siege engine.** Fleets, shells, impacts, roof damage and repair, three scenarios with beats.
  *Check:* each replay runs start to finish with no console errors.
- [ ] **T13 Timeline.** Structures by year, the town by year, the 1667 ruins and rebuilding, the 1991 roofs, siege markers, dioramas with set camera poses, Play with holds.
  *Check:* screenshots at 1000, 1200, 1667, 1690 and each diorama.
- [ ] **T14 Intro.** The 10–12 s flight from section 3 with the lens and dawn change; UI hidden until it ends; skip works.
  *Check:* three mid-intro screenshots look composed, not empty sea or a wall in the face.
- [ ] **T15 Tour, night, ambient polish.**
  *Check:* the night shots show floodlit walls and lit windows.
- [ ] **T16 Release.** README with structure, the data refresh commands, OSM and photo credits, and the models or people who built it; push to `main`; Pages deploys.
  *Check:* the live URL loads.

## 11. Pitfalls already found (avoid them)

- OSM wall ways overlap and run in both directions; stitch from an explicit ordered list and check the result visually, never by guessing from connectivity alone.
- Naive point-to-polygon distance over a detailed coastline is far too slow per terrain vertex: index it.
- Footprint winding is mixed. Decide face orientation per polygon from its signed area, or walls render inside out.
- Do not spread hand-placed coordinates through the code. Put every anchor point in one `layout.js` derived from the data, or a change of frame breaks things silently.
- Hand-drawn fire sectors are wrong as soon as the geometry is real. Compute them.
- When replacing material on highlight, remember and restore the original materials; mode changes (anatomy, timeline glow) also swap materials, so lift the highlight, apply the change, then re-apply it.
- Headless WebGL is slow; animated flights never finish in screenshots, so pose the camera directly.
- Bulk-editing JS with shell `sed` mangles `$` and `$$`. Use real edits.
