// Spatial layout of Dubrovnik's Old City in a local metric frame.
// Origin = Pile Gate. x = east, z = south, y = up. All units metres.
// Positions are derived from real geography, simplified for a stylised model.

/** Main wall circuit, clockwise from Pile Gate (north -> east -> south -> west). */
export const CIRCUIT = [
  { id: 'pile',        p: [0, 0],       tower: 'gate',    side: 'land', name: 'Pile Gate' },
  { id: 'stfrancis',   p: [30, -56],    tower: 'square',  side: 'land', name: 'Tower of St Francis' },
  { id: 'gornjiugao',  p: [74, -104],   tower: 'square',  side: 'land', name: 'Gornji Ugao Tower' },
  { id: 'minceta',     p: [98, -126],   tower: 'minceta', side: 'land', name: 'Minčeta Tower' },
  { id: 'n1',          p: [162, -114],  tower: 'square',  side: 'land', name: 'Tower of St Barbara' },
  { id: 'n2',          p: [226, -100],  tower: 'square',  side: 'land', name: 'Tower of St Lucy' },
  { id: 'n3',          p: [290, -82],   tower: 'square',  side: 'land', name: 'Tower of St Catherine' },
  { id: 'n4',          p: [355, -60],   tower: 'square',  side: 'land', name: 'Drezvenik Tower' },
  { id: 'stluke',      p: [416, -36],   tower: 'square',  side: 'land', name: 'Tower of St Luke' },
  { id: 'ploce',       p: [432, -4],    tower: 'gate',    side: 'harbor', name: 'Ploče Gate (Asimon)' },
  { id: 'h1',          p: [436, 34],    tower: 'joint',   side: 'harbor', name: 'Harbour wall' },
  { id: 'h2',          p: [427, 80],    tower: 'joint',   side: 'harbor', name: 'Arsenal' },
  { id: 'h3',          p: [415, 125],   tower: 'joint',   side: 'harbor', name: 'Harbour wall' },
  { id: 'h4',          p: [404, 168],   tower: 'square',  side: 'harbor', name: 'Tower of St Dominic' },
  { id: 'stjohn',      p: [394, 206],   tower: 'stjohn',  side: 'sea',  name: 'Fort St John' },
  { id: 's1',          p: [338, 222],   tower: 'square',  side: 'sea',  name: 'Bastion of St Saviour' },
  { id: 's2',          p: [264, 214],   tower: 'bastion', side: 'sea',  name: 'Bastion of St Stephen' },
  { id: 'stmargaret',  p: [178, 192],   tower: 'square',  side: 'sea',  name: 'Tower of St Margaret' },
  { id: 's3',          p: [112, 173],   tower: 'joint',   side: 'sea',  name: 'Sea wall' },
  { id: 'mrtvozvono',  p: [52, 152],    tower: 'square',  side: 'sea',  name: 'Mrtvo Zvono Tower' },
  { id: 'bokar',       p: [-22, 112],   tower: 'bokar',   side: 'sea',  name: 'Fort Bokar' },
  { id: 'puncjela',    p: [-12, 54],    tower: 'square',  side: 'west', name: 'Puncjela Tower' },
];

/** Thickness (m) and height above outside ground (m) by wall side. Visual values; stats use real ranges. */
export const WALL_SPEC = {
  land:   { thickness: 5.5, height: 21, label: 'Land wall', real: '4–6 m thick' },
  west:   { thickness: 4.5, height: 18, label: 'West wall', real: '4–5 m thick' },
  harbor: { thickness: 3.0, height: 12, label: 'Harbour wall', real: '~3 m thick' },
  sea:    { thickness: 2.4, height: 13, label: 'Sea wall', real: '1.5–3 m thick' },
};

/** Index range (inclusive) of the land section Pile -> St Luke, which carries the outer wall and moat. */
export const LAND_SECTION = { from: 0, to: 8 };

/** Semicircular bastion positions on the outer wall, as fractions along the offset land polyline. */
export const OUTER_BASTIONS = [0.09, 0.2, 0.31, 0.43, 0.54, 0.65, 0.76, 0.88];
export const OUTER_OFFSET = 13;       // m between main wall and outer wall
export const OUTER_HEIGHT = 6.5;      // m above ground
export const MOAT_DEPTH = 3.2;

/** Stradun (Placa) axis from Pile end to Luža square. */
export const STRADUN = { a: [4, 7], b: [350, 13], width: 11 };

/** Squares / open spaces inside the walls (no houses). */
export const SQUARES = [
  { c: [352, 16], r: 22, name: 'Luža' },
  { c: [306, 62], r: 15, name: 'Gundulić Square' },
  { c: [338, 82], r: 13, name: 'Bunić Square' },
  { c: [40, 6], r: 15, name: 'Pile courtyard' },
  { c: [196, 170], r: 12, name: 'Ruđer Bošković Square' },
];

/** Landmark buildings: {id, c:[x,z], w (east-west), d (north-south), h, rot, kind, dome:{r,h}, tower:{c,w,h}} */
export const LANDMARKS = [
  { id: 'franciscan', name: 'Franciscan Monastery', c: [52, -30], w: 48, d: 30, h: 15, rot: 0.08, tower: { c: [30, -12], w: 6.5, h: 38 } },
  { id: 'stsaviour', name: 'Church of St Saviour', c: [20, -6], w: 10, d: 18, h: 11, rot: 0.08 },
  { id: 'onofrio', name: "Onofrio's Great Fountain", c: [66, 14], kind: 'fountain', r: 5.5, h: 5 },
  { id: 'belltower', name: 'City Bell Tower', c: [360, 20], w: 7, d: 7, h: 31, kind: 'tower', cap: 'dome' },
  { id: 'sponza', name: 'Sponza Palace', c: [352, -8], w: 30, d: 22, h: 15, rot: 0.02 },
  { id: 'stblaise', name: 'Church of St Blaise', c: [336, 32], w: 22, d: 30, h: 17, dome: { r: 7, h: 6 } },
  { id: 'rector', name: "Rector's Palace", c: [346, 60], w: 28, d: 26, h: 14 },
  { id: 'cathedral', name: 'Cathedral of the Assumption', c: [328, 92], w: 26, d: 46, h: 18, dome: { r: 9, h: 9, drum: 6 } },
  { id: 'jesuit', name: 'Church of St Ignatius (Jesuit)', c: [196, 136], w: 24, d: 40, h: 21, rot: 0.05 },
  { id: 'dominican', name: 'Dominican Monastery', c: [396, -14], w: 32, d: 30, h: 14, tower: { c: [382, -32], w: 6, h: 32 } },
  { id: 'orlando', name: "Orlando's Column", c: [352, 24], kind: 'column', r: 0.8, h: 6 },
];

/** Features outside the main circuit. */
export const REVELIN = { c: [476, -28], poly: [[-32, -26], [28, -32], [42, 8], [12, 30], [-30, 22]], h: 20 };
export const LOVRIJENAC = { c: [-166, 86], rockH: 37, poly: [[-36, -22], [26, -36], [36, 24], [-4, 40], [-34, 20]], tiers: [14, 7, 6] };
export const STJOHN = { c: [394, 206], w: 28, d: 46, h: 19 };
export const FORT_IMPERIAL = { c: [300, -1215], w: 54, d: 32, h: 9 };
export const LAZARETI = { c: [540, 16], count: 5, w: 10, d: 36, h: 8, gap: 4 };

/** Breakwaters in the Old Port. */
export const KASE = { from: [500, 68], to: [502, 152], w: 9, h: 3 };
export const PORPORELA = { from: [410, 212], to: [488, 206], w: 7, h: 2.5 };
export const HARBOR_CHAIN = { from: [412, 206], to: [500, 150] };

/** Gates and bridges. */
export const PILE_BRIDGE = { from: [-13, 0], to: [-46, 2], w: 6, arches: 3 };
export const PLOCE_BRIDGE = { from: [444, -12], to: [462, -20], w: 5, arches: 2 };
export const PLOCE_BRIDGE2 = { from: [500, -12], to: [530, -6], w: 5, arches: 3 };

/** Land polygon (coastline), listed west -> east along the shore, then closed to the north. Land is north of the shore. */
export const LAND = [
  [-1800, 110], [-1200, 95], [-800, 60], [-560, 30], [-420, -10], [-330, 18], [-262, 32],
  [-238, 70], [-220, 112], [-192, 136], [-160, 134], [-132, 112], [-112, 78], [-98, 48],
  [-74, 30], [-54, 48], [-42, 92], [-34, 118], [-18, 136], [28, 166], [70, 182], [116, 192],
  [176, 210], [232, 228], [292, 236], [346, 242], [386, 240], [410, 227], [421, 207],
  [422, 188], [427, 148], [434, 108], [441, 70], [447, 46], [455, 30], [500, 20], [540, 24],
  [580, 44], [640, 72], [720, 96], [850, 112], [1000, 112], [1300, 130], [1800, 160], [2400, 200],
  [2400, -2400], [-1800, -2400],
];

/** Lokrum island (ellipse). */
export const LOKRUM = { c: [1060, 830], axis: [0.62, 0.785], a: 430, b: 175, h: 96 };

/** Mount Srđ ridge peak. */
export const SRDJ = { peak: [300, -1215], h: 412 };

/** Camera poses for features (position, target). Filled for the hotspot fly-to. */
export const CAMERA = {
  overview:   { position: [930, 430, 760], target: [220, 20, 40] },
  minceta:    { position: [60, 120, -260], target: [98, 50, -126] },
  bokar:      { position: [-170, 70, 250], target: [-22, 25, 112] },
  lovrijenac: { position: [-330, 110, 260], target: [-166, 50, 86] },
  stjohn:     { position: [560, 90, 330], target: [394, 25, 206] },
  revelin:    { position: [620, 110, -140], target: [476, 25, -28] },
  pile:       { position: [-140, 70, -60], target: [-10, 25, 0] },
  ploce:      { position: [520, 60, 70], target: [438, 20, -4] },
  outerwall:  { position: [150, 170, -360], target: [220, 30, -100] },
  northwall:  { position: [360, 150, -300], target: [250, 35, -90] },
  seawalls:   { position: [190, 110, 460], target: [200, 20, 210] },
  port:       { position: [640, 130, 140], target: [455, 5, 120] },
  stradun:    { position: [190, 95, 120], target: [190, 8, 10] },
  srdj:       { position: [700, 700, -300], target: [300, 400, -1215] },
  lokrum:     { position: [600, 320, 420], target: [1060, 40, 830] },
  lazareti:   { position: [600, 70, 130], target: [540, 8, 16] },
};

/** Fields of fire: {from feature id, c:[x,z], y offset, r, a0..a1 degrees (compass, 0=N, 90=E), colour}. */
export const FIRE_ARCS = [
  { id: 'minceta', c: [98, -126], r: 330, a0: 220, a1: 470, col: 0xffb347 },
  { id: 'bokar', c: [-22, 112], r: 260, a0: 150, a1: 350, col: 0xff6b6b },
  { id: 'lovrijenac', c: [-166, 86], r: 380, a0: 30, a1: 300, col: 0x7bdff2 },
  { id: 'stjohn', c: [394, 206], r: 420, a0: 40, a1: 250, col: 0x9bf6a3 },
  { id: 'revelin', c: [476, -28], r: 340, a0: 300, a1: 520, col: 0xffd166 },
  { id: 'outerwall', c: [230, -112], r: 150, a0: 250, a1: 440, col: 0xcdb4ff, flat: true },
];

/** Structure construction years for the timeline (structure id -> year first visible). */
export const BUILT = {
  'core-walls': 800,
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
