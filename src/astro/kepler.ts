// Two-body orbits. Positions are in the ecliptic J2000 frame, in the units of `a` or `q`.

export const DEG = Math.PI / 180;
// Gaussian gravitational constant: mean motion of a massless body at 1 AU, in rad/day
export const GAUSS = 0.01720209895;

export type Vec = [number, number, number];

/** Eccentric anomaly for mean anomaly `m` (rad), elliptic orbits. */
export function solveKepler(m: number, e: number) {
  const mm = Math.atan2(Math.sin(m), Math.cos(m));
  let ea = e < 0.8 ? mm : Math.PI * Math.sign(mm || 1);
  for (let k = 0; k < 30; k++) {
    const d = (ea - e * Math.sin(ea) - mm) / (1 - e * Math.cos(ea));
    ea -= d;
    if (Math.abs(d) < 1e-12) {
      break;
    }
  }
  return ea;
}

/** Hyperbolic anomaly for mean anomaly `m` (rad), e > 1. */
export function solveHyperbolic(m: number, e: number) {
  let h = Math.asinh(m / e);
  for (let k = 0; k < 50; k++) {
    const d = (e * Math.sinh(h) - h - m) / (e * Math.cosh(h) - 1);
    h -= d;
    if (Math.abs(d) < 1e-12) {
      break;
    }
  }
  return h;
}

/** Rotates a point in the orbital plane (x towards perihelion) into the ecliptic frame. Angles in rad. */
export function orient(px: number, py: number, inc: number, node: number, argPeri: number): Vec {
  const cw = Math.cos(argPeri);
  const sw = Math.sin(argPeri);
  const cn = Math.cos(node);
  const sn = Math.sin(node);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  const x = px * cw - py * sw;
  const y = px * sw + py * cw;
  return [x * cn - y * ci * sn, x * sn + y * ci * cn, y * si];
}

/** Position on an elliptic orbit from the eccentric anomaly. */
export function ellipsePoint(
  a: number,
  e: number,
  ea: number,
  inc: number,
  node: number,
  argPeri: number,
): Vec {
  return orient(a * (Math.cos(ea) - e), a * Math.sqrt(1 - e * e) * Math.sin(ea), inc, node, argPeri);
}

export function hyperbolaPoint(
  q: number,
  e: number,
  h: number,
  inc: number,
  node: number,
  argPeri: number,
): Vec {
  const a = q / (e - 1);
  return orient(a * (e - Math.cosh(h)), a * Math.sqrt(e * e - 1) * Math.sinh(h), inc, node, argPeri);
}

/** Perihelion elements as SBDB gives them: q in AU, angles in degrees, tp a Julian date. */
export interface PeriElements {
  q: number;
  e: number;
  i: number;
  node: number;
  peri: number;
  tp: number;
}

/** Heliocentric position at Julian date `jd`, for any eccentricity. */
export function periPosition(el: PeriElements, jd: number): Vec {
  const inc = el.i * DEG;
  const node = el.node * DEG;
  const w = el.peri * DEG;
  const dt = jd - el.tp;
  if (el.e < 1) {
    const a = el.q / (1 - el.e);
    const m = (GAUSS / a ** 1.5) * dt;
    return ellipsePoint(a, el.e, solveKepler(m, el.e), inc, node, w);
  }
  const a = el.q / (el.e - 1);
  const m = (GAUSS / a ** 1.5) * dt;
  return hyperbolaPoint(el.q, el.e, solveHyperbolic(m, el.e), inc, node, w);
}

/** Orbital period in days of an elliptic orbit with semi-major axis `a` in AU, around the Sun. */
export const periodDays = (a: number) => (2 * Math.PI) / (GAUSS / a ** 1.5);
