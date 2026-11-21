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
  title: 'Cosmos',
  tagline:
    'The universe from real data: the Solar System in 1900–2100, the stars, the Milky Way and millions of galaxies beyond.',
  loading: 'Loading the cosmos…',
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
  sdssTip:
    'About 2.4 million galaxies from the Sloan Digital Sky Survey, out to about 8.5 billion light years',
  desiTip: 'About 2.4 million galaxies and quasars from DESI, out to about 20 billion light years',
  quaiaTip:
    'About 1.2 million quasars over the whole sky from the Gaia satellite, out to about 20 billion light years; their distances are rougher than the others',
  trueSizeTip:
    'Stop enlarging bodies past their real size. Far away, each one shrinks to a point about a pixel wide.',

  scale: 'Scale',
  craftWhole: 'The whole craft',
  craftWith: (name: string) => `With ${name}`,
  craftSun: 'With the Sun',
  camera: 'Camera',
  from: (name: string) => `from ${name}`,

  timeline: 'Timeline',
  holeClock: 'Time at the Galactic Centre',
  holeSpeeds: ['Real time', '1 min/s', '1 hr/s', '1 day/s', '1 yr/s', '10 yr/s'],
  play: 'Play',
  pause: 'Pause',
  reverse: 'Reverse',
  now: 'Now',
  nowTip: 'Back to the current date and time',
  prevEvent: 'Previous event',
  nextEvent: 'Next event',
  stopAtEvents: 'Stop at major events',
  speed: 'Speed',
  speeds: [
    'Real time',
    '15 min/s',
    '30 min/s',
    '1 hr/s',
    '1 day/s',
    '1 week/s',
    '1 month/s',
    '1 yr/s',
    '10 yr/s',
  ],
  deepSpeeds: ['100,000 yr/s', '1 Myr/s', '10 Myr/s'],
  myr: (m: number) =>
    Math.abs(m) < 0.05
      ? 'Present day'
      : m < 0
        ? `${n(-m, -m < 10 ? 1 : 0)} million years ago`
        : `${n(m, m < 10 ? 1 : 0)} million years from now`,
  myrTick: (v: number) => (v === 0 ? 'now' : `${v < 0 ? '−' : '+'}${Math.abs(v)}`),
  deepNote: 'Galaxy scale · millions of years',
  cosmicSpeeds: ['100 Myr/s', '500 Myr/s', '2 Gyr/s'],
  gyr: (g: number) => (Math.abs(g) < 0.005 ? 'Present day' : `${n(-g * 1000, 0)} million years ago`),
  gyrTick: (v: number) => (v === 0 ? 'now' : `−${Math.abs(v)}`),
  cosmicNote: (age: number, size: number) =>
    `${n(age, age < 1 ? 2 : 1)} billion years old · ${n(size * 100, size < 0.1 ? 1 : 0)}% of its size now`,
  dateSlider: 'Date',

  search: 'Search',
  searchHint: 'Search planets, moons, craft or events',
  browse: 'Browse',
  browseTip: 'Everything, by category',
  browseTitle: 'Everything',
  browseCats: {
    planets: 'Sun and planets',
    dwarfs: 'Dwarf planets',
    moons: 'Moons',
    small: 'Asteroids and comets',
    craft: 'Spacecraft',
    zones: 'Regions and edges',
    clusters: 'Star clusters',
    nebulae: 'Nebulae',
    galaxies: 'Galaxies and black holes',
    events: 'Events',
  },
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
    void: 'Cosmic void',
  },
  arms: new Map([
    ['scutum-centaurus', 'Scutum–Centaurus Arm'],
    ['sagittarius-carina', 'Sagittarius–Carina Arm'],
    ['local', 'Orion Arm (where the Sun is)'],
    ['perseus', 'Perseus Arm'],
    ['outer', 'Outer Arm'],
  ]),
  blackholeModel:
    'A film-style simulation: the disk is traced with light bending around the black hole, so its far side shows above and below the shadow. The shadow is the real size the EHT measured, and the disk is tilted so that from Earth it looks roughly like the EHT image, brighter where the gas moves toward us. The real Sgr A* is fed so little gas that it has no bright disk like this. The gas turns at its real speed with the timeline: the inner edge laps every 33 minutes or so, so play at 1 hour/s to see it move; faster than that it smears into an even glow, like a long exposure. The S-star orbits are the measured ones, though the depth along our line of sight is less certain than the rest.',
  galaxyModel:
    'Simulated: nobody has seen the Milky Way from outside, because we are in it. This is a model built from points, like the other galaxies here, with the Sun the measured 26,700 light years from the centre. The arms on our side follow maser distances; the far side, hidden behind dust, carries the same arms on. Whether the Galaxy has two major arms or four is still argued. The points are not real stars. Zoomed out to the Galaxy, the timeline counts millions of years: the Sun goes round the centre about once in 220 million years and bobs through the plane every 70 million or so. The spiral pattern is a wave that turns slower than the Sun (how much slower is still argued), so it turns as a whole rather than faster inside like the stars themselves. Orbits hundreds of millions of years back are estimates, nobody knows what the arms looked like then, and the Magellanic Clouds are held still though they move too.',
  clusters: {
    virgo: 'Virgo Cluster',
    fornax: 'Fornax Cluster',
    centaurus: 'Centaurus Cluster',
    hydra: 'Hydra Cluster',
    norma: 'Norma Cluster',
    perseus: 'Perseus Cluster',
    coma: 'Coma Cluster',
    leo: 'Leo Cluster',
  },
  spiralModel:
    "Simulated: built from points like the Milky Way. The size, distance and tilt on our sky are measured, so from Earth it leans the way it does in photographs, but the arms are only sketched to look like them. The 170 small fuzzy dwarf galaxies around come from the Local Volume Database (Pace et al. 2024, November 2026 release), which includes recent discoveries, at their measured positions, distances and sizes; very faint ones are still being found. On the million-year timeline Andromeda and its satellites fall toward the Milky Way's centre at the measured 109 km/s, and the spiral patterns turn as a whole, Andromeda's once in about 350 million years and Triangulum's in about 590. Nobody has measured their pattern speeds, so they are set at 70% of the orbital speed, the Milky Way's share at the Sun. Andromeda's sideways motion is still too uncertain to include. The two will start to merge in some 4 to 5 billion years, well past this timeline.",
  voidNote:
    'Its place and size are from the survey that found it (Kirshner et al. 1981). A void has no sharp edge: galaxies thin out from its walls toward the middle. In the catalogues used here a sphere about 100 million light years in radius at its centre holds about a fifth of the galaxies the same sphere does elsewhere at that distance. It is not quite empty either: some 60 galaxies have been found inside.',
  galaxyField:
    "The directions on the sky are precise, but each galaxy's distance can be off by about 20%. Used as they are, clusters would stretch into long streaks pointing at us, so galaxies in one group all take the group's mean distance; lone galaxies keep their error, which blurs the picture a little along our line of sight. The galaxies from 2MRS have no measured distance, only the speed they recede at (their redshift), divided by the expansion rate of the universe. A cluster's members would spread along our line of sight by their own orbital speeds, so they too take their group's mean. The empty band across it is where the Milky Way's own dust and stars hide what lies behind (the zone of avoidance), not empty space. And galaxies thin out with distance because only the brighter ones could be measured, not because the universe empties. The 6dFGS galaxies in the southern sky are placed by redshift the same way, but with no group data to correct them yet, so their clusters still show as short streaks pointing at us. Further out the galaxies come from the SDSS survey, which covered about a third of the sky, so the map becomes two fans; the gaps around them were not surveyed, not empty. The most distant are placed where they are now, but the light we see left them billions of years ago, when they were closer: the universe expanded on the way. Light from the farthest SDSS galaxies travelled about 6.4 billion years, and they are now some 8.5 billion light years off. Beyond are galaxies and quasars from DESI, a random half of those it has. The farthest points are quasars whose light travelled about 11 billion years; they are now some 20 billion light years away. At that range a survey catches only the very brightest, so they are scattered too thinly to trace the web. The faint layer all round is quasars from Quaia, which the Gaia satellite picked out over the whole sky: the one map this deep that goes all the way round. Its redshifts come from low-resolution spectra and some are off by 10% or more; where DESI has the quasar too, DESI's is used. Zoomed out past about a billion light years, the timeline counts billions of years and runs the expansion back: every distance between galaxies shrinks with the size of the universe at the time (from Planck's numbers, which give an age of 13.8 billion years), while the Milky Way and its neighbours, bound by gravity, keep theirs. The galaxies are still today's, though; when each formed or merged is not modelled, so far back the picture fades rather than losing them one by one, and the early web was never as sharp as it looks here.",
  cmbNote: 'The gap between the galaxies and this sphere is not yet mapped, not empty.',
  galaxyNote:
    'Distances can be off by about 20%, and it thins out with distance because the data is incomplete.',
  starField:
    'Every star is at its real position, from distances measured by parallax (the HYG database). But the catalogue is only complete for stars bright enough to measure from Earth, so farther out only the very bright ones are left. That makes the stars look crowded around the Sun and thinning out, which is not true; stars in this part of the galaxy are spread about evenly. Distances beyond about a thousand light years can be well off. Seen from outside the Solar System, the stars are brightened as a long exposure would, or you would hardly see any.',
  lightKind: 'Which picture',
  eyeLight: 'Rough colours to the eye',
  webbLight: "Webb's infrared colours",
  photoKind: { visible: 'Visible light', infrared: 'Infrared' },
  photoPart: {
    part: 'Part only',
    centre: 'Centre only',
    core: 'Core only',
    ring: 'Part of the ring only',
    bar: 'The Orion Bar only',
    cliffs: 'The Cosmic Cliffs at the edge of NGC 3324 only',
    mexico: 'The "Mexico" part only',
    xray: 'With X-rays overlaid in purple',
  },
  photoMapped: (rgb: string[]) =>
    `Assigned colours, not true: red ${rgb[0]} · green ${rgb[1]} · blue ${rgb[2]}`,
  photoNote:
    'Real pictures from telescopes; tap one for the original. These are processed too: visible-light pictures often use filters for each gas, given colours of their own, and are far brighter than the eye would see.',
  irLight: 'Infrared-style colours',
  eyeNote:
    'The colours of the light each gas really gives off, but far brighter than the eye would see them, like a long-exposure photograph. To the eye it would be fainter and paler.',
  pillarsEyeNote:
    'Our own estimate, not from a photograph: to the eye it would likely be very faint, pinkish red from hydrogen, with the pillars as dark brown shadows. The familiar 1995 Hubble picture is not true colour either; each colour stands for the light of a different gas.',
  irNote:
    "Worked out from the same model by the way near-infrared pictures like Webb's usually look, not copied from an infrared picture of this nebula: infrared gets through dust, so the dust that hides things turns see-through and glows gold, and gas glowing red or teal shows blue. All of these colours stand in for light the eye can't see.",
  webbNote:
    "After Webb's infrared picture (NIRCam), which turns infrared light the eye can't see into colours, so these are not the colours you would see. Infrared gets through dust better, so the pillars look see-through; the wavy red edges at their tips are gas struck by jets from stars still forming.",
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
  shownUntil: 'Shown until',
  altitude: 'Height above the ground',
  speedEarth: 'Speed relative to Earth',
  span: 'Distance from the Sun',
  lightTime: (s: string) => `light takes ${s}`,
  retrograde: 'retrograde',
  coasting: 'After 2050, where JPL’s trajectory ends, the position is carried on under the Sun’s gravity.',
  twoBody: 'Outside the JPL data; this position comes from a two-body orbit.',
  goTo: 'Go there',
  centerOn: 'Center on it',
  centerNow: 'Centered on',
  l2: 'Lagrange point L2',
  voidEye:
    'Zooming is the observer growing or shrinking. Zoomed out to frame the void, they are big enough to see the galaxies round it; zoomed in, they are small and the same galaxies are far off for their size, so those past about three times the zoom distance dim with the square of the distance. The nearest galaxies to the middle are about 20 million light years off, and a naked eye makes out one like Andromeda only to about 10 million, so the sky there really is black. Had the Milky Way been here, we would not have known of other galaxies until big telescopes.',
  centerTipPlace: 'Turn to this and orbit it, from where the camera is now (C)',
  centerTip: 'Turn to, orbit and follow this body, from where the camera is now (C key)',
  chase: 'Face direction of travel',
  fieldNote:
    'The stars look crowded around the Sun because the catalogue is incomplete, not because they are.',
  more: 'More',
  chaseTip:
    'The camera sits behind the body in the center and looks where it is heading. Moons use their heading around their planet. When fast playback swings the heading too quickly, the camera holds still and catches up once it slows. Drag to change the angle (V key). Only while time is playing.',
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
  yearOnly: (y: number) => `Year ${y}`,

  dataError: (k: number) => `${k} problem${k === 1 ? '' : 's'} in the data`,
  dataErrorHint: 'Fix the files in data/ and this page reloads by itself.',
  loadError: 'Could not load the orbit data. Try reloading the page.',
  credits:
    'Data: NASA/JPL Horizons, JPL SBDB, astronomy-engine, HYG, CelesTrak · Textures: Solar System Scope (CC BY 4.0), NASA/JHUAPL/SwRI · Spacecraft models: NASA 3D Resources · Dwarf galaxies: Local Volume Database (Pace 2024) · Nearby galaxies: UNGC (Karachentsev 2013), PGC (Paturel 2003) · Galaxy distances: Cosmicflows-4 (Tully 2023), 2MRS (Huchra 2012), 6dFGS (Jones 2009), groups (Tully 2015, Tempel 2017), SDSS DR17, DESI DR1, Quaia (Storey-Fisher 2024) · CMB: Planck 2018 (ESA)',
};
