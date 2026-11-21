import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  Group,
  MathUtils,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { Vec } from '../astro/kepler';
import type { Region } from '../data/schema';
import { minSizeAt } from './galaxy';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { rng } from './particles';
import { AU_PER_LY, eclipticDir } from './stars';

/*
 * Nebulae as clouds of soft points that glow, block light, or both. Where each one is, how big and which way it
 * lies on the sky are measured; its depth is not, since we only ever see it from here, so every shape below is
 * a model built to look right from Earth. The colours are those of the light each part gives off: hydrogen
 * alpha red, oxygen III teal, the blue of dust scattering starlight, and dust that only darkens what is behind.
 */

// sRGB as the eye would see it on a long exposure
const PAL = {
  ha: '#ff3355',
  pink: '#ff6f9c',
  nii: '#ff2238',
  oiii: '#3fe0c0',
  teal: '#5fd0ff',
  hot: '#fff0e2',
  yellow: '#ffd36a',
  orange: '#ff8a3c',
  blue: '#6f98ff',
  sync: '#a8c0ff',
  dust: '#5a3422',
};
type Hex = string;
const REDDENED = '#ff5a3c';

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aColor;
attribute float aAbsorb;
attribute float aSize;
attribute float aPick;
uniform float scale;
uniform float pxMin;
uniform float pxMax;
uniform float grow;
uniform float lod;
uniform float thin;
varying vec3 vColor;
varying float vAbsorb;
varying float vFade;
varying float vBoost;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // a nebula small on screen needs only a share of its points; the ones kept are drawn bigger to cover for the
  // rest, since brightening them instead would clip at white
  float kept = aPick < lod ? 1.0 : 0.0;
  float pick = aPick / lod;
  float px = aSize * grow * scale / max(-mv.z, 1e-6) * inversesqrt(lod);
  // below a few pixels the same light spreads over the held size. Above what the GPU can draw (often 511 px) the
  // point is held there and brightened to keep its light, and only once it is far past that, which means the
  // camera is right inside it, does it fade out
  float f = min(px / pxMin, 1.0);
  float held = clamp(px, pxMin, pxMax);
  float keep = min(px * px / (held * held), 4.0);
  float near = 1.0 - smoothstep(pxMax * 2.0, pxMax * 4.0, px);
  // big points pile up many deep, so drawing a share of them, brighter, looks the same for far less fill
  float share = clamp(thin / held, 0.12, 1.0);
  float drawn = pick < share ? kept / share : 0.0;
  vFade = f * f * near;
  vBoost = keep * drawn;
  gl_PointSize = near * drawn > 0.0 && mv.z < 0.0 ? held : 0.0;
  vColor = aColor;
  vAbsorb = aAbsorb;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

// premultiplied: the colour adds light, the alpha takes away what was behind, so one draw does both glowing gas
// and dark dust, in whatever order the points come
const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float glow;
uniform float dust;
uniform float seen;
varying vec3 vColor;
varying float vAbsorb;
varying float vFade;
varying float vBoost;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  // a Gaussian taken down to zero at the edge, so piled-up points don't show their square corners
  float k = max(exp(-d * d * 4.0) - 0.0183, 0.0) * 1.0187 * vFade * seen;
  // the colours are already sRGB: converting each faint point on its own would brighten it some twelve times
  // over before they are added up
  // a point standing in for several stacked ones: their light adds up, their dust lets through (1 - a)^n
  float a = min(vAbsorb * k * dust, 0.999);
  gl_FragColor = vec4(vColor * k * glow * vBoost, 1.0 - pow(1.0 - a, vBoost));
}
`;

/** Points in the nebula's own frame, in light years: x and y across the sky (x on its long axis), z away from us. */
class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly abs: number[] = [];
  readonly size: number[] = [];
  readonly rand: () => number;
  private readonly c = new Color();

  constructor(seed: number) {
    this.rand = rng(seed);
  }

  gauss() {
    const u = Math.max(1e-9, this.rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
  }

  /** A random direction. */
  dir(): Vec {
    const z = this.rand() * 2 - 1;
    const a = this.rand() * 2 * Math.PI;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), s * Math.sin(a), z];
  }

  /** Drops the points `keep` says no to. */
  carve(keep: (p: Vec) => boolean) {
    let n = 0;
    for (let i = 0; i < this.size.length; i++) {
      if (!keep([this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]])) {
        continue;
      }
      for (let k = 0; k < 3; k++) {
        this.pos[n * 3 + k] = this.pos[i * 3 + k];
        this.col[n * 3 + k] = this.col[i * 3 + k];
      }
      this.abs[n] = this.abs[i];
      this.size[n] = this.size[i];
      n++;
    }
    this.pos.length = n * 3;
    this.col.length = n * 3;
    this.abs.length = n;
    this.size.length = n;
  }

  /** `bright` scales the light, `absorb` is how much of what is behind it hides (0 to 1). */
  add(p: Vec, color: Hex | Color, bright: number, size: number, absorb = 0) {
    const c = (typeof color === 'string' ? this.c.set(color) : this.c.copy(color)).convertLinearToSRGB();
    this.pos.push(p[0], p[1], p[2]);
    this.col.push(c.r * bright, c.g * bright, c.b * bright);
    this.abs.push(absorb);
    this.size.push(size);
  }
}

const tmp = new Color();
const mix = (a: Hex, b: Hex, t: number) => new Color(a).lerp(tmp.set(b), MathUtils.clamp(t, 0, 1));

/** Turns (x, y, z) about the y axis by `deg`, then about z by `roll`. */
function turn(p: Vec, deg: number, roll = 0): Vec {
  const a = MathUtils.degToRad(deg);
  const x = p[0] * Math.cos(a) + p[2] * Math.sin(a);
  const z = -p[0] * Math.sin(a) + p[2] * Math.cos(a);
  const r = MathUtils.degToRad(roll);
  return [x * Math.cos(r) - p[1] * Math.sin(r), x * Math.sin(r) + p[1] * Math.cos(r), z];
}

const add3 = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

interface BarrelOpts {
  r: number;
  len: number;
  // degrees the barrel's axis leans from our line of sight, toward x
  tilt: number;
  roll?: number;
  n: number;
  thick: number;
  // colour across the wall, from its inner edge (0) to its outer (1)
  color: (t: number) => Color;
  bright: number;
  center?: Vec;
}

/** The open-ended barrel most planetary nebulae turn out to be: from along its axis, a ring. */
function barrel(b: Builder, o: BarrelOpts) {
  for (let i = 0; i < o.n; i++) {
    const h = MathUtils.clamp(b.gauss() * 0.45, -1, 1);
    const a = b.rand() * 2 * Math.PI;
    const t = b.rand();
    const rr = o.r * (1 - 0.3 * h * h) * (1 + (t - 0.5) * o.thick) * (1 + b.gauss() * 0.03);
    const p = turn([rr * Math.cos(a), rr * Math.sin(a), h * o.len], o.tilt, o.roll);
    // brighter where the wall is seen along its length
    const bright = o.bright * (0.7 + 0.6 * Math.abs(Math.sin(a))) * (0.6 + 0.8 * b.rand());
    b.add(add3(p, o.center ?? [0, 0, 0]), o.color(t), bright, o.r * o.thick * 1.6);
  }
}

/** A soft-edged ellipsoid of glow, or of dust. */
function blob(
  b: Builder,
  axes: Vec,
  n: number,
  color: Hex,
  bright: number,
  size: number,
  center: Vec = [0, 0, 0],
  absorb = 0,
) {
  for (let i = 0; i < n; i++) {
    const g: Vec = [b.gauss() * 0.5, b.gauss() * 0.5, b.gauss() * 0.5];
    b.add(
      add3([g[0] * axes[0], g[1] * axes[1], g[2] * axes[2]], center),
      color,
      bright,
      size * (0.6 + b.rand() * 0.8),
      absorb,
    );
  }
}

/** Thin spherical shells: the faint rings of gas a dying star puffed off before its main nebula. */
function shells(b: Builder, radii: number[], n: number, color: Hex, bright: number) {
  for (const r of radii) {
    for (let i = 0; i < n; i++) {
      const d = b.dir();
      const rr = r * (1 + b.gauss() * 0.02);
      b.add([d[0] * rr, d[1] * rr, d[2] * rr], color, bright, r * 0.08);
    }
  }
}

interface ClumpOpts {
  axes: Vec;
  n: number;
  // nested clumping: how many at the top, how many in each, and how much smaller each level is
  levels?: number[];
  shrink?: number;
  // put the top-level clumps in a shell from shell[0] to shell[1] of the axes, as round a cavity
  shell?: [number, number];
  center?: Vec;
  color: (p: Vec, u: number) => Color;
  bright: number;
  absorb?: number;
  size?: number;
}

/** Gas or dust in clumps within clumps, which is roughly how the real clouds are built. */
function clumps(b: Builder, o: ClumpOpts) {
  const levels = o.levels ?? [9, 6, 5];
  const shrink = o.shrink ?? 0.45;
  let centers: Vec[] = [];
  let scale = 1;
  for (let i = 0; i < levels[0]; i++) {
    if (o.shell) {
      const d = b.dir();
      const r = MathUtils.lerp(o.shell[0], o.shell[1], b.rand());
      centers.push([d[0] * r, d[1] * r, d[2] * r]);
    } else {
      centers.push([b.gauss() * 0.4, b.gauss() * 0.4, b.gauss() * 0.4]);
    }
  }
  scale = o.shell ? 0.18 : 0.4;
  for (const k of levels.slice(1)) {
    const next: Vec[] = [];
    for (const c of centers) {
      for (let i = 0; i < k; i++) {
        next.push([c[0] + b.gauss() * scale, c[1] + b.gauss() * scale, c[2] + b.gauss() * scale]);
      }
    }
    centers = next;
    scale *= shrink;
  }
  const per = Math.max(1, Math.round(o.n / centers.length));
  const avg = (o.axes[0] + o.axes[1] + o.axes[2]) / 3;
  for (const c of centers) {
    // unit-space position: a clump past the edge is left out, so the outline stays ragged but bounded
    const u = Math.hypot(...c);
    if (u > 1.3) {
      continue;
    }
    const weight = 0.4 + b.rand() * 1.2;
    for (let i = 0; i < per; i++) {
      const q: Vec = [c[0] + b.gauss() * scale, c[1] + b.gauss() * scale, c[2] + b.gauss() * scale];
      const p: Vec = [q[0] * o.axes[0], q[1] * o.axes[1], q[2] * o.axes[2]];
      b.add(
        add3(p, o.center ?? [0, 0, 0]),
        o.color(p, Math.hypot(...q)),
        o.bright * weight,
        avg * scale * (o.size ?? 2.2) * (0.6 + b.rand() * 0.8),
        o.absorb ?? 0,
      );
    }
  }
}

interface FilamentOpts {
  axes: Vec;
  count: number;
  steps: number;
  r: [number, number];
  color: (b: Builder) => Color;
  bright: number;
  width: number;
  // how much of the shell there is in a direction, 0 to 1
  patch?: (d: Vec) => number;
}

/** Thin threads wandering over a shell, as in the wreck of an exploded star. */
function filaments(b: Builder, o: FilamentOpts) {
  for (let f = 0; f < o.count; f++) {
    let d = b.dir();
    if (o.patch && b.rand() > o.patch(d)) {
      continue;
    }
    let r = MathUtils.lerp(o.r[0], o.r[1], b.rand());
    // a heading along the shell, turned a little at each step
    const t = new Vector3(...b.dir()).projectOnPlane(new Vector3(...d)).normalize();
    const color = o.color(b);
    const bright = o.bright * (0.5 + b.rand());
    for (let s = 0; s < o.steps; s++) {
      const p: Vec = [d[0] * r * o.axes[0], d[1] * r * o.axes[1], d[2] * r * o.axes[2]];
      b.add(p, color, bright, o.width * (0.7 + b.rand() * 0.6));
      const v = new Vector3(...d)
        .addScaledVector(t, (o.width * 0.6) / Math.max(r * o.axes[0], 1e-6))
        .normalize();
      t.add(new Vector3(b.gauss(), b.gauss(), b.gauss()).multiplyScalar(0.15))
        .projectOnPlane(v)
        .normalize();
      d = [v.x, v.y, v.z];
      r *= 1 + b.gauss() * 0.01;
    }
  }
}

/** A lane of dust along a polyline. */
function lane(
  b: Builder,
  pts: Vec[],
  width: number,
  n: number,
  absorb: number,
  tint: Hex = PAL.dust,
  glow = 0.02,
) {
  for (let i = 0; i < n; i++) {
    const s = b.rand() * (pts.length - 1);
    const k = Math.min(Math.floor(s), pts.length - 2);
    const a = pts[k];
    const c = pts[k + 1];
    const t = s - k;
    const p: Vec = [
      a[0] + (c[0] - a[0]) * t + b.gauss() * width * 0.5,
      a[1] + (c[1] - a[1]) * t + b.gauss() * width * 0.5,
      a[2] + (c[2] - a[2]) * t + b.gauss() * width * 0.3,
    ];
    b.add(p, tint, glow, width * (0.6 + b.rand() * 0.6), absorb);
  }
}

/** A column of dust, lit on the side facing the stars that are eating it away. */
function pillar(b: Builder, base: Vec, top: Vec, width: number, n: number, light: Vec) {
  const L = new Vector3(...light).normalize();
  for (let i = 0; i < n; i++) {
    const t = b.rand();
    const w = width * (1 - 0.45 * t) * (0.8 + 0.4 * b.rand());
    const off: Vec = [b.gauss() * w * 0.5, b.gauss() * w * 0.2, b.gauss() * w * 0.5];
    const p: Vec = add3(
      [base[0] + (top[0] - base[0]) * t, base[1] + (top[1] - base[1]) * t, base[2] + (top[2] - base[2]) * t],
      off,
    );
    b.add(p, PAL.dust, 0.03, w * 0.9, 0.5);
    // the rim toward the light glows where the gas is boiled off
    const facing = new Vector3(...off).normalize().dot(L);
    if (facing > 0.4) {
      b.add(
        add3(p, [L.x * w * 0.4, L.y * w * 0.4, L.z * w * 0.4]),
        mix(PAL.ha, PAL.hot, 0.35),
        0.6,
        w * 0.35,
      );
    }
  }
}

/** A thin bubble blown by a star's wind, brightest at its rim where we look along the wall. */
function bubble(
  b: Builder,
  axes: Vec,
  n: number,
  color: (d: Vec) => Color,
  bright: number,
  width: number,
  center: Vec = [0, 0, 0],
) {
  for (let i = 0; i < n; i++) {
    const d = b.dir();
    const k = 1 + b.gauss() * width;
    const p: Vec = [d[0] * axes[0] * k, d[1] * axes[1] * k, d[2] * axes[2] * k];
    b.add(add3(p, center), color(d), bright * (0.6 + 0.8 * b.rand()), axes[0] * Math.max(width * 2.5, 0.1));
  }
}

/** Two lobes either side of a pinched waist, along x: how a star with a dense ring of dust round it blows out. */
function lobes(
  b: Builder,
  len: number,
  width: number,
  n: number,
  color: (t: number) => Color,
  bright: number,
) {
  for (let i = 0; i < n; i++) {
    const t = b.rand() ** 1.4;
    const s = b.rand() < 0.5 ? -1 : 1;
    const w = width * Math.sin(Math.PI * Math.min(t * 0.9 + 0.05, 0.98)) ** 0.6;
    const a = b.rand() * 2 * Math.PI;
    const r = w * Math.sqrt(b.rand()) * (0.8 + b.rand() * 0.4);
    // fading toward the tips
    const k = bright * (1.2 - t) * (0.5 + b.rand());
    b.add([s * t * len, r * Math.cos(a), r * Math.sin(a)], color(t), k, width * (0.25 + 0.3 * t));
  }
}

/**
 * A column of dust along a bending line, lumpy as the real ones are, with a glowing skin on the side toward the
 * stars that are boiling it away. `widths` are the widths at each point of the line.
 */
function column(b: Builder, line: Vec[], widths: number[], n: number, light: Vec, absorb = 0.35) {
  const L = new Vector3(...light).normalize();
  // lumps: a few hundred small knots spread along the line, each a little off it
  const lumps: { p: Vec; w: number }[] = [];
  for (let i = 0; i < 400; i++) {
    const s = b.rand() * (line.length - 1);
    const k = Math.min(Math.floor(s), line.length - 2);
    const t = s - k;
    const w = MathUtils.lerp(widths[k], widths[k + 1], t);
    const c: Vec = [
      line[k][0] + (line[k + 1][0] - line[k][0]) * t,
      line[k][1] + (line[k + 1][1] - line[k][1]) * t,
      line[k][2] + (line[k + 1][2] - line[k][2]) * t,
    ];
    lumps.push({ p: add3(c, [b.gauss() * w * 0.15, b.gauss() * w * 0.05, b.gauss() * w * 0.15]), w });
  }
  const per = Math.ceil(n / lumps.length);
  for (const { p: c, w } of lumps) {
    const r = w * (0.15 + b.rand() * 0.15);
    for (let i = 0; i < per; i++) {
      const off: Vec = [b.gauss() * r, b.gauss() * r, b.gauss() * r];
      const p = add3(c, off);
      b.add(p, PAL.dust, 0.04, r * 1.2, absorb);
      const facing = new Vector3(...off).normalize().dot(L);
      if (facing > 0.3) {
        b.add(
          add3(p, [L.x * r * 0.6, L.y * r * 0.6, L.z * r * 0.6]),
          mix(PAL.ha, PAL.yellow, 0.25 + b.rand() * 0.3),
          1.2,
          r * 0.8,
        );
      }
    }
  }
}

interface PillarLook {
  core: Hex;
  body: Hex;
  lit: Hex;
  tip: Hex;
  halo: Hex;
  haze: [Hex, Hex];
  // how much of what is behind the dust hides
  absorb: number;
  bright: number;
  hazeBright: number;
  stars: number;
}

// as the eye might see them, which no photograph shows: dark brown dust against faint red hydrogen
const EYE_PILLARS: PillarLook = {
  core: '#140a06',
  body: '#2e1a10',
  lit: '#6a3028',
  tip: '#ff5060',
  halo: '#ff6f80',
  haze: ['#ff3355', '#ff6f9c'],
  absorb: 0.7,
  bright: 0.03,
  hazeBright: 0.05,
  stars: 60,
};

// Webb's NIRCam picture of 2022, which stands infrared for visible colours: gold see-through dust, deep blue
// behind, and the red tips where jets from stars forming inside strike the gas
const WEBB_PILLARS: PillarLook = {
  core: '#5a2c12',
  body: '#c0701e',
  lit: '#f2a446',
  tip: '#ff3a20',
  halo: '#6a9cff',
  haze: ['#10246a', '#2c56c4'],
  absorb: 0.04,
  bright: 0.16,
  hazeBright: 0.016,
  stars: 700,
};

/** The Pillars as built from lumps of dust along bending lines, lit from the cluster up and to one side. */
function pillarsOfCreation(b: Builder, look: PillarLook) {
  const first = b.size.length;
  const L = new Vector3(0.45, 1, -0.4).normalize();
  const pillars: { line: Vec[]; widths: number[]; lumps: number; tip?: boolean; dim?: number }[] = [
    // the tallest, rising out of the mass at the bottom
    {
      line: [
        [-1.3, -2.6, 0],
        [-1.0, -1.2, 0],
        [-0.6, 0.2, 0.1],
        [-0.25, 1.3, 0.15],
        [0.05, 2.0, 0.2],
      ],
      widths: [1.7, 1.1, 0.8, 0.65, 0.7],
      lumps: 220,
    },
    {
      line: [
        [0.2, -1.8, 0.3],
        [0.55, -0.6, 0.3],
        [0.9, 0.4, 0.3],
        [1.15, 1.0, 0.3],
      ],
      widths: [0.9, 0.6, 0.5, 0.4],
      lumps: 120,
      tip: true,
    },
    {
      line: [
        [1.1, -1.3, 0.4],
        [1.45, -0.5, 0.4],
        [1.7, 0.0, 0.4],
      ],
      widths: [0.45, 0.32, 0.28],
      lumps: 60,
      tip: true,
    },
    // the broad mass the pillars stand on, and the small one in front of it
    {
      line: [
        [-2.6, -3.6, -0.2],
        [-1.8, -3.0, -0.1],
        [-0.6, -2.7, 0],
        [0.6, -2.6, 0.2],
      ],
      widths: [2.0, 2.2, 1.8, 1.2],
      lumps: 140,
      dim: 0.45,
    },
    {
      line: [
        [-2.3, -3.4, -0.6],
        [-2.1, -2.6, -0.6],
        [-1.95, -2.1, -0.6],
      ],
      widths: [0.7, 0.5, 0.35],
      lumps: 50,
      tip: true,
    },
  ];
  const off = new Vector3();
  for (const pl of pillars) {
    const { line, widths } = pl;
    const at = (s: number): [Vec, number] => {
      const k = Math.min(Math.floor(s), line.length - 2);
      const t = s - k;
      return [
        [
          line[k][0] + (line[k + 1][0] - line[k][0]) * t,
          line[k][1] + (line[k + 1][1] - line[k][1]) * t,
          line[k][2] + (line[k + 1][2] - line[k][2]) * t,
        ],
        MathUtils.lerp(widths[k], widths[k + 1], t),
      ];
    };
    const dim = pl.dim ?? 1;
    for (let l = 0; l < pl.lumps; l++) {
      // more lumps toward the top, where the shapes are finest
      const s = Math.sqrt(b.rand()) * (line.length - 1);
      const [c, w] = at(s);
      off.set(b.gauss() * w * 0.28, b.gauss() * w * 0.12, b.gauss() * w * 0.28);
      const r = w * (0.18 + b.rand() * 0.22);
      for (let i = 0; i < 90; i++) {
        const q = new Vector3(b.gauss() * r, b.gauss() * r * 0.8, b.gauss() * r);
        const rel = q.clone().add(off);
        const rho = Math.min(1.2, Math.hypot(rel.x, rel.z) / (w * 0.5));
        const lit = MathUtils.clamp(rel.clone().normalize().dot(L) * Math.min(1, rho + 0.2), 0, 1);
        const color = mix(look.core, look.body, rho * rho).lerp(tmp.set(look.lit), lit * 0.85);
        // dark in the middle and bright on the lit skin, so the folds show
        b.add(
          [c[0] + rel.x, c[1] + rel.y, c[2] + rel.z],
          color,
          look.bright * dim * (0.08 + 1.4 * lit ** 1.5) * (0.6 + 0.8 * b.rand()),
          r * 0.5,
          look.absorb * (1 - 0.5 * rho),
        );
      }
    }
    // a glow off the lit edges
    for (let i = 0; i < 900; i++) {
      const s = b.rand() * (line.length - 1);
      const [c, w] = at(s);
      const a = b.rand() * 2 * Math.PI;
      const d = new Vector3(Math.cos(a), 0, Math.sin(a));
      if (d.dot(L) < 0.1) {
        continue;
      }
      const rr = w * (0.55 + Math.abs(b.gauss()) * 0.35);
      b.add(
        [c[0] + d.x * rr, c[1] + b.gauss() * 0.05, c[2] + d.z * rr],
        look.halo,
        look.hazeBright * 0.6,
        w * 0.4,
      );
    }
    if (pl.tip) {
      const [c, w] = at(line.length - 1.02);
      blob(
        b,
        [w * 0.35, w * 0.25, w * 0.3],
        120,
        look.tip,
        look.bright * 3,
        w * 0.12,
        add3(c, [0, w * 0.15, -w * 0.2]),
      );
    }
  }
  // the gas behind, and the stars of the field
  for (let i = 0; i < 5000; i++) {
    const p: Vec = [b.gauss() * 3.2, b.gauss() * 3.4, 2.2 + b.gauss() * 0.5];
    b.add(
      p,
      mix(look.haze[0], look.haze[1], b.rand() * b.rand() * 1.5),
      look.hazeBright * (0.8 + 0.4 * b.rand()),
      2.4,
    );
  }
  for (let i = 0; i < look.stars; i++) {
    const big = b.rand() < 0.05;
    b.add(
      [(b.rand() - 0.5) * 8, (b.rand() - 0.5) * 8, (b.rand() - 0.5) * 5],
      b.rand() < 0.5 ? '#fff6e8' : '#ffd8a0',
      big ? 1.5 : 0.5 + b.rand() * 0.6,
      big ? 0.04 : 0.018,
    );
  }
  // drawn as in the pictures, which are the other way round from this frame
  for (let i = first; i < b.size.length; i++) {
    b.pos[i * 3] *= -1;
  }
}

const srgb = (hex: Hex) => new Color(hex).convertLinearToSRGB();
const IR = {
  dust: srgb('#d08a34'),
  hydrogen: srgb('#3f6fe0'),
  oxygen: srgb('#86b4ff'),
  warm: srgb('#f0b060'),
};

/**
 * Turns a model's visible-light colours into the look of a near-infrared picture like Webb's, by rule rather
 * than from a picture of that nebula: dust that hides things in visible light glows a warm gold and lets most
 * light through, gas glowing red or teal comes out blue, as these pictures usually show it.
 */
function toInfrared(b: Builder) {
  const c = new Color();
  for (let i = 0; i < b.size.length; i++) {
    const r = b.col[i * 3];
    const g = b.col[i * 3 + 1];
    const bl = b.col[i * 3 + 2];
    const lum = Math.max(r, g, bl);
    const absorb = b.abs[i];
    if (absorb > 0.02) {
      c.copy(IR.dust).multiplyScalar(lum + absorb * 0.25);
      b.abs[i] = absorb * 0.12;
    } else if (Math.min(r, g, bl) > lum * 0.75) {
      // white-hot stays white
      continue;
    } else if (r > bl * 1.6 && g > bl * 1.3) {
      c.copy(IR.warm).multiplyScalar(lum);
    } else if (r >= g && r >= bl) {
      c.copy(IR.hydrogen).multiplyScalar(lum * 0.9);
    } else {
      c.copy(IR.oxygen).multiplyScalar(lum * 0.7);
    }
    b.col[i * 3] = c.r;
    b.col[i * 3 + 1] = c.g;
    b.col[i * 3 + 2] = c.b;
  }
}

// how many CSS pixels across a nebula is held at, when it would be smaller
const NEBULA_MIN_PX = 8;
// how far off, in light years, a nebula is no longer drawn
const NEBULA_FAR_LY = 25000;

/** A nebula's model: `pa` is the position angle of its x axis on the sky, degrees from north through east. */
interface Model {
  pa: number;
  // exposure, for the ones that need more or less than the rest
  glow?: number;
  // to fit a model drawn at one size to the measured one
  scale?: number;
  build: (b: Builder) => void;
  // the same nebula in the false colours of an infrared picture, where it has a famous one
  infrared?: (b: Builder) => void;
  // a nebula this one is a close-up of, faded out around it while this is shown in false colour
  covers?: string;
  infraredGlow?: number;
}

const MODELS: Record<string, Model> = {
  'ring-nebula': {
    pa: 60,
    build: (b) => {
      // teal inside from oxygen, red outside from hydrogen and nitrogen, the way the long exposures show it
      blob(b, [0.6, 0.6, 0.9], 1500, PAL.teal, 0.25, 0.25);
      barrel(b, {
        r: 0.45,
        len: 0.55,
        tilt: 30,
        n: 5000,
        thick: 0.45,
        bright: 0.55,
        color: (t) => (t < 0.5 ? mix(PAL.oiii, PAL.yellow, t * 2) : mix(PAL.yellow, PAL.nii, (t - 0.5) * 2)),
      });
      shells(b, [1.0, 1.2], 900, PAL.ha, 0.05);
    },
  },
  'helix-nebula': {
    pa: 120,
    build: (b) => {
      blob(b, [1.4, 1.4, 1.6], 2500, PAL.teal, 0.3, 0.6);
      barrel(b, {
        r: 1.0,
        len: 0.5,
        tilt: 12,
        n: 5500,
        thick: 0.5,
        bright: 0.45,
        color: (t) => mix(PAL.yellow, PAL.nii, t * 1.4),
      });
      // the second, outer ring at an angle to the first that gives it the look of a helix
      barrel(b, {
        r: 1.4,
        len: 0.6,
        tilt: 60,
        roll: 30,
        n: 2500,
        thick: 0.35,
        bright: 0.18,
        color: () => new Color(PAL.ha),
      });
    },
  },
  'dumbbell-nebula': {
    pa: 120,
    build: (b) => {
      // a football of red gas, seen side on, with the bright oxygen 'apple core' across its waist: an
      // hourglass, narrowest in the middle, which leaves the two dark 'bites' either side
      for (let i = 0; i < 5000; i++) {
        const y = MathUtils.clamp(b.gauss() * 0.55, -1.15, 1.15);
        const half = 0.3 + 0.45 * Math.abs(y);
        const p: Vec = [(b.rand() * 2 - 1) * half, y, b.gauss() * 0.35];
        b.add(
          p,
          mix(PAL.oiii, PAL.yellow, Math.abs(y) * 0.6 + b.rand() * 0.2),
          0.4 * (0.6 + 0.8 * b.rand()),
          0.22,
        );
      }
      clumps(b, {
        axes: [1.75, 1.2, 1.2],
        n: 6000,
        levels: [7, 5, 4],
        bright: 0.14,
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
      shells(b, [2.1], 900, PAL.ha, 0.04);
    },
  },
  'cats-eye-nebula': {
    pa: 0,
    build: (b) => {
      // crossing bubbles at the core, knots at their tips and, far out, the rings of earlier puffs
      for (const [deg, roll, len] of [
        [80, 0, 0.32],
        [70, 60, 0.26],
        [60, -40, 0.2],
      ] as const) {
        barrel(b, {
          r: 0.11,
          len,
          tilt: deg,
          roll,
          n: 1500,
          thick: 0.4,
          bright: 0.55,
          color: (t) => mix(PAL.oiii, PAL.teal, t),
        });
        const tip = turn([0, 0, len * 1.15], deg, roll);
        blob(b, [0.04, 0.04, 0.04], 120, PAL.nii, 0.8, 0.04, tip);
        blob(b, [0.04, 0.04, 0.04], 120, PAL.nii, 0.8, 0.04, [-tip[0], -tip[1], -tip[2]]);
      }
      shells(b, [0.6, 0.8, 1.0, 1.2, 1.4], 500, PAL.ha, 0.035);
      blob(b, [3, 3, 3], 1200, PAL.ha, 0.012, 0.8);
    },
  },
  'orion-nebula': {
    pa: 20,
    build: (b) => {
      // a blister on the face of a dark cloud: lit gas in front, the cloud it is eating into behind
      clumps(b, {
        axes: [10, 8, 4],
        n: 9000,
        center: [0, 0, -1],
        bright: 0.3,
        color: (_p, u) =>
          u < 0.35 ? mix(PAL.hot, PAL.oiii, u * 1.5) : mix(PAL.pink, PAL.ha, (u - 0.35) * 2),
      });
      blob(b, [3.5, 3, 2], 1500, PAL.hot, 0.35, 1.0, [0, 0, -1]);
      clumps(b, {
        axes: [16, 14, 5],
        n: 4000,
        center: [0, 0, 5],
        bright: 0.02,
        absorb: 0.35,
        levels: [8, 5, 4],
        color: () => new Color(PAL.dust),
      });
      // the dark bay between it and M43, and M43 itself
      lane(
        b,
        [
          [1, 3, -3],
          [3, 5, -3],
          [2, 7, -3],
        ],
        1.6,
        900,
        0.35,
      );
      blob(b, [1.6, 1.6, 1.4], 700, PAL.pink, 0.3, 0.6, [2.5, 7.5, -1]);
    },
  },
  'lagoon-nebula': {
    pa: 75,
    build: (b) => {
      clumps(b, {
        axes: [50, 22, 20],
        n: 11000,
        bright: 0.12,
        color: (_p, u) => (u < 0.2 ? mix(PAL.hot, PAL.pink, u * 5) : mix(PAL.pink, PAL.ha, u)),
      });
      // the bright Hourglass near its heart
      blob(b, [2.5, 4, 2.5], 800, PAL.hot, 0.45, 1.2, [-10, 1, 0]);
      // the dark lane that names it, lying across the front
      lane(
        b,
        [
          [-30, -10, -8],
          [-10, -2, -9],
          [8, 4, -9],
          [28, 10, -8],
        ],
        5,
        2200,
        0.3,
      );
    },
  },
  'trifid-nebula': {
    // y north
    pa: 90,
    build: (b) => {
      // red glowing gas to the south, blue dust lit by the same stars to the north
      clumps(b, {
        axes: [10, 10, 9],
        n: 7000,
        center: [0, -3, 0],
        bright: 0.2,
        levels: [8, 5, 4],
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
      clumps(b, {
        axes: [9, 7, 8],
        n: 4500,
        center: [0, 11, 1],
        bright: 0.13,
        levels: [7, 5, 4],
        color: (_p, u) => mix('#9fc0ff', PAL.blue, u),
      });
      // the three lanes that split it, meeting near the centre
      for (const deg of [100, 220, 330]) {
        const a = MathUtils.degToRad(deg);
        lane(
          b,
          [
            [0, -3, -6],
            [Math.cos(a) * 11, -3 + Math.sin(a) * 11, -6],
          ],
          1.4,
          700,
          0.45,
        );
      }
    },
  },
  'eagle-nebula': {
    // y north
    pa: 90,
    build: (b) => {
      // lit by the cluster NGC 6611, which sits a little north-west of the middle
      const star: Vec = [-6, 6, 0];
      clumps(b, {
        axes: [35, 28, 25],
        n: 12000,

        levels: [10, 6, 5],
        bright: 0.13,
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
      // the cluster has cleared a cavity open toward us, which is how we can see the Pillars standing in it
      // and the Pillars, which have their own entry, bring their own haze behind them
      b.carve(
        (p) => Math.hypot(p[0] - 2, p[1] + 3) > 7 || (p[2] > 2 && Math.hypot(p[0] - 2, p[1] + 3) > 4.5),
      );
      blob(b, [10, 10, 10], 900, PAL.hot, 0.06, 4, star);
      // the Spire; the Pillars of Creation are their own entry, drawn in more detail
      pillar(b, [-14, -6, -3], [-13, 3, -3], 1.6, 1400, [8, 12, 3]);
    },
  },
  'rosette-nebula': {
    pa: 0,
    build: (b) => {
      // a shell round the cluster NGC 2244, whose wind has blown out the middle
      clumps(b, {
        axes: [65, 60, 60],
        n: 16000,
        shell: [0.7, 1],
        levels: [24, 6, 5],
        bright: 0.08,
        color: (_p, u) => mix(PAL.pink, PAL.ha, (u - 0.6) * 2.5),
      });
      // small dark globules in the shell
      for (let i = 0; i < 12; i++) {
        const d = b.dir();
        const r = 30 + b.rand() * 20;
        blob(b, [2, 2, 2], 120, PAL.dust, 0.02, 1.5, [d[0] * r, d[1] * r, d[2] * r - 8], 0.5);
      }
    },
  },
  'carina-nebula': {
    pa: 60,
    build: (b) => {
      clumps(b, {
        axes: [115, 80, 70],
        n: 14000,
        levels: [12, 6, 5],
        bright: 0.07,
        color: (p, u) => {
          // whiter and with oxygen near Eta Carinae and Trumpler 14 at the heart
          const core = Math.hypot(p[0] + 10, p[1], p[2]) / 40;
          return core < 1 ? mix(PAL.oiii, PAL.pink, core) : mix(PAL.pink, PAL.ha, u);
        },
      });
      blob(b, [25, 20, 20], 1200, PAL.hot, 0.06, 8, [-10, 0, 0]);
      // the V of dust across the middle, and the Keyhole beside Eta Carinae
      lane(
        b,
        [
          [-70, 30, -20],
          [-15, -5, -25],
          [10, -40, -20],
        ],
        14,
        2400,
        0.3,
      );
      lane(
        b,
        [
          [-15, -5, -25],
          [40, 20, -22],
          [80, 30, -20],
        ],
        12,
        2000,
        0.3,
      );
      blob(b, [6, 4, 4], 400, PAL.dust, 0.02, 3, [-8, 6, -15], 0.5);
    },
  },
  'crab-nebula': {
    pa: 130,
    build: (b) => {
      // the pulsar's glow fills it with bluish-white light; the threads round it glow red and yellow
      blob(b, [6, 4, 4], 4000, PAL.sync, 0.09, 1.0);
      filaments(b, {
        axes: [5.5, 3.6, 3.6],
        count: 140,
        steps: 40,
        r: [0.75, 1],
        width: 0.22,
        bright: 0.25,
        color: (b) => mix(PAL.nii, PAL.yellow, b.rand() * 0.7),
      });
    },
  },
  'veil-nebula': {
    // x east
    pa: 90,
    build: (b) => {
      // a shell some 20,000 years old, bright only where we look along it: the Eastern and Western Veil on its
      // two edges, Pickering's Triangle between, and gaps elsewhere
      filaments(b, {
        axes: [60, 52, 55],
        count: 420,
        steps: 90,
        r: [0.9, 1],
        width: 0.9,
        bright: 0.3,
        patch: (d) =>
          0.08 + MathUtils.smoothstep(Math.abs(d[0]), 0.55, 0.9) + 0.4 * MathUtils.smoothstep(d[1], 0.5, 0.9),
        color: (b) => (b.rand() < 0.5 ? mix(PAL.oiii, PAL.teal, b.rand()) : mix(PAL.ha, PAL.pink, b.rand())),
      });
    },
  },
  'horsehead-nebula': {
    // y north, so 'up' here is up in the usual pictures
    pa: 90,
    build: (b) => {
      // the glowing sheet IC 434 behind, lit from the north by Sigma Orionis, and the dark cloud in front of it
      for (let i = 0; i < 10000; i++) {
        const p: Vec = [b.gauss() * 2.6, b.gauss() * 2.4 + 0.5, 1.5 + b.gauss() * 0.4];
        const k = 0.35 + MathUtils.smoothstep(p[1], -3, 4);
        b.add(p, mix(PAL.ha, PAL.pink, b.rand() * 0.3), 0.12 * k * (0.7 + 0.6 * b.rand()), 0.5);
      }
      // the cloud along the bottom, with a ragged top
      for (let i = 0; i < 6000; i++) {
        const x = b.gauss() * 3;
        const top = -1.4 + Math.sin(x * 1.7) * 0.3 + b.gauss() * 0.15;
        const y = top - Math.abs(b.gauss()) * 2.5;
        b.add([x, y, b.gauss() * 0.4], PAL.dust, 0.01, 0.55, 0.5);
      }
      // the horse: a neck rising out of the cloud, and the head bent over with its muzzle down
      lane(
        b,
        [
          [-0.3, -1.5, 0],
          [-0.2, -0.5, 0],
          [0, 0.4, 0],
        ],
        0.75,
        1200,
        0.8,
      );
      blob(b, [0.9, 0.7, 0.6], 700, PAL.dust, 0.01, 0.4, [0.2, 0.9, 0], 0.8);
      lane(
        b,
        [
          [0.4, 1.0, 0],
          [0.9, 0.6, 0],
          [1.0, 0.0, 0],
        ],
        0.45,
        600,
        0.8,
      );
      // NGC 2023, dust lit blue by a young star, down in the cloud to the east
      blob(b, [0.8, 0.8, 0.8], 600, PAL.blue, 0.12, 0.5, [-2.5, -2.6, -0.8]);
    },
  },
  coalsack: {
    pa: 90,
    glow: 0.15,
    build: (b) => {
      // dust and nothing to light it but the stars around: from here it is a hole in the Milky Way
      clumps(b, {
        axes: [36, 26, 14],
        n: 9000,
        levels: [10, 6, 5],
        bright: 0.012,
        absorb: 0.22,
        size: 2.6,
        color: () => new Color(PAL.dust),
      });
    },
  },
  'southern-ring-nebula': {
    pa: 75,
    scale: 0.8,
    build: (b) => {
      // like the Ring, a barrel seen near its axis, but further from it, so an oval with rippled shells round it
      blob(b, [0.36, 0.28, 0.3], 1500, PAL.teal, 0.3, 0.1);
      barrel(b, {
        r: 0.22,
        len: 0.26,
        tilt: 45,
        n: 5000,
        thick: 0.5,
        bright: 0.5,
        color: (t) =>
          t < 0.45 ? mix(PAL.oiii, PAL.yellow, t * 2.2) : mix(PAL.orange, PAL.nii, (t - 0.45) * 2),
      });
      for (const r of [0.34, 0.38, 0.42, 0.46]) {
        bubble(b, [r * 1.2, r, r], 500, () => mix(PAL.orange, PAL.ha, b.rand()), 0.04, 0.012);
      }
    },
  },
  'eskimo-nebula': {
    pa: 0,
    scale: 1.9,
    build: (b) => {
      // a bright inner bubble seen almost end on, with a hood of comet-like streaks blown outward round it
      barrel(b, {
        r: 0.13,
        len: 0.2,
        tilt: 15,
        n: 2500,
        thick: 0.5,
        bright: 0.55,
        color: (t) => mix(PAL.hot, PAL.oiii, t),
      });
      blob(b, [0.22, 0.22, 0.22], 1200, PAL.hot, 0.3, 0.08);
      for (let i = 0; i < 420; i++) {
        const d = b.dir();
        const r0 = 0.3 + b.rand() * 0.06;
        const len = 0.05 + b.rand() * 0.08;
        const c = mix(PAL.orange, PAL.nii, b.rand());
        for (let s = 0; s < 12; s++) {
          const r = r0 + (len * s) / 12;
          b.add([d[0] * r, d[1] * r, d[2] * r], c, 0.9 * (1 - s / 14), 0.03);
        }
      }
      bubble(b, [0.38, 0.38, 0.38], 1500, () => new Color(PAL.pink), 0.06, 0.06);
    },
  },
  'butterfly-nebula': {
    pa: 110,
    build: (b) => {
      // two lobes of glowing gas from a star buried in a thick torus of dust, which hides it from us
      lobes(
        b,
        1.6,
        0.42,
        9000,
        (t) => (t < 0.3 ? mix(PAL.hot, PAL.oiii, t * 3) : mix(PAL.nii, PAL.ha, t)),
        0.5,
      );
      blob(b, [0.25, 0.2, 0.2], 800, PAL.hot, 0.15, 0.08);
      lane(
        b,
        [
          [0.05, -0.45, -0.12],
          [0, 0, -0.15],
          [-0.05, 0.45, -0.12],
        ],
        0.12,
        400,
        0.5,
      );
    },
  },
  'owl-nebula': {
    pa: 90,
    scale: 1.25,
    build: (b) => {
      // a sphere of gas with two emptier hollows, side by side as we see them: the dark 'eyes'
      for (let i = 0; i < 14000; i++) {
        const d = b.dir();
        const r = Math.cbrt(b.rand());
        const p: Vec = [d[0] * r, d[1] * r, d[2] * r];
        if (Math.hypot(Math.abs(p[0]) - 0.34, p[1] - 0.08) < 0.27 && Math.abs(p[2]) < 0.95) {
          continue;
        }
        b.add(p, mix(PAL.oiii, PAL.teal, r), 0.12 * (0.6 + 0.8 * b.rand()), 0.18);
      }
      bubble(b, [1.05, 1.05, 1.05], 1500, () => new Color(PAL.ha), 0.04, 0.03);
    },
  },

  'cone-nebula': {
    pa: 90,
    build: (b) => {
      // NGC 2264: red gas lit by the young cluster round S Monocerotis to the north, and the Cone, a pillar of
      // dust to the south, pointing at it
      clumps(b, {
        axes: [16, 20, 12],
        n: 10000,
        levels: [9, 6, 5],
        bright: 0.13,
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
      blob(b, [4, 4, 4], 900, PAL.blue, 0.12, 1.5, [1, 10, -2]);
      blob(b, [1.2, 1.2, 1.2], 200, PAL.hot, 0.5, 0.6, [1, 10, -2]);
      column(
        b,
        [
          [2.5, -15.5, -3],
          [2.7, -12.5, -3],
          [2.9, -9, -3],
        ],
        [1.4, 0.7, 0.2],
        3000,
        [0, 1, -0.3],
        0.6,
      );
      // the Fox Fur, dark folds of dust just north of the cluster
      lane(
        b,
        [
          [-2, 12, -5],
          [1, 14, -5],
          [4, 13, -5],
        ],
        1.2,
        700,
        0.35,
      );
    },
  },
  'north-america-nebula': {
    // y north, x east
    pa: 90,
    build: (b) => {
      // the dust in front dims blue Hβ more than red Hα, so it is redder and warmer than the pink of most
      // emission nebulae
      // two glowing clouds, NGC 7000 to the east and the Pelican to the west, with the dark cloud L935 lying
      // in front between them, which is all that makes the outline of the continent
      clumps(b, {
        axes: [42, 40, 25],
        n: 11000,
        center: [26, 0, 0],
        levels: [12, 6, 5],
        bright: 0.1,
        color: (_p, u) => mix(REDDENED, PAL.ha, u),
      });
      clumps(b, {
        axes: [18, 22, 14],
        n: 5000,
        center: [-42, 4, 0],
        levels: [7, 6, 5],
        bright: 0.16,
        color: (_p, u) => mix(REDDENED, PAL.ha, u),
      });
      lane(
        b,
        [
          [-12, 40, -12],
          [-14, 15, -12],
          [-8, -8, -12],
          [-14, -35, -12],
        ],
        7,
        2500,
        0.3,
      );
      // the Gulf of Mexico, and the bright Cygnus Wall along the 'Mexico' coast below it
      blob(b, [10, 8, 6], 900, PAL.dust, 0.01, 4, [6, -16, -10], 0.45);
      lane(
        b,
        [
          [4, -28, -4],
          [14, -33, -4],
          [24, -31, -4],
        ],
        4,
        1500,
        0,
        REDDENED,
        0.05,
      );
    },
  },
  'heart-nebula': {
    pa: 90,
    scale: 1.85,
    build: (b) => {
      // a shell blown out by the cluster Melotte 15 at its heart
      clumps(b, {
        axes: [80, 72, 60],
        n: 13000,
        shell: [0.6, 1],
        levels: [20, 6, 5],
        bright: 0.09,
        color: (_p, u) => mix(PAL.pink, PAL.ha, (u - 0.5) * 2),
      });
      blob(b, [10, 10, 10], 500, PAL.hot, 0.05, 5);
      // the notch at the top of the heart
      lane(
        b,
        [
          [0, 85, -20],
          [0, 50, -20],
        ],
        14,
        900,
        0.35,
      );
      // the bright knot NGC 896 on its western edge, the Fish Head
      blob(b, [10, 8, 8], 800, PAL.pink, 0.25, 4, [-62, 18, -10]);
    },
  },
  'soul-nebula': {
    pa: 90,
    scale: 1.8,
    build: (b) => {
      // two cavities side by side, each blown by its own cluster
      for (const x of [-40, 38]) {
        clumps(b, {
          axes: [42, 38, 34],
          n: 7000,
          center: [x, 0, 0],
          shell: [0.55, 1],
          levels: [14, 6, 5],
          bright: 0.08,
          color: (_p, u) => mix(PAL.pink, PAL.ha, (u - 0.5) * 2),
        });
        blob(b, [6, 6, 6], 300, PAL.hot, 0.05, 3, [x, 0, 0]);
      }
    },
  },
  'pacman-nebula': {
    pa: 90,
    scale: 2,
    build: (b) => {
      // a round cloud with a wedge of dust across its front: the mouth
      clumps(b, {
        axes: [24, 24, 18],
        n: 9000,
        levels: [10, 6, 5],
        bright: 0.14,
        color: (_p, u) => (u < 0.3 ? mix(PAL.hot, PAL.pink, u * 3) : mix(PAL.pink, PAL.ha, u)),
      });
      const mouth = (deg: number) => {
        const a = MathUtils.degToRad(deg);
        lane(
          b,
          [
            [0, 0, -12],
            [Math.cos(a) * 26, Math.sin(a) * 26, -12],
          ],
          3,
          900,
          0.55,
        );
      };
      for (const deg of [-30, -15, 0, 15, 30]) {
        mouth(deg);
      }
    },
  },
  'bubble-nebula': {
    pa: 0,
    scale: 1.2,
    build: (b) => {
      // a bubble blown by one hot star, set a little off its centre, into the edge of a larger cloud
      bubble(b, [3.5, 3.5, 3.5], 9000, (d) => mix(PAL.oiii, PAL.teal, 0.5 + d[1] * 0.5), 0.15, 0.02);
      blob(b, [2.6, 2.6, 2.6], 800, PAL.teal, 0.04, 1.0);
      clumps(b, {
        axes: [14, 10, 10],
        n: 8000,
        center: [9, -7, 8],
        levels: [9, 6, 5],
        bright: 0.05,
        color: (_p, u) => (u < 0.4 ? mix(PAL.orange, PAL.ha, u * 2.5) : mix(PAL.ha, PAL.nii, u)),
      });
    },
  },
  'witch-head-nebula': {
    pa: 160,
    glow: 0.6,
    build: (b) => {
      // dust lit by Rigel, faint and blue: the same reason the sky is blue
      clumps(b, {
        axes: [30, 7, 6],
        n: 9000,
        levels: [10, 7, 5],
        shrink: 0.38,
        bright: 0.1,
        color: (_p, u) => mix('#9fc0ff', PAL.blue, u),
      });
    },
  },
  'rho-ophiuchi': {
    // y north, x east
    pa: 90,
    build: (b) => {
      // three stars light three colours of the same dust: blue round Rho Ophiuchi to the north, yellow round
      // Antares to the south (which is further off, some hundred light years behind), and red round Sigma
      // Scorpii to the west, with dark lanes trailing east
      clumps(b, {
        axes: [9, 8, 6],
        n: 5000,
        center: [-0.7, 12, 0],
        levels: [8, 6, 5],
        bright: 0.14,
        color: (_p, u) => mix('#9fc0ff', PAL.blue, u),
      });
      clumps(b, {
        axes: [11, 10, 9],
        n: 5000,
        center: [6, -11, 104],
        levels: [8, 6, 5],
        bright: 0.14,
        color: (_p, u) => mix(PAL.yellow, PAL.orange, u),
      });
      clumps(b, {
        axes: [8, 8, 6],
        n: 4000,
        center: [-8.5, -4.6, 0],
        levels: [7, 6, 5],
        bright: 0.12,
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
      for (const [y, w] of [
        [12, 3],
        [8, 2.2],
        [4, 1.6],
      ] as const) {
        lane(
          b,
          [
            [-2, y, -3],
            [12, y + 2, -3],
            [28, y + 6, -3],
            [42, y + 7, -3],
          ],
          w,
          1400,
          0.3,
        );
      }
    },
  },
  'cassiopeia-a': {
    pa: 0,
    scale: 1.6,
    build: (b) => {
      // the youngest known remnant in the Galaxy: a broken shell of fast threads of oxygen, sulphur and
      // hydrogen, with nothing in the middle that glows in visible light
      filaments(b, {
        axes: [5, 5, 5],
        count: 700,
        steps: 10,
        r: [0.7, 1],
        width: 0.18,
        bright: 0.6,
        // brightest round the rim, where we look along the shell
        patch: (d) => 1 - 0.75 * Math.abs(d[2]),
        color: (b) => {
          const u = b.rand();
          return u < 0.45
            ? mix(PAL.ha, PAL.pink, b.rand())
            : u < 0.8
              ? mix(PAL.oiii, PAL.teal, b.rand())
              : mix(PAL.yellow, PAL.orange, b.rand());
        },
      });
      bubble(b, [4.5, 4.5, 4.5], 1500, () => new Color(PAL.pink), 0.02, 0.08);
    },
  },
  'tarantula-nebula': {
    pa: 90,
    scale: 3,
    build: (b) => {
      // round the cluster R136, the most massive stars known, which have blown a cavity with arms of gas
      // reaching out from it like legs
      clumps(b, {
        axes: [300, 260, 220],
        n: 12000,
        shell: [0.3, 1],
        levels: [18, 6, 5],
        bright: 0.09,
        color: (_p, u) => (u < 0.45 ? mix(PAL.oiii, PAL.pink, u * 2) : mix(PAL.pink, PAL.ha, u)),
      });
      // the legs: arcs of gas curling out from the middle
      for (let i = 0; i < 9; i++) {
        const a0 = (i / 9) * 2 * Math.PI + b.gauss() * 0.2;
        const bend = b.gauss() * 0.5;
        const pts: Vec[] = [];
        for (let k = 0; k <= 5; k++) {
          const r = 70 + k * 45;
          const a = a0 + bend * (k / 5);
          pts.push([Math.cos(a) * r * 1.1, Math.sin(a) * r, b.gauss() * 30]);
        }
        lane(b, pts, 28, 900, 0, PAL.pink, 0.08);
      }
      blob(b, [30, 30, 30], 800, PAL.hot, 0.25, 12);
    },
  },
  'thors-helmet': {
    pa: 90,
    scale: 1.15,
    build: (b) => {
      // a bubble of oxygen blown by a Wolf-Rayet star, with red 'wings' either side where it breaks out
      bubble(b, [6, 5.5, 5.5], 5000, () => mix(PAL.oiii, PAL.teal, b.rand()), 0.18, 0.06);
      blob(b, [8, 7, 7], 1500, PAL.oiii, 0.05, 2);
      for (const s of [-1, 1]) {
        clumps(b, {
          axes: [7, 5, 5],
          n: 3000,
          center: [s * 10, s * 2, 0],
          levels: [6, 6, 4],
          bright: 0.13,
          color: (_p, u) => mix(PAL.pink, PAL.ha, u),
        });
      }
      clumps(b, {
        axes: [18, 14, 12],
        n: 3000,
        levels: [8, 5, 4],
        bright: 0.04,
        color: (_p, u) => mix(PAL.pink, PAL.ha, u),
      });
    },
  },
  'iris-nebula': {
    pa: 0,
    build: (b) => {
      // dust lit blue by the star in its middle, threaded with faint red, inside a larger dark cloud
      clumps(b, {
        axes: [3, 3, 2.5],
        n: 7000,
        levels: [8, 6, 5],
        bright: 0.18,
        color: (_p, u) => (u < 0.25 ? mix(PAL.hot, '#9fc0ff', u * 4) : mix('#9fc0ff', PAL.blue, u)),
      });
      filaments(b, {
        axes: [2, 2, 2],
        count: 40,
        steps: 25,
        r: [0.3, 1],
        width: 0.08,
        bright: 0.12,
        color: () => new Color(PAL.ha),
      });
      clumps(b, {
        axes: [8, 8, 6],
        n: 5000,
        shell: [0.4, 1],
        center: [0, 0, 1],
        levels: [12, 6, 5],
        bright: 0.01,
        absorb: 0.3,
        color: () => new Color(PAL.dust),
      });
    },
  },
  'flame-nebula': {
    // y north
    pa: 90,
    build: (b) => {
      // glowing gas round a cluster hidden in dust, with a dark trunk and its branches lying across the front
      clumps(b, {
        axes: [6, 6, 5],
        n: 8000,
        levels: [9, 6, 5],
        bright: 0.17,
        color: (_p, u) => (u < 0.4 ? mix(PAL.yellow, PAL.orange, u * 2.5) : mix(PAL.orange, PAL.ha, u)),
      });
      lane(
        b,
        [
          [0.3, -6, -2.5],
          [0, -2, -2.5],
          [-0.3, 1, -2.5],
          [0.2, 4.5, -2.5],
        ],
        1.2,
        1800,
        0.7,
      );
      for (const [y, dx, dy] of [
        [-1, 3, 1.5],
        [-0.5, -3, 2],
        [1.5, 3, 2.5],
        [2.5, -2.5, 1],
      ] as const) {
        lane(
          b,
          [
            [0, y, -2.5],
            [dx, y + dy, -2.5],
          ],
          0.6,
          400,
          0.6,
        );
      }
    },
  },
  'pillars-of-creation': {
    // y up the pillars, toward the cluster in the north-west
    pa: 45,
    scale: 0.9,
    covers: 'eagle-nebula',
    // the dense dust piles up far less light on screen than its points add up to
    infraredGlow: 2,
    build: (b) => pillarsOfCreation(b, EYE_PILLARS),
    infrared: (b) => pillarsOfCreation(b, WEBB_PILLARS),
  },
};

/**
 * How much to scale a nebula's light so its brightest parts, as seen from Earth, come out near full without
 * burning out to white: the points' light is summed onto a grid across the sky and the 98th percentile taken.
 */
function exposure(b: Builder) {
  const N = 96;
  // fine enough for a small bright core: a faint halo far out would otherwise set the cell size
  const reach = Array.from({ length: b.size.length }, (_, i) =>
    Math.max(Math.abs(b.pos[i * 3]), Math.abs(b.pos[i * 3 + 1])),
  ).sort((a, c) => a - c);
  const ext = reach[Math.floor(reach.length * 0.9)] || 1;
  const cell = (2 * ext) / N;
  // per channel, since teal laid over red adds up to white
  const grid = new Float32Array(N * N * 3);
  for (let i = 0; i < b.size.length; i++) {
    const r = Math.max(0, Math.floor(b.size[i] / 2 / cell));
    const cx = Math.floor((b.pos[i * 3] + ext) / cell);
    const cy = Math.floor((b.pos[i * 3 + 1] + ext) / cell);
    if (cx < -r || cy < -r || cx >= N + r || cy >= N + r) {
      continue;
    }
    // a point's mean brightness over its square is about a fifth of its peak
    const share = (0.2 * b.size[i] ** 2) / (cell * cell * (2 * r + 1) ** 2);
    for (let y = Math.max(0, cy - r); y <= Math.min(N - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(N - 1, cx + r); x++) {
        for (let c = 0; c < 3; c++) {
          grid[(y * N + x) * 3 + c] += share * b.col[i * 3 + c];
        }
      }
    }
  }
  const peaks: number[] = [];
  for (let k = 0; k < N * N; k++) {
    const m = Math.max(grid[k * 3], grid[k * 3 + 1], grid[k * 3 + 2]);
    if (m > 0) {
      peaks.push(m);
    }
  }
  // the brightest cell, as a small bright core within a wide faint halo would be lost in any percentile
  return 0.95 / Math.max(...peaks, 1e-9);
}

const NCP: Vec = [0, Math.sin(MathUtils.degToRad(23.4392911)), Math.cos(MathUtils.degToRad(23.4392911))];

interface Nebula {
  id: string;
  group: Group;
  points: Points;
  mat: ShaderMaterial;
  center: Vec;
  radius: number;
  basis: [Vector3, Vector3, Vector3];
  grow: number;
  count: number;
  // the camera, in the nebula's frame, when its points were last put in order back to front
  sortedFrom: Vector3;
  depth: Float32Array;
  order: Uint32Array;
  // which picture this model is of, for a nebula that has both
  infrared?: boolean;
  covers?: string;
}

/** The modelled nebulae, each placed and turned as it is on our sky. */
export class Nebulae {
  private readonly list: Nebula[] = [];
  private readonly infrared = new Set<string>();
  private readonly inv = new Matrix4();
  private readonly v = new Vector3();

  private readonly parent: Group;
  private readonly maxPoint: number;
  private readonly regions = new Map<string, Region>();

  constructor(parent: Group, regions: Region[], maxPoint: number) {
    this.parent = parent;
    this.maxPoint = maxPoint;
    for (const r of regions) {
      const model = MODELS[r.id];
      if (r.at?.type !== 'nebula' || !model) {
        continue;
      }
      this.regions.set(r.id, r);
      // the Pillars are best known from Webb's picture, so they open in it; the other look is built when first
      // asked for
      const ir = !!model.infrared;
      if (ir) {
        this.infrared.add(r.id);
      }
      this.make(r, model, ir);
    }
  }

  private make(r: Region, model: Model, infrared: boolean) {
    const at = r.at;
    if (!at) {
      return;
    }
    const build = infrared
      ? (model.infrared ??
        ((b: Builder) => {
          model.build(b);
          toInfrared(b);
        }))
      : model.build;
    const maxPoint = this.maxPoint;
    const parent = this.parent;
    const extra = infrared ? (model.infraredGlow ?? 1) : (model.glow ?? 1);
    const b = new Builder(r.id.length * 7919 + at.ra * 13);
    build(b);
    if (model.scale) {
      for (let i = 0; i < b.pos.length; i++) {
        b.pos[i] *= model.scale;
      }
      for (let i = 0; i < b.size.length; i++) {
        b.size[i] *= model.scale;
      }
    }
    const n = b.size.length;
    const pos = new Float32Array(b.pos.map((x) => x * AU_PER_LY));
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(b.col), 3));
    g.setAttribute('aAbsorb', new BufferAttribute(new Float32Array(b.abs), 1));
    const pick = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pick[i] = Math.random();
    }
    g.setAttribute('aPick', new BufferAttribute(pick, 1));
    g.setAttribute('aSize', new BufferAttribute(new Float32Array(b.size.map((x) => x * AU_PER_LY)), 1));
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      order[i] = i;
    }
    g.setIndex(new BufferAttribute(order, 1));
    const mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        scale: { value: 1 },
        pxMin: { value: 1.5 },
        pxMax: { value: maxPoint },
        thin: { value: 80 },
        glow: { value: extra * exposure(b) },
        dust: { value: 1 },
        grow: { value: 1 },
        lod: { value: 1 },
        seen: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    const points = new Points(g, mat);
    points.frustumCulled = false;
    // after the stars and the Galaxy, so the dust can darken them
    points.renderOrder = 10;

    // x along the long axis at its position angle, y across it, z away from us
    const z = eclipticDir(at.ra, at.dec);
    const east = new Vector3(...NCP).cross(new Vector3(...z)).normalize();
    const north = new Vector3(...z).cross(east);
    const pa = MathUtils.degToRad(model.pa);
    const ux = north.clone().multiplyScalar(Math.cos(pa)).addScaledVector(east, Math.sin(pa));
    const uy = new Vector3(...z).cross(ux);
    const group = new Group();
    group.matrixAutoUpdate = false;
    const d = at.ly * AU_PER_LY;
    const center: Vec = [z[0] * d, z[1] * d, z[2] * d];
    const basis: [Vector3, Vector3, Vector3] = [ux, uy, new Vector3(...z)];
    group.matrix.makeBasis(...basis).setPosition(...center);
    group.add(points);
    parent.add(group);
    this.list.push({
      id: r.id,
      covers: model.covers,
      group,
      points,
      mat,
      center,
      radius: at.radius * AU_PER_LY,
      basis,
      grow: 1,
      count: n,
      sortedFrom: new Vector3(Number.NaN, 0, 0),
      depth: new Float32Array(n),
      order,
      infrared,
    });
  }

  /** Ids of the nebulae drawn plainly enough this frame to be worth a label. */
  readonly shown = new Set<string>();

  hasInfrared(id: string) {
    return this.regions.has(id);
  }

  /** Whether the infrared look is copied from a real picture, rather than worked out from the visible one. */
  infraredFromPhoto(id: string) {
    return !!MODELS[id]?.infrared;
  }

  /** Shows a nebula as Webb sees it in the infrared, or as the eye would. */
  setInfrared(id: string, on: boolean) {
    const r = this.regions.get(id);
    if (r && !this.list.some((n) => n.id === id && n.infrared === on)) {
      this.make(r, MODELS[id], on);
    }
    if (on) {
      this.infrared.add(id);
    } else {
      this.infrared.delete(id);
    }
  }

  isInfrared(id: string) {
    return this.infrared.has(id);
  }

  has(id: string) {
    return this.list.some((n) => n.id === id);
  }

  /**
   * `cam` is the camera in ecliptic AU, `height` the canvas height in CSS px. Unless `trueSize`, a nebula too
   * small to see is held at a few pixels across so it can be found, until the camera is out among the
   * galaxies; at true size it is left to shrink and fades once it is only a pixel or two.
   */
  update(cam: Vec, height: number, fovDeg: number, pixelRatio: number, on: boolean, trueSize: boolean) {
    this.shown.clear();
    const scale = (height * pixelRatio) / (2 * Math.tan(MathUtils.degToRad(fovDeg / 2)));
    const sunDist = Math.hypot(...cam);
    const hold = NEBULA_MIN_PX * minSizeAt(sunDist, 3e4, 3e5);
    // in and around the Solar System the sky is the background picture, which has its own Milky Way; the
    // nebulae come in with the 3D stars, once the camera is out among them
    const out = MathUtils.smoothstep(Math.log10(Math.max(sunDist, 1)), 4.6, 5.4);
    // a close-up in false colour would clash with the true-colour nebula around it, so that one fades nearby
    const fade = new Map<string, number>();
    for (const n of this.list) {
      if (n.covers && n.infrared && this.infrared.has(n.id)) {
        const d = Math.hypot(cam[0] - n.center[0], cam[1] - n.center[1], cam[2] - n.center[2]) / AU_PER_LY;
        fade.set(n.covers, MathUtils.smoothstep(d, 20, 45));
      }
    }
    for (const n of this.list) {
      n.group.visible = on;
      if (!on) {
        continue;
      }
      if (n.infrared !== undefined && n.infrared !== this.infrared.has(n.id)) {
        n.group.visible = false;
        continue;
      }
      const dist = Math.hypot(cam[0] - n.center[0], cam[1] - n.center[1], cam[2] - n.center[2]);
      // from far enough out to take in the Galaxy they are lost in it anyway, and drawing them all costs a lot
      const far =
        (fade.get(n.id) ?? 1) *
        out *
        (1 - MathUtils.smoothstep(dist / AU_PER_LY, NEBULA_FAR_LY * 0.6, NEBULA_FAR_LY));
      n.group.visible = far > 0;
      if (far === 0) {
        continue;
      }
      n.mat.uniforms.scale.value = scale;
      const px = (n.radius * scale) / Math.max(dist, 1);
      const across = (2 * px) / pixelRatio;
      const grow = trueSize ? 1 : Math.max(1, hold / across);
      const seen = far * (trueSize ? MathUtils.smoothstep(across, 1, 4) : 1);
      n.mat.uniforms.seen.value = seen;
      if (seen > 0.3) {
        this.shown.add(n.id);
      }
      n.points.visible = seen > 0;
      // a nebula a few pixels across needs only a few hundred of its points, drawn brighter; all of them piled
      // on the same pixels is what slows the GPU when the whole Galaxy is in view
      const dev = across * grow * pixelRatio;
      n.mat.uniforms.lod.value = Math.min(1, Math.max(64, dev * dev * 0.5) / n.count);
      if (grow !== n.grow) {
        n.grow = grow;
        n.mat.uniforms.grow.value = grow;
        const [x, y, z] = n.basis;
        n.group.matrix
          .makeBasis(
            x.clone().multiplyScalar(grow),
            y.clone().multiplyScalar(grow),
            z.clone().multiplyScalar(grow),
          )
          .setPosition(...n.center);
      }
      // order only matters where glow and dust overlap on more than a few pixels
      if (px > 40) {
        this.v.set(...cam);
        this.inv.copy(n.group.matrix).invert();
        this.v.applyMatrix4(this.inv);
        const moved = this.v.distanceTo(n.sortedFrom);
        if (!(moved < Math.max(this.v.length(), n.radius) * 0.03)) {
          this.sort(n, this.v);
        }
      }
    }
  }

  private sort(n: Nebula, from: Vector3) {
    const pos = n.points.geometry.getAttribute('position').array as Float32Array;
    const { depth, order } = n;
    for (let i = 0; i < depth.length; i++) {
      depth[i] = (pos[i * 3] - from.x) ** 2 + (pos[i * 3 + 1] - from.y) ** 2 + (pos[i * 3 + 2] - from.z) ** 2;
    }
    order.sort((a, b) => depth[b] - depth[a]);
    const index = n.points.geometry.getIndex() as BufferAttribute;
    index.needsUpdate = true;
    n.sortedFrom.copy(from);
  }
}
