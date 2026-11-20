import type { Dict } from './th';

const n = (x: number, digits = 0) =>
  x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const en: Dict = {
  title: 'Solar System',
  tagline:
    'Where the planets, moons, comets and spacecraft really are, from 1900 to 2100. Zoom out as far as the Oort cloud.',
  loading: 'Loading the Solar System…',
  loadingData: 'Loading orbits…',
  language: 'Language',
  close: 'Close',

  layers: 'Layers',
  orbits: 'Orbits',
  labels: 'Names',
  smallBodies: 'Asteroids',
  smallBodiesTip:
    'About 61,000 objects from JPL; positions are truest around the present and drift away from it',
  oort: 'Oort cloud',
  spacecraft: 'Spacecraft',
  trueSize: 'True size',
  trueSizeTip:
    'Stop enlarging bodies past their real size. Far away, each one shrinks to a point about a pixel wide.',

  scale: 'Scale',
  camera: 'Camera',
  from: (name: string) => `from ${name}`,

  timeline: 'Timeline',
  play: 'Play',
  pause: 'Pause',
  reverse: 'Reverse',
  now: 'Now',
  nowTip: 'Back to the current date and time',
  prevEvent: 'Previous event',
  nextEvent: 'Next event',
  stopAtEvents: 'Stop at major events',
  speed: 'Speed',
  speeds: ['Real time', '1 hr/s', '1 day/s', '1 week/s', '1 month/s', '1 yr/s', '10 yr/s'],
  dateSlider: 'Date',

  search: 'Search',
  searchHint: 'Search planets, moons, craft or events',
  searchNone: 'Nothing found',

  kinds: {
    star: 'Star',
    planet: 'Planet',
    dwarf: 'Dwarf planet',
    moon: 'Moon',
    asteroid: 'Asteroid',
    comet: 'Comet',
    interstellar: 'Interstellar object',
    spacecraft: 'Spacecraft',
  },
  moonOf: (parent: string) => `Moon of ${parent}`,
  region: 'Region',
  event: 'Event',
  nearStar: 'Nearby star',
  // keyed by the catalogue name in stars.json
  starNames: new Map<string, string>([
    ['Ran', 'Epsilon Eridani'],
    ['τ Cet', 'Tau Ceti'],
    ['Toliman', 'Alpha Centauri B'],
    ['Rigil Kentaurus', 'Alpha Centauri A'],
  ]),
  model: 'Model',
  illustrated: 'Illustrated surface; no real images exist yet',
  dsoKinds: {
    cluster: 'Star cluster',
    nebula: 'Nebula',
    galaxy: 'Galaxy',
    blackhole: 'Supermassive black hole',
  },
  arms: new Map([
    ['scutum-centaurus', 'Scutum–Centaurus Arm'],
    ['sagittarius-carina', 'Sagittarius–Carina Arm'],
    ['local', 'Orion Arm (where the Sun is)'],
    ['perseus', 'Perseus Arm'],
    ['outer', 'Outer Arm'],
  ]),
  galaxyModel:
    "Simulated: nobody has seen the Milky Way from outside, because we are in it. This shape is built from the models astronomers have measured. What is real is its size, the Sun's distance from the centre (about 26,700 light years), the tilt of the galactic plane on our sky, and the spiral arms on our side, placed by maser distances. The far side, hidden behind dust, carries the same arms on. The points are not real stars.",
  starField:
    'Every star is at its real position, from distances measured by parallax (the HYG database). But the catalogue is only complete for stars bright enough to measure from Earth, so farther out only the very bright ones are left. That makes the stars look crowded around the Sun and thinning out, which is not true; stars in this part of the galaxy are spread about evenly. Distances beyond about a thousand light years can be well off. Seen from outside the Solar System, the stars are brightened as a long exposure would, or you would hardly see any.',
  nebulaGlow:
    'The glow is a simple stand-in, with the color and size roughly as photographed, not the real shape of the nebula.',
  guessShape:
    'Simulated: no telescope has resolved this nucleus, only the cloud of gas and dust around it. The app shows a dark, lumpy ball of ice and rock like the comet nuclei spacecraft have photographed, sized at the middle of the estimates.',
  modelShape:
    'Simulated: no telescope has ever seen this object’s shape. The shape, size and spin shown come from a model fitted to how its brightness changed.',

  distSun: 'From the Sun',
  distCentre: 'Centre from the Sun',
  distEarth: 'From Earth',
  speedSun: 'Speed relative to the Sun',
  radius: 'Radius',
  size: 'Approximate size',
  tumbling: 'tumbling',
  tailModel:
    'The tails and coma are a model. Their directions follow the physics: the blue ion tail points straight away from the Sun and the dust tail curves back along the orbit. Tail length, coma size and brightness are estimates scaled from what was observed and from the distance to the Sun, and they fade out far from the Sun.',
  unmapped:
    'The surface is New Horizons’ own imagery (2015), but most of the southern hemisphere was in seasonal darkness during the flyby and has never been photographed. That part is painted a plain color.',
  catalogDensity:
    'Each dot is drawn about 2 pixels wide to show where the objects are and how many, which makes them hundreds of thousands of times bigger than they really are. So the belt looks far more crowded than it is. In reality these objects sit millions of kilometers apart, spacecraft fly through without dodging anything, and from inside the belt you would hardly see a single one with the naked eye. Turn on "True size" at the top for a view closer to reality.',
  oortDensity:
    'Nobody has ever seen an object in the Oort cloud directly. These dots are placed at random to follow the model, not real objects, and each is millions of times bigger than a real comet. Estimates put about a trillion kilometer-sized bodies there, but spread through such a vast volume that they sit about 10–20 AU apart on average, roughly the distance from the Sun to Uranus. With "True size" on, the cloud fades until you can barely see it, which is closer to the truth.',
  catalogDrift:
    'Every dot is a real, discovered object, but its position comes from one set of current orbital elements from JPL, without the planets’ pull. Dots are closest to true around the present and drift further off the further you move in time, near-Earth asteroids most of all. The shape of the belt as a whole stays right. Named objects with their own card follow JPL positions accurate across the whole range.',
  dimensionsM: (d: number[]) => `${d.map((x) => Math.round(x)).join(' × ')} m`,
  dimensionsKm: (d: number[]) => `${d.map((x) => x.toFixed(1)).join(' × ')} km`,
  mass: 'Mass',
  orbitPeriod: 'Orbital period',
  day: 'Rotation',
  moons: 'Moons',
  moonsNote: 'known as of 2025',
  launched: 'Launched',
  notLaunched: 'Not launched yet',
  span: 'Distance from the Sun',
  lightTime: (s: string) => `light takes ${s}`,
  retrograde: 'retrograde',
  coasting: 'After 2050, where JPL’s trajectory ends, the position is carried on under the Sun’s gravity.',
  twoBody: 'Outside the JPL data; this position comes from a two-body orbit.',
  goTo: 'Go there',
  centerOn: 'Center on it',
  centerTip: 'Orbit and follow this body, keeping the current zoom (C key)',
  chase: 'Face direction of travel',
  fieldNote:
    'The stars look crowded around the Sun because the catalogue is incomplete, not because they are.',
  more: 'More',
  chaseTip:
    'The camera sits behind the body in the center and looks where it is heading. Moons use their heading around their planet. When fast playback swings the heading too quickly, the camera holds still and catches up once it slows. Drag to change the angle (V key).',
  showOnTimeline: 'See event',
  eventGo: 'Go to event',

  km: (x: number) => `${n(x)} km`,
  m: (x: number) => `${n(x)} m`,
  au: (x: number, digits: number) => `${n(x, digits)} AU`,
  ly: (x: number, digits: number) => `${n(x, digits)} light years`,
  kmps: (x: number) => `${n(x, 1)} km/s`,
  kg: (mantissa: string, exp: number) => `${mantissa} × 10^${exp} kg`,
  days: (x: number) => `${n(x, x < 10 ? 2 : 1)} days`,
  years: (x: number) => `${n(x, x < 100 ? 2 : 0)} years`,
  hours: (x: number) => `${n(x, 2)} hours`,
  seconds: (x: number) => `${n(x, 1)} s`,
  minutes: (x: number) => `${n(x, 1)} min`,
  lightHours: (x: number) => `${n(x, 1)} hours`,
  lightDays: (x: number) => `${n(x, 1)} days`,
  lightYears: (x: number) => `${n(x, 2)} years`,

  date: (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  dateShort: (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`,
  dateAlt: () => '',
  clock: (d: Date) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`,
  year: (y: number) => String(y),

  dataError: (k: number) => `${k} problem${k === 1 ? '' : 's'} in the data`,
  dataErrorHint: 'Fix the files in data/ and this page reloads by itself.',
  loadError: 'Could not load the orbit data. Try reloading the page.',
  credits:
    'Data: NASA/JPL Horizons, JPL SBDB, astronomy-engine, HYG · Textures: Solar System Scope (CC BY 4.0), NASA/JHUAPL/SwRI',
};
