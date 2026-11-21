// Downloads orbits, spacecraft paths, stars and textures into public/. Run with `npm run fetch-data`.
// Pass the names of steps to run only those: `npm run fetch-data -- moons stars`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..', 'public');
const DATA = join(ROOT, 'data');
const TEX = join(ROOT, 'textures');
mkdirSync(DATA, { recursive: true });
mkdirSync(TEX, { recursive: true });

const J2000 = 2451545.0;
const GAUSS_DEG = 0.9856076686; // mean motion in deg/day of a massless body at 1 AU
const KM_PER_AU = 149597870.7;
const START = '1900-01-01';
const STOP = '2100-01-01';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (i >= tries - 1) {
        throw new Error(`${url}: ${(e as Error).message}`);
      }
      await sleep(2000 * (i + 1));
    }
  }
}

const round = (x: number, digits: number) => Number(x.toPrecision(digits));
const wrap360 = (x: number) => ((x % 360) + 360) % 360;

function save(name: string, data: unknown) {
  const path = join(DATA, name);
  writeFileSync(path, JSON.stringify(data));
  console.log(`  ${name}`);
}

// ---- small bodies ----

interface QueryResult {
  fields: string[];
  data: (string | null)[][];
  count: number;
}

function sbdbQuery(params: Record<string, string>) {
  const q = new URLSearchParams({ ...params, 'full-prec': '0' });
  return getJson<QueryResult>(`https://ssd-api.jpl.nasa.gov/sbdb_query.api?${q}`);
}

/** Flat [a, e, i, node, peri, M at J2000, H] per asteroid, in AU and degrees; H is the absolute magnitude. */
async function asteroids(sbClass: string, maxH: number) {
  const res = await sbdbQuery({
    fields: 'a,e,i,om,w,ma,epoch,H',
    'sb-class': sbClass,
    'sb-cdata': JSON.stringify({ AND: [`H|LT|${maxH}`] }),
  });
  const out: number[] = [];
  for (const row of res.data) {
    // Number(null) is 0, so a missing magnitude has to be caught first
    const [a, e, i, om, w, ma, epoch, h] = row.map((v) => (v === null ? Number.NaN : Number(v)));
    if (!(a > 0 && e < 1)) {
      continue;
    }
    const n = GAUSS_DEG / a ** 1.5;
    out.push(
      round(a, 6),
      round(e, 4),
      round(i, 4),
      round(om, 5),
      round(w, 5),
      round(wrap360(ma - n * (epoch - J2000)), 5),
      Number.isFinite(h) ? round(h, 3) : maxH,
    );
  }
  return out;
}

async function comets() {
  const res = await sbdbQuery({
    fields: 'q,e,i,om,w,tp,M1',
    'sb-kind': 'c',
    'sb-cdata': JSON.stringify({ AND: ['e|LT|1'] }),
  });
  const out: number[] = [];
  for (const row of res.data) {
    const [q, e, i, om, w, tp, m1] = row.map((v) => (v === null ? Number.NaN : Number(v)));
    if (!(q > 0 && e < 1) || Number.isNaN(tp)) {
      continue;
    }
    const a = q / (1 - e);
    const n = GAUSS_DEG / a ** 1.5;
    out.push(
      round(a, 6),
      round(e, 6),
      round(i, 4),
      round(om, 5),
      round(w, 5),
      round(wrap360(n * (J2000 - tp)), 5),
      // a comet's total magnitude, coma and all; many have none on record
      Number.isFinite(m1) ? round(m1, 3) : 15,
    );
  }
  return out;
}

async function smallBodies() {
  console.log('small bodies');
  const sets = {
    belt: await asteroids('MBA,IMB,OMB', 14.5),
    neo: await asteroids('APO,ATE,AMO,IEO', 19),
    trojans: await asteroids('TJN', 15),
    centaurs: await asteroids('CEN', 30),
    tno: await asteroids('TNO', 30),
    comets: await comets(),
  };
  for (const [k, v] of Object.entries(sets)) {
    console.log(`  ${k}: ${v.length / 7}`);
  }
  save('small-bodies.json', sets);
}

// ---- Horizons ----

type Params = Record<string, string>;

async function horizons(params: Params) {
  const q = new URLSearchParams({ format: 'json', ...params });
  const res = await getJson<{ result: string; error?: string }>(
    `https://ssd.jpl.nasa.gov/api/horizons.api?${q}`,
  );
  if (res.error) {
    throw new Error(res.error);
  }
  const r = res.result;
  const a = r.indexOf('$$SOE');
  const b = r.indexOf('$$EOE');
  if (a < 0 || b < 0) {
    throw new Error(r.slice(-600));
  }
  return r
    .slice(a + 5, b)
    .trim()
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
}

// Named minor bodies drawn as their own objects. Keys match ids in data/bodies.yaml.
// `sstr` is the SBDB search string, `hz` the Horizons command when SBDB's doesn't work there.
const NAMED: Record<string, { sstr: string; hz?: string; fine?: [string, string, string] }> = {
  ceres: { sstr: '1' },
  vesta: { sstr: '4' },
  pallas: { sstr: '2' },
  eros: { sstr: '433' },
  // the 2029 flyby bends the path within hours
  apophis: { sstr: '99942', fine: ['2029-04-10', '2029-04-17', '20m'] },
  bennu: { sstr: '101955' },
  eris: { sstr: '136199' },
  haumea: { sstr: '136108' },
  makemake: { sstr: '136472' },
  gonggong: { sstr: '225088' },
  quaoar: { sstr: '50000' },
  orcus: { sstr: '90482' },
  sedna: { sstr: '90377' },
  arrokoth: { sstr: '486958' },
  vp113: { sstr: '2012 VP113' },
  leleakuhonua: { sstr: '541132' },
  farfarout: { sstr: '2018 AG37' },
  halley: { sstr: '1P', hz: 'DES=1P;CAP;NOFRAG' },
  encke: { sstr: '2P', hz: 'DES=2P;CAP;NOFRAG' },
  'churyumov-gerasimenko': { sstr: '67P', hz: 'DES=67P;CAP;NOFRAG' },
  'hale-bopp': { sstr: 'C/1995 O1', hz: 'DES=C/1995 O1;CAP;NOFRAG' },
  hyakutake: { sstr: 'C/1996 B2', hz: 'DES=C/1996 B2;CAP;NOFRAG' },
  neowise: { sstr: 'C/2020 F3', hz: 'DES=C/2020 F3;CAP;NOFRAG' },
  'bernardinelli-bernstein': { sstr: 'C/2014 UN271', hz: 'DES=C/2014 UN271;CAP;NOFRAG' },
  'tsuchinshan-atlas': { sstr: 'C/2023 A3', hz: 'DES=C/2023 A3;CAP;NOFRAG' },
  oumuamua: { sstr: '1I', hz: 'DES=1I;' },
  borisov: { sstr: '2I', hz: 'DES=2I;' },
  atlas3i: { sstr: '3I', hz: 'DES=3I;' },
};

interface SbdbObject {
  orbit: { epoch: string; elements: { name: string; value: string | null }[] };
}

const jdOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86400000 + 2440587.5;
const dateOfJd = (jd: number) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 10);

/** Elements for the orbit lines, and a Horizons path, with planetary perturbations, for the positions. */
async function named() {
  console.log('named small bodies');
  const out: Record<string, { elements: Record<string, number>; path: number[][] }> = {};
  const [startJd, stopJd] = [jdOf(START), jdOf(STOP)];
  for (const [id, n] of Object.entries(NAMED)) {
    const res = await getJson<SbdbObject>(
      `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${encodeURIComponent(n.sstr)}`,
    );
    const el = Object.fromEntries(res.orbit.elements.map((x) => [x.name, Number(x.value)]));
    const elements = {
      epoch: Number(res.orbit.epoch),
      q: el.q,
      e: el.e,
      i: el.i,
      node: el.om,
      peri: el.w,
      tp: el.tp,
    };
    const cmd = n.hz ?? `${n.sstr};`;

    // Cubic Hermite with velocities stays within a few hundred km at about 40 samples per orbit. Through
    // perihelion the body turns about a radian every `tau` days, so those stretches get steps of tau/6.
    const period = el.e < 1 ? 365.25 * (el.q / (1 - el.e)) ** 1.5 : Number.POSITIVE_INFINITY;
    const step = Math.max(4, Math.min(365, Math.round(period / 40)));
    const tau = (58.13 * el.q ** 1.5) / Math.sqrt(1 + el.e);
    const windows: [number, number, string][] = [];
    if (step > tau / 2) {
      const half = Math.min(8 * tau, period / 4);
      const fineStep = `${Math.max(0.25, Math.round((tau / 6) * 4) / 4) * 24}h`;
      const first = Number.isFinite(period) ? el.tp - Math.ceil((el.tp - startJd) / period) * period : el.tp;
      for (let tp = first; tp < stopJd + half; tp += period) {
        if (tp + half > startJd) {
          windows.push([Math.max(startJd, tp - half), Math.min(stopJd, tp + half), fineStep]);
        }
        if (!Number.isFinite(period)) {
          break;
        }
      }
    }
    if (n.fine) {
      windows.push([jdOf(n.fine[0]), jdOf(n.fine[1]), n.fine[2]]);
    }
    let path = await vectorsWithin(cmd, START, STOP, `${step}d`);
    for (const [a, b, fineStep] of windows) {
      path = splice(path, await vectorsWithin(cmd, dateOfJd(a), dateOfJd(b), fineStep));
    }
    out[id] = { elements, path };
    console.log(`  ${id}: ${path.length} points, every ${step} d and ${windows.length} fine windows`);
  }
  save('named.json', out);
}

/** Like vectors(), but narrows the span to the dates Horizons has for the target. */
async function vectorsWithin(
  command: string,
  start: string,
  stop: string,
  step: string,
): Promise<number[][]> {
  try {
    return await vectors(command, start, stop, step);
  } catch (e) {
    const msg = (e as Error).message;
    const m = /(prior to|after) A\.D\. (\d{4})-([A-Z]{3})-(\d{2})/i.exec(msg);
    if (!m) {
      throw e;
    }
    const month = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.indexOf(m[3].toUpperCase()) / 3;
    const shift = m[1].toLowerCase() === 'after' ? -1 : 1;
    const edge = new Date(Date.UTC(Number(m[2]), month, Number(m[4]) + shift)).toISOString().slice(0, 10);
    const [a, b] = shift > 0 ? [edge, stop] : [start, edge];
    if (a >= b) {
      return [];
    }
    return vectorsWithin(command, a, b, step);
  }
}

/** Heliocentric ecliptic state vectors [jd, x, y, z, vx, vy, vz] in AU and AU/day. */
async function vectors(command: string, start: string, stop: string, step: string, center = '500@10') {
  const rows = await horizons({
    COMMAND: `'${command}'`,
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${center}'`,
    START_TIME: `'${start}'`,
    STOP_TIME: `'${stop}'`,
    STEP_SIZE: `'${step}'`,
    VEC_TABLE: '2',
    REF_PLANE: 'ECLIPTIC',
    OUT_UNITS: "'AU-D'",
    CSV_FORMAT: 'YES',
  });
  return rows.map((r) => {
    const [jd, , x, y, z, vx, vy, vz] = r.map(Number);
    return [jd, round(x, 9), round(y, 9), round(z, 9), round(vx, 7), round(vy, 7), round(vz, 7)];
  });
}

// GM of the Sun plus the planets in AU^3/day^2: seen from beyond Neptune they pull as one mass
const GM_SYSTEM = 0.01720209895 ** 2 * 1.00134;

/** Carries a coasting craft on from its last state to `until` (JD), under the Solar System's gravity alone. */
function coast(last: number[], until: number, step: number) {
  const out: number[][] = [];
  let [t, x, y, z, vx, vy, vz] = last;
  const acc = (px: number, py: number, pz: number) => {
    const r3 = Math.hypot(px, py, pz) ** 3;
    return [(-GM_SYSTEM * px) / r3, (-GM_SYSTEM * py) / r3, (-GM_SYSTEM * pz) / r3];
  };
  const sub = 10;
  const h = step / sub;
  while (t < until) {
    for (let k = 0; k < sub; k++) {
      // velocity Verlet
      const a0 = acc(x, y, z);
      x += vx * h + 0.5 * a0[0] * h * h;
      y += vy * h + 0.5 * a0[1] * h * h;
      z += vz * h + 0.5 * a0[2] * h * h;
      const a1 = acc(x, y, z);
      vx += 0.5 * (a0[0] + a1[0]) * h;
      vy += 0.5 * (a0[1] + a1[1]) * h;
      vz += 0.5 * (a0[2] + a1[2]) * h;
    }
    t += step;
    out.push([t, round(x, 10), round(y, 10), round(z, 10), round(vx, 8), round(vy, 8), round(vz, 8)]);
  }
  return out;
}

// Elements are snapshot every `step` days. Between two snapshots the app interpolates every element linearly,
// except the mean longitude, which advances at the rate that lands exactly on the next snapshot.
const MOONS: Record<string, { id: string; center: string; period: number }> = {
  phobos: { id: '401', center: '499', period: 0.31891 },
  deimos: { id: '402', center: '499', period: 1.26244 },
  mimas: { id: '601', center: '699', period: 0.942422 },
  enceladus: { id: '602', center: '699', period: 1.370218 },
  tethys: { id: '603', center: '699', period: 1.887802 },
  dione: { id: '604', center: '699', period: 2.736915 },
  rhea: { id: '605', center: '699', period: 4.518212 },
  titan: { id: '606', center: '699', period: 15.945421 },
  hyperion: { id: '607', center: '699', period: 21.276609 },
  iapetus: { id: '608', center: '699', period: 79.330183 },
  phoebe: { id: '609', center: '699', period: 548.02 },
  miranda: { id: '705', center: '799', period: 1.413479 },
  ariel: { id: '701', center: '799', period: 2.520379 },
  umbriel: { id: '702', center: '799', period: 4.144177 },
  titania: { id: '703', center: '799', period: 8.705872 },
  oberon: { id: '704', center: '799', period: 13.463239 },
  triton: { id: '801', center: '899', period: 5.876854 },
  nereid: { id: '802', center: '899', period: 360.13 },
  charon: { id: '901', center: '999', period: 6.387221 },
};

async function moons() {
  console.log('moons');
  const out: Record<string, { step: number; t0: number; rows: number[][] }> = {};
  for (const [name, m] of Object.entries(MOONS)) {
    const step = Math.max(5, Math.min(365, Math.round(m.period * 12)));
    const rows = await horizons({
      COMMAND: `'${m.id}'`,
      EPHEM_TYPE: 'ELEMENTS',
      CENTER: `'500@${m.center}'`,
      START_TIME: `'${START}'`,
      STOP_TIME: `'${STOP}'`,
      STEP_SIZE: `'${step}d'`,
      REF_PLANE: 'ECLIPTIC',
      OUT_UNITS: "'KM-D'",
      CSV_FORMAT: 'YES',
    });
    // JDTDB, date, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
    const snaps = rows.map((r) => {
      const [jd, , ec, , inc, om, w, , n, ma, , a] = r.map(Number);
      return { jd, a: a / KM_PER_AU, e: ec, i: inc, node: om, peri: om + w, lon: om + w + ma, n };
    });
    let worst = 0;
    const packed: number[][] = [];
    for (let k = 0; k < snaps.length; k++) {
      const s = snaps[k];
      const next = snaps[k + 1];
      let rate = s.n;
      if (next) {
        // how far the mean longitude really moved, choosing the whole turns from the osculating mean motion
        const dt = next.jd - s.jd;
        const guess = ((s.n + next.n) / 2) * dt;
        const frac = wrap360(next.lon - s.lon);
        const turns = Math.round((guess - frac) / 360);
        worst = Math.max(worst, Math.abs((guess - frac) / 360 - turns));
        rate = (frac + 360 * turns) / dt;
      }
      packed.push([
        round(s.a, 8),
        round(s.e, 5),
        round(s.i, 6),
        round(wrap360(s.node), 6),
        round(wrap360(s.peri), 6),
        round(wrap360(s.lon), 7),
        round(rate, 9),
      ]);
    }
    // near 0.5 the turn count above is a guess; shorten the step for that moon
    if (worst > 0.3) {
      console.warn(`  ${name}: mean-longitude rounding off by up to ${worst.toFixed(2)} turn`);
    }
    out[name] = { step, t0: snaps[0].jd, rows: packed };
    console.log(`  ${name}: ${packed.length} snapshots every ${step} d`);
  }
  save('moons.json', out);
}

const CRAFT: Record<string, { id: string; start: string }> = {
  'pioneer-10': { id: '-23', start: '1972-03-04' },
  'pioneer-11': { id: '-24', start: '1973-04-07' },
  'voyager-1': { id: '-31', start: '1977-09-06' },
  'voyager-2': { id: '-32', start: '1977-08-21' },
  'new-horizons': { id: '-98', start: '2006-01-20' },
};

// Fine steps around the planetary flybys, coarse once the craft is coasting out.
const CRAFT_FINE_UNTIL: Record<string, string> = {
  'pioneer-10': '1975-01-01',
  'pioneer-11': '1981-01-01',
  'voyager-1': '1982-01-01',
  'voyager-2': '1991-01-01',
  'new-horizons': '2020-01-01',
};

// Closest approaches, where the path bends within hours; each gets 10-minute samples for two days either side.
// A spacecraft's trajectory file carries the planet ephemeris of its day, which for Neptune in 1989 sits some
// 5,000 km from today's. Measured from its own planet the pass is right, so those windows are fetched relative to
// the planet and moved onto the planet's current position.
const FLYBYS: Record<string, [string, string | null][]> = {
  'pioneer-10': [['1973-12-04', '599']],
  'pioneer-11': [
    ['1974-12-03', '599'],
    ['1979-09-01', '699'],
  ],
  'voyager-1': [
    ['1979-03-05', '599'],
    ['1980-11-12', '699'],
  ],
  'voyager-2': [
    ['1979-07-09', '599'],
    ['1981-08-26', '699'],
    ['1986-01-24', '799'],
    ['1989-08-25', '899'],
  ],
  'new-horizons': [
    ['2007-02-28', '599'],
    ['2015-07-14', '999'],
    ['2019-01-01', null],
  ],
};

async function flyby(craft: string, date: string, planet: string | null) {
  const [a, b] = [shiftDate(date, -2), shiftDate(date, 2)];
  if (!planet) {
    return vectors(craft, a, b, '10m');
  }
  const rel = await vectors(craft, a, b, '10m', `500@${planet}`);
  const base = await vectors(planet, a, b, '10m');
  return rel.map((r, i) => [r[0], ...r.slice(1).map((v, c) => round(v + base[i][c + 1], c < 3 ? 9 : 7))]);
}

const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Replaces the samples between the first and last row of `fine` with `fine`. */
function splice(path: number[][], fine: number[][]) {
  if (!fine.length) {
    return path;
  }
  const [lo, hi] = [fine[0][0], fine[fine.length - 1][0]];
  return [...path.filter((r) => r[0] < lo), ...fine, ...path.filter((r) => r[0] > hi)];
}

async function spacecraft() {
  console.log('spacecraft');
  const out: Record<string, { path: number[][]; coastFrom: number | null }> = {};
  for (const [name, c] of Object.entries(CRAFT)) {
    const fineUntil = CRAFT_FINE_UNTIL[name];
    const fine = await vectors(c.id, c.start, fineUntil, '12h');
    const coarse = await vectorsWithin(c.id, fineUntil, STOP, '20d');
    let path = [...fine, ...coarse.slice(1)];
    for (const [date, planet] of FLYBYS[name] ?? []) {
      path = splice(path, await flyby(c.id, date, planet));
    }
    const last = path[path.length - 1];
    const stopJd = jdOf(STOP);
    const coastFrom = last[0] < stopJd - 1 ? last[0] : null;
    if (coastFrom) {
      path.push(...coast(last, stopJd, 20));
    }
    out[name] = { path, coastFrom };
    console.log(
      `  ${name}: ${path.length} points${coastFrom ? ', coasting after the Horizons data ends' : ''}`,
    );
  }
  out.jwst = await webbPath();
  save('spacecraft.json', out);
}

// JWST from Earth's centre, which is what its halo orbit round L2 is drawn against: fine steps through the
// month-long cruise, then every two days. Horizons' predicted path stops in November 2031 and nothing is made up
// past it.
const WEBB = { id: '-170', start: '2021-12-25 13:05', cruise: '2022-02-01', end: '2031-11-08' };
async function webbPath() {
  const cruise = await vectors(WEBB.id, WEBB.start, WEBB.cruise, '3h', '500@399');
  const halo = await vectors(WEBB.id, WEBB.cruise, WEBB.end, '2d', '500@399');
  const path = [...cruise, ...halo.slice(1)];
  console.log(`  jwst: ${path.length} points`);
  return { path, coastFrom: null };
}

async function webb() {
  console.log('webb');
  const file = join(DATA, 'spacecraft.json');
  const out = JSON.parse(readFileSync(file, 'utf8'));
  out.jwst = await webbPath();
  save('spacecraft.json', out);
}

// The truncated VSOP87 in astronomy-engine puts the outer planets up to a few hundred thousand km off, which
// shows when a spacecraft flies past them. These get JPL's own paths. They are system barycenters: the planet
// itself wobbles with its moons faster than these steps can follow, by a few hundred km, except Pluto, which the
// app moves off its barycenter using Charon.
const PLANETS: Record<string, { id: string; step: string }> = {
  jupiter: { id: '5', step: '10d' },
  saturn: { id: '6', step: '20d' },
  uranus: { id: '7', step: '40d' },
  neptune: { id: '8', step: '40d' },
  pluto: { id: '9', step: '40d' },
};

async function planets() {
  console.log('planets');
  const out: Record<string, number[][]> = {};
  for (const [name, pl] of Object.entries(PLANETS)) {
    out[name] = await vectors(pl.id, START, STOP, pl.step);
    console.log(`  ${name}: ${out[name].length} points`);
  }
  save('planets.json', out);
}

// ---- stars ----

// Every star with a usable distance within FIELD_LY goes into field.bin at its real 3D position, and the app
// works out how bright it looks from wherever the camera is. Naked-eye stars without one stay on the sky sphere.
const MAG_LIMIT = 6.8;
const FIELD_LY = 3000;
const NEAR_LY = 17;
const LY_PER_PC = 3.26156;
// HYG gives 100000 pc to stars with no parallax
const NO_DIST = 100000;

const GREEK: Record<string, string> = {
  Alp: 'α',
  Bet: 'β',
  Gam: 'γ',
  Del: 'δ',
  Eps: 'ε',
  Zet: 'ζ',
  Eta: 'η',
  The: 'θ',
  Iot: 'ι',
  Kap: 'κ',
  Lam: 'λ',
  Mu: 'μ',
  Nu: 'ν',
  Xi: 'ξ',
  Omi: 'ο',
  Pi: 'π',
  Rho: 'ρ',
  Sig: 'σ',
  Tau: 'τ',
  Ups: 'υ',
  Phi: 'φ',
  Chi: 'χ',
  Psi: 'ψ',
  Ome: 'ω',
};

async function stars() {
  console.log('stars');
  const res = await fetch(
    'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  );
  const text = await res.text();
  const lines = text.split('\n');
  const head = lines[0].split(',').map((s) => s.replace(/"/g, ''));
  const col = (k: string) => head.indexOf(k);
  const [cRa, cDec, cMag, cCi, cDist, cProper, cX, cY, cZ, cCon, cBayer, cFlam, cGl] = [
    'ra',
    'dec',
    'mag',
    'ci',
    'dist',
    'proper',
    'x',
    'y',
    'z',
    'con',
    'bayer',
    'flam',
    'gl',
  ].map(col);
  const sky: number[] = [];
  const field: number[] = [];
  // [index into the field, name]: nearby stars by any catalogue name, farther ones only by a proper name
  const labels: [number, string][] = [];
  const eps = (23.4392911 * Math.PI) / 180;
  for (const line of lines.slice(2)) {
    const f = line.split(',').map((s) => s.replace(/"/g, ''));
    if (f.length < head.length) {
      continue;
    }
    const mag = Number(f[cMag]);
    const ci = Number(f[cCi]) || 0.6;
    const dist = Number(f[cDist]);
    const ly = dist * LY_PER_PC;
    if (!(dist > 0 && dist < NO_DIST && ly < FIELD_LY)) {
      if (mag < MAG_LIMIT) {
        sky.push(round(Number(f[cRa]) * 15, 6), round(Number(f[cDec]), 6), round(mag, 3), round(ci, 3));
      }
      continue;
    }
    // HYG x, y, z are equatorial parsecs; turn them into ecliptic light years
    const x = Number(f[cX]) * LY_PER_PC;
    const y = Number(f[cY]) * LY_PER_PC;
    const z = Number(f[cZ]) * LY_PER_PC;
    const absmag = mag - 5 * (Math.log10(dist) - 1);
    const i = field.length / 5;
    field.push(x, y * Math.cos(eps) + z * Math.sin(eps), -y * Math.sin(eps) + z * Math.cos(eps), absmag, ci);
    let name = f[cProper];
    if (!name && ly < NEAR_LY) {
      // Bayer or Flamsteed with the constellation, else the Gliese number
      const greek = GREEK[f[cBayer].replace(/-\d+$/, '')];
      name = greek ? `${greek} ${f[cCon]}` : f[cFlam] ? `${f[cFlam]} ${f[cCon]}` : f[cGl];
    }
    if (name && name !== 'Sol') {
      labels.push([i, name]);
    }
  }
  console.log(`  ${field.length / 5} stars in 3D, ${sky.length / 4} on the sky only, ${labels.length} named`);
  writeFileSync(join(DATA, 'field.bin'), Buffer.from(new Float32Array(field).buffer));
  save('stars.json', { sky, labels });
}

// ---- textures ----

// Solar System Scope, CC BY 4.0 (https://www.solarsystemscope.com/textures/)
const TEXTURES = [
  'sun',
  'mercury',
  'venus_surface',
  'venus_atmosphere',
  'earth_daymap',
  'earth_nightmap',
  'earth_clouds',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'saturn_ring_alpha',
  'uranus',
  'neptune',
  'ceres_fictional',
  'eris_fictional',
  'haumea_fictional',
  'makemake_fictional',
];

// maps from elsewhere: New Horizons' Pluto mosaic (NASA/JHUAPL/SwRI, public domain), via Wikimedia's 1920px copy
const OTHER_TEXTURES: Record<string, string> = {
  pluto_newhorizons:
    'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ad/Pluto_color_mapmosaic.jpg/1920px-Pluto_color_mapmosaic.jpg',
  // PIA19866, grey, sub-Pluto longitude at the center
  charon_newhorizons:
    'https://assets.science.nasa.gov/dynamicimage/assets/science/psd/photojournal/pia/pia19/pia19866/PIA19866.jpg?w=2048',
};

async function textures() {
  console.log('textures');
  for (const [name, url] of Object.entries(OTHER_TEXTURES)) {
    const file = join(TEX, `${name}.jpg`);
    if (existsSync(file)) {
      continue;
    }
    const res = await fetch(url, { headers: { 'User-Agent': 'solar-system-demo/1.0' } });
    if (!res.ok) {
      console.warn(`  ${name}: ${res.status}`);
      continue;
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${name}.jpg`);
  }
  for (const name of TEXTURES) {
    const ext = name.endsWith('alpha') ? 'png' : 'jpg';
    const file = join(TEX, `${name}.${ext}`);
    if (existsSync(file)) {
      continue;
    }
    const res = await fetch(`https://www.solarsystemscope.com/textures/download/2k_${name}.${ext}`);
    if (!res.ok) {
      console.warn(`  ${name}: ${res.status}`);
      continue;
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${name}.${ext}`);
  }
}

// ---- the Local Group ----

// Dwarf galaxies from the Local Volume Database (Pace et al. 2024), kept up to date with each new discovery:
// the confirmed ones within 3 Mpc, which takes in the Local Group and a little past it. The Magellanic Clouds have
// their own entries in regions.yaml, and so do the spirals, which the database leaves out.
const LVDB = 'https://raw.githubusercontent.com/apace7/local_volume_database/v1.1.2/data/dwarf_all.csv';
const LG_SKIP = new Set(['lmc', 'smc']);
// these move with Andromeda on the Galaxy's timeline
const M31_HOSTS = new Set(['m_031', 'm_033']);

async function localGroup() {
  console.log('local group');
  const res = await fetch(LVDB);
  const [head, ...lines] = (await res.text()).trim().split('\n');
  const keys = head.split(',');
  const num = (v: string | undefined) => (v === undefined || v === '' || v === 'nan' ? null : Number(v));
  // name, RA and Dec (deg), distance (kpc), half-light radius (pc), absolute V magnitude, M31 when it is in
  // Andromeda's group, and dIrr for gas-rich ones (else dSph)
  const out: [string, number, number, number, number, number, string, string][] = [];
  for (const line of lines) {
    // no field in the columns used has a comma, but later ones can be quoted; split only up to what we need
    const cells =
      line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')) ?? [];
    const row = Object.fromEntries(keys.map((k, i) => [k, cells[i]]));
    const kpc = num(row.distance);
    if (row.confirmed_real !== '1' || LG_SKIP.has(row.key) || !kpc || kpc > 3000) {
      continue;
    }
    const arcmin = num(row.rhalf);
    const pc = num(row.rhalf_physical) ?? (arcmin ? kpc * 1000 * ((arcmin / 60) * (Math.PI / 180)) : 300);
    out.push([
      row.name,
      round(Number(row.ra), 6),
      round(Number(row.dec), 6),
      round(kpc, 4),
      Math.round(pc),
      num(row.M_V) ?? -8,
      M31_HOSTS.has(row.host) ? 'M31' : row.host,
      num(row.mass_HI) ? 'dIrr' : 'dSph',
    ]);
  }
  save('localgroup.json', out);
}

// ---- the Local Volume ----

// Every galaxy within about 11 Mpc in the Updated Nearby Galaxy Catalog (Karachentsev et al. 2013), past the 3 Mpc
// the Local Volume Database covers above, plus the few big ones closer in that it leaves out because they are not
// dwarfs. The catalogue has each galaxy's size, axis ratio and inclination but not which way it lies on the sky,
// so the position angle comes from the PGC (Paturel et al. 2003), matched by position. It has none for round,
// face-on disks and a few of the best known are off, so those are set by hand from the papers that measured them.
const VIZIER = 'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-out.all&-out.max=200000&-source=';
const LV_CLOSE = new Set(['Maffei1', 'Maffei2', 'Dw1', 'Dw2']);
const LV_ANGLES: Record<string, { pa: number; incl?: number }> = {
  NGC0628: { pa: 20, incl: 7 }, // M74, Walter et al. 2008 (THINGS)
  NGC3184: { pa: 179, incl: 16 }, // THINGS
  MESSIER101: { pa: 39, incl: 18 }, // THINGS
  NGC6946: { pa: 63, incl: 33 }, // THINGS
  NGC3344: { pa: 155, incl: 18 }, // Verdes-Montenegro et al. 2000
  NGC5194: { pa: 173, incl: 22 }, // M51, Colombo et al. 2014
  NGC5236: { pa: 45, incl: 24 }, // M83, Lundgren et al. 2004
  IC0342: { pa: 37, incl: 31 }, // Crosthwaite et al. 2000
  NGC4258: { pa: 150, incl: 72 }, // M106, van Albada 1980
  NGC4594: { pa: 90, incl: 84 }, // Sombrero, Emsellem 1995
  NGC3115: { pa: 43 }, // Capaccioli et al. 1987
  Maffei1: { pa: 84 }, // Fingerhut et al. 2003
  Maffei2: { pa: 26, incl: 67 }, // Hurt et al. 1996
  Dw1: { pa: 113, incl: 50 }, // Dwingeloo 1, Burton et al. 1996
};

async function vizier(source: string) {
  let lines: string[] = [];
  // the mirror now and then answers with an empty table; asking again is enough
  for (let k = 0; k < 4 && !lines.length; k++) {
    lines = (await (await fetch(VIZIER + source)).text())
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    if (!lines.length) {
      await sleep(2000);
    }
  }
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines
    .slice(3)
    .map((l) => l.split('\t'))
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i].trim()])));
}

const sexagesimal = (s: string, hours: boolean) => {
  const [a, b, c = '0'] = s.split(/\s+/);
  const v = Math.abs(Number(a)) + Number(b) / 60 + Number(c) / 3600;
  return (s.startsWith('-') ? -v : v) * (hours ? 15 : 1);
};

// the catalogue names most Messier galaxies by NGC number
const MESSIER: Record<string, string> = {
  NGC0628: 'M74',
  NGC3351: 'M95',
  NGC3368: 'M96',
  NGC3379: 'M105',
  NGC3623: 'M65',
  NGC3627: 'M66',
  NGC4258: 'M106',
  NGC4594: 'M104',
  NGC4736: 'M94',
  NGC4826: 'M64',
  NGC5055: 'M63',
  NGC5194: 'M51',
  NGC5195: 'M51b',
  NGC5236: 'M83',
};

// MESSIER081 to M81, NGC0253 to NGC 253
const prettyName = (n: string) =>
  MESSIER[n] ??
  n
    .replace(/^MESSIER0*(\d+)/, 'M$1')
    .replace(/^(NGC|IC|UGCA|UGC|DDO|PGC|KK|KKH|KKR|KKS)0*(\d)/, '$1 $2')
    .replace(/^Maffei(\d)/, 'Maffei $1')
    .replace(/^Dw(\d)/, 'Dwingeloo $1');

async function localVolume() {
  console.log('local volume');
  const pas = new Map<string, { ra: number; dec: number; pa: number }[]>();
  // only galaxies over a minute of arc across, which every one in the Local Volume is
  for (const r of await vizier('VII/237&logD25=%3E0.9')) {
    if (!r.PA) {
      continue;
    }
    const ra = sexagesimal(r.RAJ2000, true);
    const dec = sexagesimal(r.DEJ2000, false);
    const key = `${Math.round(ra)},${Math.round(dec)}`;
    pas.set(key, [...(pas.get(key) ?? []), { ra, dec, pa: Number(r.PA) }]);
  }
  const paAt = (ra: number, dec: number) => {
    let best: { d: number; pa: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const c of pas.get(`${Math.round(ra) + dx},${Math.round(dec) + dy}`) ?? []) {
          const d = Math.hypot((c.ra - ra) * Math.cos((dec * Math.PI) / 180), c.dec - dec) * 60;
          if (d < 1 && (!best || d < best.d)) {
            best = { d, pa: c.pa };
          }
        }
      }
    }
    return best?.pa ?? null;
  };
  // name, RA, Dec (deg), distance (Mpc), Holmberg diameter (kpc), axis ratio, inclination (deg), morphological
  // type T, absolute B magnitude, position angle (deg, or null when none is known)
  const out: [string, number, number, number, number, number, number, number, number, number | null][] = [];
  for (const r of await vizier('J/AJ/145/101')) {
    const mpc = Number(r.Dist);
    if (!mpc || (mpc <= 3 && !LV_CLOSE.has(r.Name)) || r.Name === 'Milky Way') {
      continue;
    }
    const ra = sexagesimal(r.RAJ2000, true);
    const dec = sexagesimal(r.DEJ2000, false);
    out.push([
      prettyName(r.Name),
      round(ra, 6),
      round(dec, 6),
      mpc,
      Number(r.A26) || 3,
      Number(r['b/a']) || 1,
      LV_ANGLES[r.Name]?.incl ?? (Number(r.i) || 0),
      r.TT === '' ? 10 : Number(r.TT),
      Number(r.BMag) || -14,
      LV_ANGLES[r.Name]?.pa ?? paAt(ra, dec),
    ]);
  }
  save('localvolume.json', out);
}

// ---- Cosmicflows-4 ----

// The 55,877 galaxies with measured distances in Cosmicflows-4 (Tully et al. 2023), out to about 800 Mpc. A
// single galaxy's distance is off by 20% or so, which would smear every cluster into a long streak pointing
// at us, so galaxies in one group (the catalogue's 1PGC) all take the group's error-weighted mean. Those
// already in the Local Volume are left out. Each galaxy is three uint16: RA and Dec scaled to the full range,
// and distance in units of COSMICFLOWS_MPC.
const COSMICFLOWS_MPC = 1 / 64;

async function cosmicflows() {
  console.log('cosmicflows');
  const rows = (await vizier('J/ApJ/944/94/table2')).filter((r) => r.DM);
  const groups = new Map<string, { sum: number; w: number }>();
  for (const r of rows) {
    const w = 1 / Math.max(Number(r.e_DM), 0.05) ** 2;
    const g = groups.get(r['1PGC']) ?? { sum: 0, w: 0 };
    g.sum += Number(r.DM) * w;
    g.w += w;
    groups.set(r['1PGC'], g);
  }
  const near = (JSON.parse(readFileSync(join(DATA, 'localvolume.json'), 'utf8')) as number[][]).map(
    ([, ra, dec]) => [ra, dec],
  );
  const out: number[] = [];
  for (const r of rows) {
    const ra = Number(r.RAJ2000);
    const dec = Number(r.DEJ2000);
    const g = groups.get(r['1PGC']);
    const mpc = 10 ** (((g ? g.sum / g.w : Number(r.DM)) - 25) / 5);
    const dup = near.some(
      ([a, d]) => Math.abs(d - dec) < 0.03 && Math.abs(a - ra) * Math.cos((dec * Math.PI) / 180) < 0.03,
    );
    if (dup || mpc / COSMICFLOWS_MPC > 65535) {
      continue;
    }
    out.push(
      Math.round((ra / 360) * 65535),
      Math.round(((dec + 90) / 180) * 65535),
      Math.round(mpc / COSMICFLOWS_MPC),
    );
  }
  writeFileSync(join(DATA, 'cosmicflows.bin'), Buffer.from(new Uint16Array(out).buffer));
  console.log(`  ${out.length / 3} galaxies`);
}

// ---- 2MRS ----

// The 2MASS Redshift Survey (Huchra et al. 2012) is complete over almost the whole sky to K = 11.75, where the
// galaxies with measured distances above are patchy. Its galaxies have only a redshift, so their distance is
// their velocity over H0 = 75, the scale Cosmicflows-4 is on. Taken as it is, a cluster's members spread along
// our line of sight by their own orbital speeds; Tully (2015) sorted the survey into groups, and each galaxy
// here sits at its group's mean velocity instead. Galaxies already in Cosmicflows-4 or the Local Volume are
// left out. Same packing as cosmicflows.bin.
const H0 = 75;

async function redshifts() {
  console.log('2mrs');
  const measured = new Set((await vizier('J/ApJ/944/94/table2')).map((r) => r.PGC));
  const near = (JSON.parse(readFileSync(join(DATA, 'localvolume.json'), 'utf8')) as number[][]).map(
    ([, ra, dec]) => [ra, dec],
  );
  const out: number[] = [];
  for (const r of await vizier('J/AJ/149/171/table5')) {
    const v = Number(r['<Vcmba>'] || r.Vcmba);
    if (measured.has(r.PGC) || !(v > 0)) {
      continue;
    }
    const ra = Number(r['_RA.icrs']);
    const dec = Number(r['_DE.icrs']);
    const z = v / 299792.458;
    // to first order in z for an accelerating universe (q0 = -0.55)
    const mpc = (v / H0) * (1 - 0.225 * z);
    const dup = near.some(
      ([a, d]) => Math.abs(d - dec) < 0.03 && Math.abs(a - ra) * Math.cos((dec * Math.PI) / 180) < 0.03,
    );
    if (dup || mpc / COSMICFLOWS_MPC > 65535) {
      continue;
    }
    out.push(
      Math.round((ra / 360) * 65535),
      Math.round(((dec + 90) / 180) * 65535),
      Math.round(mpc / COSMICFLOWS_MPC),
    );
  }
  writeFileSync(join(DATA, 'redshifts.bin'), Buffer.from(new Uint16Array(out).buffer));
  console.log(`  ${out.length / 3} galaxies`);
}

// ---- 6dFGS ----

// The 6dF Galaxy Survey (Jones et al. 2009): the southern sky that SDSS left out, about 125,000 redshifts out to
// z of 0.2 or so. Only reliable redshifts (quality 3 and 4), placed like the 2MRS ones, by redshift, and left out
// where Cosmicflows-4 or 2MRS has the galaxy already. Written in the same units as those, and drawn with them.
const SIXDF =
  'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=VII/259/6dfgs&-out.max=200000&-out=RAJ2000%20DEJ2000%20cz%20q_cz';

async function sixdf() {
  console.log('6dfgs');
  const drawn = new Set<string>();
  const cell = (ra: number, dec: number) => `${Math.round(ra * 50)},${Math.round(dec * 50)}`;
  for (const file of ['cosmicflows.bin', 'redshifts.bin']) {
    const a = new Uint16Array(readFileSync(join(DATA, file)).buffer.slice(0));
    for (let i = 0; i < a.length; i += 3) {
      const ra = (a[i] / 65535) * 360;
      const dec = (a[i + 1] / 65535) * 180 - 90;
      // the neighbouring cells too, so a galaxy on a cell's edge still matches
      for (const dr of [-0.02, 0, 0.02]) {
        for (const dd of [-0.02, 0, 0.02]) {
          drawn.add(cell(ra + dr / Math.max(0.1, Math.cos((dec * Math.PI) / 180)), dec + dd));
        }
      }
    }
  }
  let text = '';
  for (let k = 0; k < 4 && !text.includes('\t'); k++) {
    text = await (await fetch(SIXDF)).text();
  }
  const out: number[] = [];
  let total = 0;
  for (const line of text.split('\n')) {
    const [raS, decS, czS, q] = line.split('\t').map((x) => x.trim());
    const cz = Number(czS);
    if (!/^\d\d \d\d/.test(raS ?? '') || !(Number(q) >= 3) || !(cz > 600)) {
      continue;
    }
    total++;
    const ra = sexagesimal(raS, true);
    const dec = sexagesimal(decS, false);
    // to the frame of the microwave background, like the 2MRS velocities: the Sun moves 370 km/s toward
    // RA 168, Dec -7
    const r = Math.PI / 180;
    const cmb =
      cz +
      369.8 *
        (Math.sin(dec * r) * Math.sin(-6.9 * r) +
          Math.cos(dec * r) * Math.cos(-6.9 * r) * Math.cos((ra - 168) * r));
    const mpc = comoving(cmb / 299792.458);
    if (drawn.has(cell(ra, dec)) || mpc / COSMICFLOWS_MPC > 65535) {
      continue;
    }
    out.push(
      Math.round((ra / 360) * 65535),
      Math.round(((dec + 90) / 180) * 65535),
      Math.round(mpc / COSMICFLOWS_MPC),
    );
  }
  writeFileSync(join(DATA, 'sixdf.bin'), Buffer.from(new Uint16Array(out).buffer));
  console.log(`  ${out.length / 3} of ${total} not drawn already`);
}

// ---- SDSS ----

// Every galaxy with a good redshift in SDSS DR17, about 2.4 million out to z = 0.8, over the third of the sky
// the survey covered. They are placed at their comoving distance, where they are now, on the same H0 = 75 scale
// (flat, Omega_m = 0.3). Below z = 0.2 Tempel et al. (2017) grouped the main sample and corrected each galaxy's
// distance for its orbit in its group; those are used where they exist. Galaxies already drawn from
// Cosmicflows-4 or 2MRS are left out. The rest go out in a random order, split into a first SDSS_FIRST and
// then SDSS_CHUNK at a time, so the app can show the first file at once and fill in the picture as the others
// arrive: any prefix of the order is an even sample of the whole. Distances in units of 1/16 Mpc.
const SDSS_SQL = 'https://skyserver.sdss.org/dr17/SkyServerWS/SearchTools/SqlSearch';
const SDSS_FIRST = 100000;
const SDSS_CHUNK = 300000;
const SDSS_MPC = 1 / 16;
const TEMPEL_H0 = 67.77;

function comoving(z: number) {
  // Simpson's rule on c / H(z)
  const n = 64;
  const e = (x: number) => 1 / Math.sqrt(0.3 * (1 + x) ** 3 + 0.7);
  let s = e(0) + e(z);
  for (let i = 1; i < n; i++) {
    s += (i % 2 ? 4 : 2) * e((z * i) / n);
  }
  return ((299792.458 / H0) * s * z) / (3 * n);
}

async function sdss() {
  console.log('sdss');
  const corrected = new Map<string, number>();
  const tempel = await (
    await fetch(
      'https://vizier.cfa.harvard.edu/viz-bin/asu-tsv?-source=J/A%2BA/602/A100/table1&-out=specID%20Distcor&-out.max=1000000',
    )
  ).text();
  for (const line of tempel.split('\n')) {
    const [id, d] = line.split('\t').map((s) => s.trim());
    if (/^\d+$/.test(id) && Number(d) > 0) {
      corrected.set(id, (Number(d) * TEMPEL_H0) / H0);
    }
  }
  console.log(`  ${corrected.size} with group-corrected distances`);

  // what is drawn already, on a 0.02 degree grid
  const drawn = new Map<string, number[]>();
  for (const [file, unit] of [
    ['cosmicflows.bin', COSMICFLOWS_MPC],
    ['redshifts.bin', COSMICFLOWS_MPC],
  ] as const) {
    const d = new Uint16Array(readFileSync(join(DATA, file)).buffer.slice(0));
    for (let i = 0; i < d.length; i += 3) {
      const ra = (d[i] / 65535) * 360;
      const dec = (d[i + 1] / 65535) * 180 - 90;
      const key = `${Math.round(ra * 50)},${Math.round(dec * 50)}`;
      drawn.set(key, [...(drawn.get(key) ?? []), d[i + 2] * unit]);
    }
  }
  const already = (ra: number, dec: number, mpc: number) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const near = drawn.get(`${Math.round(ra * 50) + dx},${Math.round(dec * 50) + dy}`);
        if (near?.some((m) => Math.abs(m - mpc) < 0.15 * mpc)) {
          return true;
        }
      }
    }
    return false;
  };

  const rows: number[][] = [];
  let skipped = 0;
  for (let ra = 0; ra < 360; ra += 10) {
    const sql = `SELECT specObjID, ra, dec, z FROM SpecObj WHERE class='GALAXY' AND zWarning=0 AND sciencePrimary=1 AND z BETWEEN 0.01 AND 0.8 AND ra >= ${ra} AND ra < ${ra + 10}`;
    let text = '';
    // the server drops connections now and then
    for (let k = 0; k < 8 && !text.includes('specObjID'); k++) {
      try {
        text = await (await fetch(`${SDSS_SQL}?format=csv&cmd=${encodeURIComponent(sql)}`)).text();
      } catch {
        await sleep(5000 * (k + 1));
      }
    }
    if (!text.includes('specObjID')) {
      throw new Error(`sdss: no answer for RA ${ra}`);
    }
    for (const line of text.split('\n').slice(2)) {
      const [id, r, d, z] = line.split(',');
      if (!z) {
        continue;
      }
      const mpc = corrected.get(id) ?? comoving(Number(z));
      if (already(Number(r), Number(d), mpc)) {
        skipped++;
        continue;
      }
      rows.push([Number(r), Number(d), mpc]);
    }
    process.stdout.write(`\r  RA ${ra + 10}: ${rows.length}`);
  }
  console.log(`\n  ${skipped} already drawn`);

  // a fixed shuffle, so reruns give the same files
  let seed = 1;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const bounds = [0, SDSS_FIRST];
  while (bounds[bounds.length - 1] < rows.length) {
    bounds.push(Math.min(rows.length, bounds[bounds.length - 1] + SDSS_CHUNK));
  }
  for (let k = 0; k < bounds.length - 1; k++) {
    const part = rows.slice(bounds[k], bounds[k + 1]);
    const out = new Uint16Array(part.length * 3);
    part.forEach(([ra, dec, mpc], i) => {
      out[i * 3] = Math.round((ra / 360) * 65535);
      out[i * 3 + 1] = Math.round(((dec + 90) / 180) * 65535);
      out[i * 3 + 2] = Math.min(65535, Math.round(mpc / SDSS_MPC));
    });
    writeFileSync(join(DATA, `sdss-${k}.bin`), Buffer.from(out.buffer));
  }
  save('sdss.json', { files: bounds.length - 1, count: rows.length, unit: SDSS_MPC });
  console.log(`  ${rows.length} galaxies in ${bounds.length - 1} files`);
}

// ---- DESI ----

// DESI DR1's large-scale structure catalogues (DESI Collaboration 2025): luminous red galaxies, star-forming
// galaxies and quasars. Only those past z = 0.6 are taken, where SDSS thins out or ends, and of those a random
// DESI_KEEP, out to the quasars at z of 3 and more. Placed like the SDSS ones, at their comoving distance, in
// files cut the same way. The catalogues are FITS tables of a few hundred MB, read here as they download.
const DESI_LSS = 'https://data.desi.lbl.gov/public/dr1/survey/catalogs/dr1/LSS/iron/LSScats/v1.5';
const DESI_FILES = ['LRG', 'ELG_LOPnotqso', 'QSO'].flatMap((t) => [`${t}_NGC`, `${t}_SGC`]);
const DESI_KEEP = 2400000;
const DESI_MPC = 1 / 8;

/** Streams a FITS binary table, calling `row` with the named float or double columns of each row. */
async function readFits(url: string, names: string[], row: (v: number[]) => void) {
  // some archives (Zenodo) turn away a client that gives no name
  const res = await fetch(url, { headers: { 'User-Agent': 'fetch-data' } });
  if (!res.ok || !res.body) {
    throw new Error(`${url}: ${res.status}`);
  }
  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  const more = async () => {
    const { value, done } = await reader.read();
    if (done) {
      return false;
    }
    buf = Buffer.concat([buf, value]);
    return true;
  };
  // headers come in 2880-byte blocks of 80-byte cards; the table is in the first extension
  const header = async () => {
    const cards = new Map<string, string>();
    for (;;) {
      while (buf.length < 2880) {
        if (!(await more())) {
          throw new Error(`${url}: header cut short`);
        }
      }
      const block = buf.subarray(0, 2880).toString('latin1');
      buf = buf.subarray(2880);
      for (let i = 0; i < 2880; i += 80) {
        const card = block.slice(i, i + 80);
        const key = card.slice(0, 8).trim();
        if (key === 'END') {
          return cards;
        }
        cards.set(key, card.slice(10).split('/')[0].trim().replace(/^'|'$/g, '').trim());
      }
    }
  };
  await header();
  const h = await header();
  const width = Number(h.get('NAXIS1'));
  const rows = Number(h.get('NAXIS2'));
  const size: Record<string, number> = { L: 1, B: 1, I: 2, J: 4, K: 8, E: 4, D: 8, A: 1 };
  const offset = new Map<string, [number, string]>();
  let at = 0;
  for (let i = 1; i <= Number(h.get('TFIELDS')); i++) {
    const [, n, t] = (h.get(`TFORM${i}`) ?? '').match(/^(\d*)(\w)/) ?? [];
    offset.set(h.get(`TTYPE${i}`) ?? '', [at, t]);
    at += (n ? Number(n) : 1) * size[t];
  }
  const want = names.map((n) => offset.get(n));
  if (want.some((w) => !w)) {
    throw new Error(`${url}: missing one of ${names}`);
  }
  const read = want.map((w) => {
    const [o, t] = w as [number, string];
    return t === 'E'
      ? (b: Buffer, r: number) => b.readFloatBE(r + o)
      : (b: Buffer, r: number) => b.readDoubleBE(r + o);
  });
  let done = 0;
  while (done < rows) {
    const n = Math.min(rows - done, Math.floor(buf.length / width));
    for (let r = 0; r < n; r++) {
      row(read.map((f) => f(buf, r * width)));
    }
    buf = buf.subarray(n * width);
    done += n;
    if (done < rows && !(await more())) {
      throw new Error(`${url}: table cut short`);
    }
  }
  await reader.cancel();
}

async function desi() {
  console.log('desi');
  const kept: number[] = [];
  for (const f of DESI_FILES) {
    let n = 0;
    await readFits(`${DESI_LSS}/${f}_clustering.dat.fits`, ['RA', 'DEC', 'Z'], ([ra, dec, z]) => {
      if (z >= 0.6) {
        kept.push(ra, dec, z);
        n++;
      }
    });
    console.log(`  ${f}: ${n}`);
  }
  writeSurvey('desi', kept, DESI_KEEP, DESI_MPC);
}

/**
 * Writes a survey's `kept` (RA, Dec, z, ...) as name-0.bin and on, a random `keep` of them in a fixed shuffle,
 * cut like the SDSS files, and name.json for the app.
 */
function writeSurvey(name: string, kept: number[], keep: number, unit: number) {
  const total = kept.length / 3;
  let seed = 2;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const order = Array.from({ length: total }, (_, i) => i);
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const count = Math.min(keep, total);
  const bounds = [0, Math.min(count, SDSS_FIRST)];
  while (bounds[bounds.length - 1] < count) {
    bounds.push(Math.min(count, bounds[bounds.length - 1] + SDSS_CHUNK));
  }
  for (let k = 0; k < bounds.length - 1; k++) {
    const out = new Uint16Array((bounds[k + 1] - bounds[k]) * 3);
    for (let i = bounds[k]; i < bounds[k + 1]; i++) {
      const j = order[i] * 3;
      const o = (i - bounds[k]) * 3;
      out[o] = Math.round((kept[j] / 360) * 65535);
      out[o + 1] = Math.round(((kept[j + 1] + 90) / 180) * 65535);
      out[o + 2] = Math.min(65535, Math.round(comoving(kept[j + 2]) / unit));
    }
    writeFileSync(join(DATA, `${name}-${k}.bin`), Buffer.from(out.buffer));
  }
  save(`${name}.json`, { files: bounds.length - 1, count, unit });
  console.log(`  ${count} of ${total} in ${bounds.length - 1} files`);
}

// ---- Quaia ----

// Quaia (Storey-Fisher et al. 2024): about 1.3 million quasars Gaia found over the whole sky, down to G = 20.5,
// with redshifts from Gaia's low-resolution spectra and unWISE colours. Those redshifts are rough, off by 10% or
// more for some, but it is the one deep map that goes all the way round. Quasars DESI has already are left out,
// as DESI's redshifts are the better ones.
const QUAIA = 'https://zenodo.org/api/records/10403370/files/quaia_G20.5.fits/content';

async function quaia() {
  console.log('quaia');
  // DESI's points by their packed position, which is good to about 20 arcseconds, with their distance
  const desi = new Map<number, number>();
  const manifest = JSON.parse(readFileSync(join(DATA, 'desi.json'), 'utf8')) as { files: number };
  for (let k = 0; k < manifest.files; k++) {
    const a = new Uint16Array(readFileSync(join(DATA, `desi-${k}.bin`)).buffer.slice(0));
    for (let i = 0; i < a.length; i += 3) {
      desi.set(a[i] * 65536 + a[i + 1], a[i + 2] * DESI_MPC);
    }
  }
  const kept: number[] = [];
  let dup = 0;
  await readFits(QUAIA, ['ra', 'dec', 'redshift_quaia'], ([ra, dec, z]) => {
    if (!(z > 0)) {
      return;
    }
    // the same packed position and about the same distance: the same quasar, near enough every time
    const there = desi.get(Math.round((ra / 360) * 65535) * 65536 + Math.round(((dec + 90) / 180) * 65535));
    if (there && Math.abs(there / comoving(z) - 1) < 0.2) {
      dup++;
      return;
    }
    kept.push(ra, dec, z);
  });
  console.log(`  ${dup} DESI has already`);
  writeSurvey('quaia', kept, Number.POSITIVE_INFINITY, DESI_MPC);
}

// ---- Planck ----

// The cosmic microwave background from Planck's 2018 SMICA map, the version with the Galaxy's plane filled in
// (Planck Collaboration 2020). It is a 2 GB HEALPix table at Nside 2048 in galactic coordinates; in its nested
// order each run of 64 pixels makes up one pixel at Nside 256, so it is averaged down that far as it streams in.
// Then it is resampled onto ecliptic longitude and latitude, the scene's own frame, as an 8-bit grey PNG of
// temperature from -CMB_RANGE to +CMB_RANGE K; the app colours it.
// ESA's archive; the copy at IRSA is the same file but far slower
const PLANCK_SMICA =
  'https://pla.esac.esa.int/pla-sl/data-action?MAP.MAP_ID=COM_CMB_IQU-smica_2048_R3.00_full.fits';
const CMB_NSIDE = 256;
const CMB_RANGE = 400e-6;
const CMB_W = 2048;

// HEALPix nested pixel of a direction, after Gorski et al. (2005)
function ang2pixNest(nside: number, z: number, phi: number) {
  const za = Math.abs(z);
  const tt = ((((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * 2) / Math.PI;
  let face: number;
  let ix: number;
  let iy: number;
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt);
    const t2 = nside * z * 0.75;
    const jp = Math.floor(t1 - t2);
    const jm = Math.floor(t1 + t2);
    const ifp = Math.floor(jp / nside);
    const ifm = Math.floor(jm / nside);
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp));
    const jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) {
      face = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      face = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }
  // interleave: x into the even bits, y into the odd
  let pix = 0;
  for (let b = 0; 1 << b < nside; b++) {
    pix |= ((ix >> b) & 1) << (2 * b);
    pix |= ((iy >> b) & 1) << (2 * b + 1);
  }
  return face * nside * nside + pix;
}

function png(width: number, height: number, grey: Uint8Array) {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function cmb() {
  console.log('cmb');
  const down = 4 ** Math.log2(2048 / CMB_NSIDE);
  const sum = new Float64Array(12 * CMB_NSIDE * CMB_NSIDE);
  // the confidence mask, which covers the Galaxy's plane: written out with CMB_CHECK to see the resampling is right
  const mask = new Float64Array(sum.length);
  let i = 0;
  await readFits(PLANCK_SMICA, ['I_STOKES_INP', 'TMASK'], ([t, m]) => {
    sum[Math.floor(i / down)] += t;
    mask[Math.floor(i / down)] += m;
    i++;
    if (i % 5000000 === 0) {
      process.stdout.write(`\r  ${Math.round(i / 1e6)}M pixels`);
    }
  });
  console.log('');
  const eps = (23.4392911 * Math.PI) / 180;
  // J2000 equatorial to galactic
  const G = [
    [-0.0548755604, -0.87343709, -0.4838350155],
    [0.4941094279, -0.44482963, 0.7469822445],
    [-0.867666149, -0.1980763734, 0.4559837762],
  ];
  const h = CMB_W / 2;
  const grey = new Uint8Array(CMB_W * h);
  const check = new Uint8Array(CMB_W * h);
  for (let v = 0; v < h; v++) {
    const lat = Math.PI / 2 - ((v + 0.5) / h) * Math.PI;
    for (let u = 0; u < CMB_W; u++) {
      const lon = ((u + 0.5) / CMB_W) * 2 * Math.PI;
      const ex = Math.cos(lat) * Math.cos(lon);
      const ey = Math.cos(lat) * Math.sin(lon);
      const ez = Math.sin(lat);
      const q = [ex, ey * Math.cos(eps) - ez * Math.sin(eps), ey * Math.sin(eps) + ez * Math.cos(eps)];
      const g = G.map((r) => r[0] * q[0] + r[1] * q[1] + r[2] * q[2]);
      const pix = ang2pixNest(CMB_NSIDE, g[2], Math.atan2(g[1], g[0]));
      const t = sum[pix] / down;
      check[v * CMB_W + u] = Math.round((mask[pix] / down) * 255);
      grey[v * CMB_W + u] = Math.max(0, Math.min(255, Math.round(((t / CMB_RANGE + 1) / 2) * 255)));
    }
  }
  writeFileSync(join(TEX, 'cmb_planck.png'), png(CMB_W, h, grey));
  if (process.env.CMB_CHECK) {
    writeFileSync(process.env.CMB_CHECK, png(CMB_W, h, check));
  }
  console.log(`  cmb_planck.png`);
}

const STEPS: Record<string, () => Promise<void>> = {
  smallBodies,
  named,
  moons,
  planets,
  spacecraft,
  webb,
  stars,
  localGroup,
  localVolume,
  cosmicflows,
  redshifts,
  sixdf,
  sdss,
  desi,
  quaia,
  cmb,
  textures,
};
const pick = process.argv.slice(2);
for (const [name, run] of Object.entries(STEPS)) {
  if (!pick.length || pick.includes(name)) {
    await run();
  }
}
