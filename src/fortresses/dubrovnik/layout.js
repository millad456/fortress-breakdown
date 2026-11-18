// Spatial layout of Dubrovnik's Old City in a local metric frame.
// x = east, z = south, y = up, metres. Origin just inside Pile Gate (see scripts/fetch-osm.mjs).
// Walls, towers, building footprints and coastline come from OpenStreetMap (data/geo.json,
// © OpenStreetMap contributors, ODbL); heights and everything decorative are modelled by hand.
import geo from './data/geo.json' with { type: 'json' };
import { centroid, nearestIndex, offsetPolyline, pointInPolygon, dist2 } from '../../app/geom.js';

export const GEO = geo;

/** Main wall, outer face, as a closed ring running clockwise from Pile Gate (north -> east -> south -> west). */
export const RING = geo.ring;

/** Thickness (m) and height above outside ground (m) by wall side. Visual values; stats use real ranges. */
export const WALL_SPEC = {
  land:   { thickness: 5.5, height: 20, label: 'Land wall', real: '4–6 m thick' },
  west:   { thickness: 4.5, height: 17, label: 'West wall', real: '4–5 m thick' },
  harbor: { thickness: 3.0, height: 12, label: 'Harbour wall', real: '~3 m thick' },
  sea:    { thickness: 2.4, height: 14, label: 'Sea wall', real: '1.5–3 m thick' },
};

// Where each side of the circuit begins (index into RING).
const I_PLOCE = nearestIndex([426, -59], RING);   // Asimon tower / Ploče inner gate
const I_STJOHN = nearestIndex([485, 193], RING);  // seaward corner of Fort St John
const I_BOKAR = nearestIndex([-14, 55], RING);    // landward end of Fort Bokar
const I_MINCETA_A = nearestIndex([147, -158], RING), I_MINCETA_B = nearestIndex([174, -162], RING);

/** Side of the edge that starts at RING[i]. */
export function sideOfEdge(i) {
  if (i < I_PLOCE) return 'land';
  if (i < I_STJOHN) return 'harbor';
  if (i < I_BOKAR) return 'sea';
  return 'west';
}
export const SIDE_START = { land: 0, harbor: I_PLOCE, sea: I_STJOHN, west: I_BOKAR };

/** Land front (Pile -> Minčeta -> Ploče): carries the outer wall and the moat. */
export const LAND_WEST = RING.slice(0, I_MINCETA_A + 1);
export const LAND_NORTH = RING.slice(I_MINCETA_B, I_PLOCE + 1);

/** Outer (scarp) wall. West: the surveyed line with its semicircular bastions. North: offset from the main wall. */
export const OUTER_OFFSET = 14;       // m between main wall and the synthesised northern outer wall
export const OUTER_HEIGHT = 6.5;      // m above ground
export const MOAT_DEPTH = 4.5;
export const OUTER_WEST = geo.outerWest;
function northOuter() {
  // drop the tower bulges, then offset to the outside
  const spine = [];
  for (const p of LAND_NORTH) if (!spine.length || dist2(p, spine[spine.length - 1]) > 26) spine.push(p);
  const tail = LAND_NORTH[LAND_NORTH.length - 1];
  if (dist2(tail, spine[spine.length - 1]) > 8) spine.push(tail);
  // push each spine point out past any tower that bulges beyond it
  const a = offsetPolyline(spine, OUTER_OFFSET + 5), b = offsetPolyline(spine, -(OUTER_OFFSET + 5));
  return pointInPolygon(a[Math.floor(a.length / 2)], RING) ? b : a;
}
export const OUTER_NORTH = northOuter().slice(0, -1);
/** Semicircular bastions along the northern outer wall, as fractions of its length. */
export const OUTER_BASTIONS = [0.12, 0.3, 0.48, 0.66, 0.84];

/** Stradun (Placa) axis from the Pile end to Luža square. */
export const STRADUN = { a: geo.stradun[0], b: geo.stradun[1], width: 11 };
export const LUZA = { c: [346, 52], r: 17 };

const T = (name) => geo.towers[name];
const C = (name) => centroid(T(name));

/**
 * Towers and forts on the circuit. `poly` is the surveyed footprint.
 * kind: 'tower' (rises above the wall walk) | 'bastion' (low, level with it) | 'gate' | special ids.
 */
export const TOWERS = [
  { id: 'pile', name: 'Pile Gate', kind: 'gate', side: 'land', poly: T('Vrata od Pila'), rise: 3 },
  { id: 'minceta', name: 'Minčeta Tower', kind: 'minceta', side: 'land', poly: T('Minčeta'), inner: T('Minčeta (inner)') },
  { id: 'stbarbara', name: 'Tower of St Barbara', kind: 'bastion', side: 'land', poly: T('Sv. Barbara'), rise: 2 },
  { id: 'stlucy', name: 'Tower of St Lucy', kind: 'bastion', side: 'land', poly: T('Sv. Lucija'), rise: 2 },
  { id: 'stvitus', name: 'Tower of St Vitus', kind: 'tower', side: 'land', poly: T('Sv. Vid'), rise: 4 },
  { id: 'drezvenik', name: 'Drezvenik Tower', kind: 'tower', side: 'land', poly: T('Drezvenik'), rise: 4 },
  { id: 'stjames', name: 'Tower of St James', kind: 'tower', side: 'land', poly: T('Sv. Jakov'), rise: 4 },
  { id: 'ploce', name: 'Ploče Gate (Asimon)', kind: 'tower', side: 'land', poly: T('Asimon'), rise: 6 },
  { id: 'stluke', name: 'Tower of St Luke', kind: 'tower', side: 'harbor', poly: T('Sv. Luka'), rise: 6 },
  { id: 'stjohn', name: 'Fort St John', kind: 'stjohn', side: 'harbor', poly: T('Sv. Ivan') },
  { id: 'stsaviour', name: 'Bastion of St Saviour', kind: 'bastion', side: 'sea', poly: T('Sv. Spasitelj'), rise: 1.5 },
  { id: 'ststephen', name: 'Bastion of St Stephen', kind: 'bastion', side: 'sea', poly: T('Sv. Stjepan'), rise: 1.5 },
  { id: 'stmargaret', name: 'Bastion of St Margaret', kind: 'bastion', side: 'sea', poly: T('Sv. Margarita'), rise: 1.5 },
  { id: 'mrtvozvono', name: 'Mrtvo Zvono (St Peter) Tower', kind: 'tower', side: 'sea', poly: T('Sv. Petar'), rise: 4 },
  { id: 'bokar', name: 'Fort Bokar', kind: 'bokar', side: 'west', poly: T('Bokar') },
  { id: 'puncjela', name: 'Puncjela Tower', kind: 'tower', side: 'west', poly: T('Puncjela'), rise: 5 },
];

/** Anchor points [x, z] of the main works (used for hotspots, highlights, flags, fire arcs). */
export const P = {
  minceta: centroid(T('Minčeta (inner)')),
  bokar: [-34, 57],
  lovrijenac: C('Lovrijenac'),
  stjohn: C('Sv. Ivan'),
  stjohnTip: [497, 140],
  revelin: C('Revelin'),
  pile: [42, -42],
  pileOuter: C('Vrata od Pila'),
  ploce: C('Asimon'),
  ploceOuter: C('Vrata od Ploča'),
  outerwall: [246, -138],
  northwall: [330, -80],
  seawalls: [200, 268],
  port: [470, 70],
  stradun: [198, 10.5],
  srdj: centroid(T('Tvrđava Imperial')),
  lokrum: [1050, 1480],
  lazareti: [636, -29],
};

/** Features outside the main circuit. */
export const REVELIN = { poly: T('Revelin'), h: 20 };
export const LOVRIJENAC = { c: P.lovrijenac, rockH: 37, poly: T('Lovrijenac'), tiers: [19, 7, 6] };
export const STJOHN = { poly: T('Sv. Ivan'), h: 19, oldTower: P.stjohnTip };
export const FORT_IMPERIAL = { c: P.srdj, poly: T('Tvrđava Imperial'), h: 9 };
export const LAZARETI = { c: P.lazareti, count: 5, w: 8, d: 26, h: 7, gap: 2.5 };

/** Old Port. */
export const KASE = { poly: geo.kase, h: 3 };
export const HARBOR_BOX = { x0: 388, x1: 575, z0: -24, z1: 152 };
export const HARBOR_CHAIN = { from: [501, 138], to: [524, 92] };
export const ARSENAL = { c: [388, 82], facing: Math.PI / 2 }; // three arches on the harbour front, facing east

/** Gates and bridges. */
export const PILE_BRIDGE = { from: [22, -30], to: [-10, -21], w: 6, arches: 3 };
export const PLOCE_BRIDGE = { from: [438, -67], to: [455, -78], w: 5, arches: 2 };
export const PLOCE_BRIDGE2 = { from: [514, -62], to: [542, -57], w: 5, arches: 3 };

/** Coastline polygons. Land is everything inside LAND; Lokrum is its own island. */
export const LAND = geo.land;
export const LOKRUM = { poly: geo.lokrum, peak: geo.points.fortRoyal, h: 96 };

/** Mount Srđ: crest line of the coastal ridge (west -> east) and its summit height. */
export const SRDJ = { peak: P.srdj, h: 412, ridge: [[-420, -2550], [-201, -2057], [P.srdj[0], P.srdj[1] - 10], [2604, 537], [3400, 1060]] };

/** Monuments inside the walls, matched to footprints by OSM name: wall height, plus domes and bell towers. */
export const MONUMENTS = {
  'katedrala Uznesenja Blažene Djevice Marije': { id: 'cathedral', year: 1192, h: 18, dome: { c: [329, 172], r: 8, h: 8, drum: 4 } },
  'Crkva sv. Vlaha': { id: 'stblaise', year: 1368, h: 16, dome: { r: 6.5, h: 6, drum: 1 } },
  'Crkva sv. Ignacija': { id: 'jesuit', year: 1725, h: 21 },
  'Sv. Franjo': { id: 'franciscan', year: 1317, h: 15, tower: { c: [121, -31], w: 6.5, h: 38 } },
  'Crkva sv. Dominika': { id: 'dominican', year: 1315, h: 16, tower: { c: [393, -35], w: 6, h: 32 } },
  'Crkva sv. Blagovještenja': { id: 'orthodox', year: 1877, h: 15 },
  'Sv. Spas': { id: 'stsaviour-church', year: 1528, h: 11 },
};
/** Free-standing landmarks. */
export const LANDMARKS = [
  { id: 'onofrio', year: 1438, name: "Onofrio's Great Fountain", c: [66.5, -11], kind: 'fountain', r: 4.6, h: 5 },
  { id: 'belltower', year: 1444, name: 'City Bell Tower', c: [352, 60], w: 6, d: 6, h: 31, kind: 'tower' },
  { id: 'orlando', year: 1418, name: "Orlando's Column", c: [322, 62], kind: 'column', r: 0.8, h: 6 },
];

/** Camera poses for features (position, target). */
export const CAMERA = {
  overview:   { position: [780, 360, 660], target: [220, 20, 60] },
  minceta:    { position: [105, 125, -325], target: [158, 50, -170] },
  bokar:      { position: [-200, 75, 190], target: [-34, 22, 57] },
  lovrijenac: { position: [-360, 110, 250], target: [-185, 42, 76] },
  stjohn:     { position: [670, 95, 290], target: [486, 20, 160] },
  revelin:    { position: [650, 115, -210], target: [480, 22, -85] },
  pile:       { position: [-105, 75, -120], target: [36, 18, -36] },
  ploce:      { position: [575, 75, 10], target: [445, 16, -60] },
  outerwall:  { position: [215, 165, -390], target: [246, 30, -130] },
  northwall:  { position: [420, 150, -320], target: [310, 32, -85] },
  seawalls:   { position: [170, 125, 540], target: [200, 22, 265] },
  port:       { position: [720, 150, 170], target: [470, 4, 75] },
  stradun:    { position: [175, 105, 165], target: [198, 8, 10] },
  srdj:       { position: [860, 660, -260], target: [345, 400, -940] },
  lokrum:     { position: [520, 380, 640], target: [1050, 30, 1450] },
  lazareti:   { position: [730, 75, 100], target: [636, 8, -28] },
};

/**
 * Fields of fire of the forts: {feature id, c:[x,z] gun position, r range (m), clear: radius of the work itself,
 * lift: height of the guns above the ground at c, colour}. The covered sector is not listed here: it is worked out
 * from the plan (modes.js), so a fort never "fires" into the town or through a hillside. Every tower and bastion in
 * TOWERS and every outer-wall bastion gets a smaller field the same way.
 */
export const FIRE_ARCS = [
  { id: 'minceta', c: P.minceta, r: 330, clear: 22, lift: 40, col: 0xffb347 },
  { id: 'bokar', c: P.bokar, r: 260, clear: 18, lift: 20, col: 0xff6b6b },
  { id: 'lovrijenac', c: P.lovrijenac, r: 380, clear: 34, lift: 30, col: 0x7bdff2 },
  { id: 'stjohn', c: P.stjohn, r: 420, clear: 46, lift: 20, col: 0x9bf6a3 },
  { id: 'revelin', c: P.revelin, r: 340, clear: 40, lift: 20, col: 0xffd166 },
];
export const FIRE_COLORS = { towers: 0xf29bd0, outer: 0xcdb4ff };
/** Centres of the two surveyed semicircular bastions on the western outer wall. */
export const OUTER_WEST_BASTIONS = [[84, -89], [111, -132]];

/** Camera poses for the siege dioramas. */
export const SIEGE_CAMERA = {
  saracen866:  { position: [520, 300, 1120], target: [210, 10, 270] },
  bombard1806: { position: [-520, 430, 720], target: [220, 30, 20] },
  siege1991:   { position: [950, 400, 700], target: [220, 30, 50] },
  quake1667:   { position: [470, 250, 430], target: [215, 15, 70] },
};

/** Structure construction years for the timeline (structure id -> year first visible). */
export const BUILT = {
  'core-walls': 800,
  'stradun': 1200,
  'main-walls': 1250,
  'lovrijenac': 1301,
  'minceta-square': 1319,
  'stjohn-tower': 1346,
  'bokar': 1461,
  'minceta-round': 1464,
  'outer-wall': 1470,
  'pile-bridge': 1471,
  'kase': 1485,
  'revelin': 1551,
  'stjohn-fort': 1557,
  'bokar-complete': 1570,
  'lazareti': 1647,
  'fort-imperial': 1812,
};
