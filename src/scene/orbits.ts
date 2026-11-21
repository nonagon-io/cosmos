import { MakeTime } from 'astronomy-engine';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Line, ShaderMaterial } from 'three';
import { type Ephemeris, J2000, type Path } from '../astro/ephemeris';
import { DEG, ellipsePoint, GAUSS, type PeriElements, type Vec } from '../astro/kepler';
import type { Body } from '../data/schema';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

// Loop lines carry each vertex's orbital phase (0..1) and are brightest just behind `head`.
// Time lines carry each vertex's date (days since J2000): the past fades over `span`, the future is faint.
const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute float aT;
attribute float aS;
uniform bool timeMode;
uniform float head;
uniform float now;
uniform float span;
uniform float future;
uniform float pastFloor;
varying float vA;
varying float vS;
varying float vT;
void main() {
  vS = aS;
  vT = aT;
  if (timeMode) {
    float dt = aT - now;
    float past = 1.0 - clamp(-dt / span, 0.0, 1.0);
    vA = dt <= 0.0 ? max(pastFloor, past * past) : future * (1.0 - clamp(dt / span, 0.0, 1.0));
  } else {
    float behind = fract(head - aT + 1.0);
    vA = 0.16 + 0.84 * pow(1.0 - behind, 2.2);
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 color;
uniform float opacity;
uniform float dashUntil;
uniform float dash;
varying float vA;
varying float vS;
varying float vT;
void main() {
  ${LOGDEPTH_FRAG}
  if (vT < dashUntil && fract(vS / dash) > 0.5) discard;
  gl_FragColor = vec4(color, vA * opacity);
  #include <colorspace_fragment>
}
`;

export class OrbitLine {
  readonly line: Line;
  readonly material: ShaderMaterial;
  /** typical size of the orbit in AU, used to fade lines too small on screen */
  size = 1;
  builtAt = Number.NaN;

  constructor(
    readonly body: Body,
    readonly timeMode: boolean,
  ) {
    const c = new Color(body.color).lerp(new Color('#9fb3d1'), 0.35);
    this.material = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        color: { value: c },
        opacity: { value: 0.55 },
        timeMode: { value: timeMode },
        head: { value: 0 },
        now: { value: 0 },
        span: { value: 365 },
        future: { value: 0.22 },
        // lowest alpha for the past: older laps of a periodic orbit vanish, a spacecraft keeps its whole path
        pastFloor: { value: 0 },
        // before this date (days since J2000) the path is dashed, every `dash` AU along it
        dashUntil: { value: -1e9 },
        dash: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.line = new Line(new BufferGeometry(), this.material);
    this.line.frustumCulled = false;
  }

  setPoints(points: Vec[], t: Float32Array) {
    const pos = new Float32Array(points.length * 3);
    const along = new Float32Array(points.length);
    for (let i = 0; i < points.length; i++) {
      pos.set(points[i], i * 3);
      if (i > 0) {
        const a = points[i - 1];
        const b = points[i];
        along[i] = along[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
    }
    const g = this.line.geometry;
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aT', new BufferAttribute(t, 1));
    g.setAttribute('aS', new BufferAttribute(along, 1));
    g.computeBoundingSphere();
  }
}

/** One full revolution sampled from the ephemeris, ending at `day`. Relative to the parent. */
export function sampleLoop(line: OrbitLine, eph: Ephemeris, day: number, period: number, n: number) {
  const pts: Vec[] = [];
  const t = new Float32Array(n + 1);
  let size = 0;
  for (let i = 0; i <= n; i++) {
    const d = day - period + (period * i) / n;
    const p = eph.local(line.body.id, d, MakeTime(d)) ?? [0, 0, 0];
    pts.push(p);
    t[i] = i / n;
    size = Math.max(size, Math.hypot(p[0], p[1], p[2]));
  }
  line.setPoints(pts, t);
  line.size = size;
  line.builtAt = day;
}

/** A Keplerian ellipse, sampled evenly in eccentric anomaly so the perihelion end stays smooth. */
export function ellipseLoop(line: OrbitLine, el: PeriElements, n: number) {
  const a = el.q / (1 - el.e);
  const pts: Vec[] = [];
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const ea = (i / n) * Math.PI * 2;
    pts.push(ellipsePoint(a, el.e, ea, el.i * DEG, el.node * DEG, el.peri * DEG));
    t[i] = (ea - el.e * Math.sin(ea)) / (Math.PI * 2);
  }
  line.setPoints(pts, t);
  line.size = a * (1 + el.e);
}

/** Head phase of an elliptic orbit at `jd`. */
export function ellipseHead(el: PeriElements, jd: number) {
  const a = el.q / (1 - el.e);
  const m = (GAUSS / a ** 1.5) * (jd - el.tp);
  return (((m / (Math.PI * 2)) % 1) + 1) % 1;
}

/** A Horizons path, with Hermite points added between samples so turns stay round. */
export function pathLine(line: OrbitLine, path: Path, from = 0) {
  const sub = path.length > 6000 ? 1 : path.length > 2500 ? 2 : 4;
  const pts: Vec[] = [];
  const ts: number[] = [];
  let size = 0;
  for (let k = from; k < path.length; k++) {
    const p0 = path[k];
    const p1 = path[k + 1];
    const steps = p1 ? sub : 1;
    for (let j = 0; j < steps; j++) {
      const s = j / sub;
      if (j === 0) {
        pts.push([p0[1], p0[2], p0[3]]);
      } else {
        const h = p1[0] - p0[0];
        const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
        const h10 = s ** 3 - 2 * s ** 2 + s;
        const h01 = -2 * s ** 3 + 3 * s ** 2;
        const h11 = s ** 3 - s ** 2;
        const p: Vec = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          p[c] = h00 * p0[c + 1] + h10 * h * p0[c + 4] + h01 * p1[c + 1] + h11 * h * p1[c + 4];
        }
        pts.push(p);
      }
      ts.push(p0[0] + (p1 ? (p1[0] - p0[0]) * s : 0) - J2000);
    }
    size = Math.max(size, Math.hypot(p0[1], p0[2], p0[3]));
  }
  line.setPoints(pts, new Float32Array(ts));
  line.size = size;
}
