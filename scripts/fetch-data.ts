// Downloads orbits, spacecraft paths, stars and textures into public/. Run with `npm run fetch-data`.
// Pass the names of steps to run only those: `npm run fetch-data -- moons stars`.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Flat [a, e, i, node, peri, M at J2000] per asteroid, in AU and degrees. */
async function asteroids(sbClass: string, maxH: number) {
  const res = await sbdbQuery({
    fields: 'a,e,i,om,w,ma,epoch',
    'sb-class': sbClass,
    'sb-cdata': JSON.stringify({ AND: [`H|LT|${maxH}`] }),
  });
  const out: number[] = [];
  for (const row of res.data) {
    const [a, e, i, om, w, ma, epoch] = row.map(Number);
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
    );
  }
  return out;
}

async function comets() {
  const res = await sbdbQuery({
    fields: 'q,e,i,om,w,tp',
    'sb-kind': 'c',
    'sb-cdata': JSON.stringify({ AND: ['e|LT|1'] }),
  });
  const out: number[] = [];
  for (const row of res.data) {
    const [q, e, i, om, w, tp] = row.map(Number);
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
    console.log(`  ${k}: ${v.length / 6}`);
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

// The sky drawn at infinity: stars to about naked-eye limit. Stars within NEAR_LY also get a real 3D position.
const MAG_LIMIT = 6.8;
const NEAR_LY = 17;
const AU_PER_PC = 206264.806;
const LY_PER_PC = 3.26156;

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
  const names: [number, number, string][] = [];
  const near: {
    name: string;
    x: number;
    y: number;
    z: number;
    mag: number;
    absmag: number;
    ci: number;
    ly: number;
  }[] = [];
  const eps = (23.4392911 * Math.PI) / 180;
  for (const line of lines.slice(2)) {
    const f = line.split(',').map((s) => s.replace(/"/g, ''));
    if (f.length < head.length) {
      continue;
    }
    const mag = Number(f[cMag]);
    const ci = Number(f[cCi]) || 0.6;
    const dist = Number(f[cDist]);
    const ra = Number(f[cRa]) * 15;
    const dec = Number(f[cDec]);
    if (mag < MAG_LIMIT) {
      sky.push(round(ra, 6), round(dec, 6), round(mag, 3), round(ci, 3));
      if (f[cProper] && mag < 2.6) {
        names.push([round(ra, 6), round(dec, 6), f[cProper]]);
      }
    }
    if (dist > 0 && dist * LY_PER_PC < NEAR_LY) {
      // HYG x, y, z are equatorial parsecs; turn them into ecliptic AU
      const x = Number(f[cX]) * AU_PER_PC;
      const y = Number(f[cY]) * AU_PER_PC;
      const z = Number(f[cZ]) * AU_PER_PC;
      const ey = y * Math.cos(eps) + z * Math.sin(eps);
      const ez = -y * Math.sin(eps) + z * Math.cos(eps);
      // a proper name, else Bayer or Flamsteed with the constellation, else the Gliese number
      const greek = GREEK[f[cBayer].replace(/-\d+$/, '')];
      const catalog = greek ? `${greek} ${f[cCon]}` : f[cFlam] ? `${f[cFlam]} ${f[cCon]}` : f[cGl];
      const name = f[cProper] || catalog || '';
      if (!name) {
        continue;
      }
      const absmag = mag - 5 * (Math.log10(dist) - 1);
      near.push({
        name,
        x: Math.round(x),
        y: Math.round(ey),
        z: Math.round(ez),
        mag,
        absmag: round(absmag, 3),
        ci,
        ly: round(dist * LY_PER_PC, 4),
      });
    }
  }
  console.log(`  ${sky.length / 4} sky stars, ${near.length} near stars`);
  save('stars.json', { sky, names, near });
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

const STEPS: Record<string, () => Promise<void>> = {
  smallBodies,
  named,
  moons,
  planets,
  spacecraft,
  stars,
  textures,
};
const pick = process.argv.slice(2);
for (const [name, run] of Object.entries(STEPS)) {
  if (!pick.length || pick.includes(name)) {
    await run();
  }
}
