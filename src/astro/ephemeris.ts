import {
  Body as AeBody,
  type AstroTime,
  GeoMoon,
  HelioVector,
  JupiterMoons,
  MakeTime,
  RotateVector,
  Rotation_EQJ_ECL,
  RotationAxis,
  Vector,
} from 'astronomy-engine';
import type { Body } from '../data/schema';
import { DEG, orient, type PeriElements, periPosition, solveKepler, type Vec } from './kepler';

export const J2000 = 2451545.0;
export const KM_PER_AU = 149597870.7;
export const LIGHT_MIN_PER_AU = 8.316746;

/** Days since J2000 (UTC) for a JS date, the app's clock. */
export const dayOf = (d: Date) => (d.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
export const dateOf = (day: number) => new Date(Date.UTC(2000, 0, 1, 12) + day * 86400000);

const EQJ_ECL = Rotation_EQJ_ECL();
const toEcl = (v: Vector): Vec => {
  const r = RotateVector(EQJ_ECL, v);
  return [r.x, r.y, r.z];
};

const ENGINE: Record<string, AeBody> = {
  sun: AeBody.Sun,
  mercury: AeBody.Mercury,
  venus: AeBody.Venus,
  earth: AeBody.Earth,
  moon: AeBody.Moon,
  mars: AeBody.Mars,
  jupiter: AeBody.Jupiter,
  saturn: AeBody.Saturn,
  uranus: AeBody.Uranus,
  neptune: AeBody.Neptune,
  pluto: AeBody.Pluto,
};

const GALILEAN = ['io', 'europa', 'ganymede', 'callisto'] as const;

/** Snapshots of a moon's osculating elements, every `step` days from `t0` (JD TDB). */
export interface MoonTable {
  step: number;
  t0: number;
  // a (AU), e, i, node, longitude of pericentre, mean longitude (deg), mean-longitude rate (deg/day)
  rows: number[][];
}

/** Hermite samples [jd, x, y, z, vx, vy, vz] in AU and AU/day, from JPL Horizons. */
export type Path = number[][];

export interface NamedOrbit {
  elements: PeriElements & { epoch: number };
  path: Path;
}

export interface CraftOrbit {
  path: Path;
  // where Horizons' data ends and the fetch script's own coasting under gravity takes over
  coastFrom: number | null;
}

export interface OrbitData {
  moons: Record<string, MoonTable>;
  named: Record<string, NamedOrbit>;
  craft: Record<string, CraftOrbit>;
  // JPL paths for the outer planets, used inside their span instead of astronomy-engine's shortened VSOP87
  planets: Record<string, Path>;
}

/** A body's spin axis as right ascension and declination of its north pole (EQJ, deg) and prime meridian angle. */
export interface Axis {
  ra: number;
  dec: number;
  spin: number;
}

const lerpAngle = (a: number, b: number, f: number) => {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
};

function moonPosition(tab: MoonTable, jd: number): Vec {
  const n = tab.rows.length;
  const k = Math.max(0, Math.min(n - 1, Math.floor((jd - tab.t0) / tab.step)));
  const r0 = tab.rows[k];
  const r1 = tab.rows[Math.min(n - 1, k + 1)];
  const since = jd - (tab.t0 + k * tab.step);
  const f = k + 1 < n ? Math.max(0, Math.min(1, since / tab.step)) : 0;
  const a = r0[0] + (r1[0] - r0[0]) * f;
  const e = r0[1] + (r1[1] - r0[1]) * f;
  const inc = r0[2] + (r1[2] - r0[2]) * f;
  const node = lerpAngle(r0[3], r1[3], f);
  const varpi = lerpAngle(r0[4], r1[4], f);
  const lambda = r0[5] + r0[6] * since;
  const ea = solveKepler((lambda - varpi) * DEG, e);
  return orient(
    a * (Math.cos(ea) - e),
    a * Math.sqrt(1 - e * e) * Math.sin(ea),
    inc * DEG,
    node * DEG,
    (varpi - node) * DEG,
  );
}

/** Position on a sampled path, or null outside it. */
export function pathPosition(path: Path, jd: number): Vec | null {
  if (!path.length || jd < path[0][0] || jd > path[path.length - 1][0]) {
    return null;
  }
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid][0] <= jd) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const p0 = path[lo];
  const p1 = path[hi];
  const h = p1[0] - p0[0];
  const s = (jd - p0[0]) / h;
  // cubic Hermite on position with the velocities as tangents
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  const pos: Vec = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    pos[c] = h00 * p0[c + 1] + h10 * h * p0[c + 4] + h01 * p1[c + 1] + h11 * h * p1[c + 4];
  }
  return pos;
}

/** Heliocentric ecliptic J2000 positions in AU for every body in the dataset. */
export class Ephemeris {
  private readonly byId = new Map<string, Body>();

  constructor(
    bodies: Body[],
    private readonly data: OrbitData,
  ) {
    for (const b of bodies) {
      this.byId.set(b.id, b);
    }
  }

  /** Whether the body exists at `day` (spacecraft before launch or after their end don't). */
  exists(id: string, day: number) {
    return day >= this.firstDay(id) && day <= this.lastDay(id);
  }

  /** First day (since J2000) the body has a position: launch for spacecraft, -Infinity otherwise. */
  firstDay(id: string) {
    const b = this.byId.get(id);
    if (b?.orbit === 'leo' && b.launch) {
      return dayOf(new Date(`${b.launch}T00:00:00Z`));
    }
    if (b?.orbit !== 'craft') {
      return Number.NEGATIVE_INFINITY;
    }
    const path = this.data.craft[id]?.path;
    return path ? path[0][0] - J2000 : Number.POSITIVE_INFINITY;
  }

  /** Last day the body is shown: its `end`, or +Infinity. */
  lastDay(id: string) {
    const end = this.byId.get(id)?.end;
    return end ? dayOf(new Date(`${end}T23:59:59Z`)) : Number.POSITIVE_INFINITY;
  }

  /** Position relative to the body's parent (the Sun for anything without one). */
  local(id: string, day: number, time: AstroTime = MakeTime(day)): Vec | null {
    const b = this.byId.get(id);
    if (!b) {
      return null;
    }
    const jd = time.tt + J2000;
    switch (b.orbit) {
      case 'engine':
        if (id === 'sun') {
          return [0, 0, 0];
        }
        if (id === 'moon') {
          return toEcl(GeoMoon(time));
        }
        return this.planet(id, jd) ?? toEcl(HelioVector(ENGINE[id], time));
      case 'jupiter': {
        const m = JupiterMoons(time)[id as (typeof GALILEAN)[number]];
        return toEcl(new Vector(m.x, m.y, m.z, time));
      }
      case 'moon': {
        const tab = this.data.moons[id];
        return tab ? moonPosition(tab, jd) : null;
      }
      case 'named': {
        // outside Horizons' span the two-body orbit is the best there is
        const n = this.data.named[id];
        return n ? (pathPosition(n.path, jd) ?? periPosition(n.elements, jd)) : null;
      }
      case 'craft': {
        const c = this.data.craft[id];
        return c ? pathPosition(c.path, jd) : null;
      }
      case 'leo':
        return b.leo ? leoPosition(b.leo, jd) : null;
    }
  }

  /** Heliocentric position from a JPL barycenter path; for Pluto the body is moved off it opposite Charon. */
  private planet(id: string, jd: number): Vec | null {
    const p = pathPosition(this.data.planets[id] ?? [], jd);
    if (!p || id !== 'pluto') {
      return p;
    }
    const charon = this.data.moons.charon;
    const c = charon ? moonPosition(charon, jd) : null;
    const mp = this.byId.get('pluto')?.mass;
    const mc = this.byId.get('charon')?.mass;
    if (!c || !mp || !mc) {
      return p;
    }
    const k = mc / (mp + mc);
    return [p[0] - k * c[0], p[1] - k * c[1], p[2] - k * c[2]];
  }

  /** Heliocentric position. */
  position(id: string, day: number, time: AstroTime = MakeTime(day)): Vec | null {
    const p = this.local(id, day, time);
    const parent = this.byId.get(id)?.parent;
    if (!p || !parent) {
      return p;
    }
    const q = this.position(parent, day, time);
    return q ? [p[0] + q[0], p[1] + q[1], p[2] + q[2]] : null;
  }

  /** Perihelion distance in AU of a named body. */
  perihelion(id: string): number | null {
    return this.data.named[id]?.elements.q ?? null;
  }

  /** Heliocentric velocity in AU/day, by central difference. */
  velocity(id: string, day: number): Vec | null {
    const dt = 1 / 24;
    const a = this.position(id, day - dt);
    const b = this.position(id, day + dt);
    return a && b ? [(b[0] - a[0]) / (2 * dt), (b[1] - a[1]) / (2 * dt), (b[2] - a[2]) / (2 * dt)] : null;
  }

  axis(id: string, day: number, time: AstroTime = MakeTime(day)): Axis {
    const ae = ENGINE[id];
    if (ae !== undefined) {
      const ax = RotationAxis(ae, time);
      return { ra: ax.ra * 15, dec: ax.dec, spin: ax.spin };
    }
    // no published pole: spin about the ecliptic north pole (RA 270°, Dec 66.56°)
    const hours = this.byId.get(id)?.rotation ?? 0;
    return { ra: 270, dec: 66.5607, spin: hours ? (((day * 24) / hours) * 360) % 360 : 0 };
  }
}

const MU_EARTH = 398600.4418;
const R_EARTH = 6378.137;
const J2 = 1.08263e-3;
const OBLIQUITY = 23.4392911 * DEG;

/**
 * A circular orbit round Earth from mean elements, with the node and the argument of latitude drifting as
 * Earth's equatorial bulge makes them. Good for the plane and the height, not for where along the orbit the
 * craft is: real ones are reboosted and dragged down, and every orbit's phase error adds up.
 */
function leoPosition(el: NonNullable<Body['leo']>, jd: number): Vec {
  const a = R_EARTH + el.alt;
  const n = Math.sqrt(MU_EARTH / a ** 3) * 86400;
  const k = 0.75 * J2 * (R_EARTH / a) ** 2 * n;
  const ci = Math.cos(el.inc * DEG);
  const dt = jd - (Date.parse(el.epoch) / 86400000 + 2440587.5);
  const node = el.node * DEG - 2 * k * ci * dt;
  const u = el.u * DEG + (n + k * (3 * ci * ci - 1) + k * (5 * ci * ci - 1)) * dt;
  const si = Math.sin(el.inc * DEG);
  const r = a / KM_PER_AU;
  // equatorial, then turned onto the ecliptic
  const x = r * (Math.cos(node) * Math.cos(u) - Math.sin(node) * Math.sin(u) * ci);
  const y = r * (Math.sin(node) * Math.cos(u) + Math.cos(node) * Math.sin(u) * ci);
  const z = r * Math.sin(u) * si;
  return [
    x,
    y * Math.cos(OBLIQUITY) + z * Math.sin(OBLIQUITY),
    -y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY),
  ];
}

/** Period in days of a `leo` orbit. */
export function leoPeriod(alt: number) {
  return (2 * Math.PI * Math.sqrt((R_EARTH + alt) ** 3 / MU_EARTH)) / 86400;
}
