import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  type Group,
  MathUtils,
  Points,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { rng } from './particles';
import { AU_PER_LY } from './stars';

// Measured: the Sun's distance from the centre (GRAVITY 2019) and its height above the plane (Bennett & Bovy 2019)
const R0 = 8.178;
const Z_SUN = 0.0208;
const LY_PER_KPC = 3261.56;

// Spiral arms as log spirals fitted to maser parallaxes (Reid et al. 2014): reference radius in kpc, azimuth in
// degrees from the Sun's direction as seen from the centre, pitch angle in degrees, and how strongly each shows.
// Measured only on our side of the Galaxy; the far side is the same spirals carried on.
export const ARMS = [
  { id: 'scutum-centaurus', r: 5.0, beta: 27.6, pitch: 19.8, weight: 1 },
  { id: 'sagittarius-carina', r: 6.6, beta: 25.6, pitch: 8.7, weight: 0.6 },
  { id: 'local', r: 8.4, beta: 8.9, pitch: 12.8, weight: 0.35, span: [-35, 45] },
  { id: 'perseus', r: 9.9, beta: 14.2, pitch: 9.4, weight: 1 },
  { id: 'outer', r: 13.0, beta: 18.6, pitch: 13.8, weight: 0.5 },
] as const;

// galactic to equatorial J2000 (the transpose of the IAU equatorial-to-galactic matrix)
const G2E = [
  [-0.0548755604, 0.4941094279, -0.867666149],
  [-0.8734370902, -0.44482963, -0.1980763734],
  [-0.4838350155, 0.7469822445, 0.4559837762],
];
const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;

/**
 * Heliocentric galactic kpc (X toward the centre, Y toward l = 90°, the way the Sun orbits, Z to the north
 * pole) to heliocentric ecliptic AU.
 */
function toEcliptic(x: number, y: number, z: number): Vec {
  const ex = G2E[0][0] * x + G2E[0][1] * y + G2E[0][2] * z;
  const ey = G2E[1][0] * x + G2E[1][1] * y + G2E[1][2] * z;
  const ez = G2E[2][0] * x + G2E[2][1] * y + G2E[2][2] * z;
  const k = LY_PER_KPC * AU_PER_LY;
  return [
    ex * k,
    (ey * Math.cos(OBLIQUITY) + ez * Math.sin(OBLIQUITY)) * k,
    (-ey * Math.sin(OBLIQUITY) + ez * Math.cos(OBLIQUITY)) * k,
  ];
}

/**
 * Look direction for a camera above the galactic plane on the Sun's side, `tilt` degrees up from the plane,
 * so the Galaxy is seen from outside rather than edge on.
 */
export function galaxyLook(tilt: number): Vec {
  const n = toEcliptic(0, 0, 1);
  const c = toEcliptic(-1, 0, 0);
  const k = Math.hypot(...n);
  const t = (tilt * Math.PI) / 180;
  return [0, 1, 2].map((i) => -(Math.cos(t) * c[i] + Math.sin(t) * n[i]) / k) as Vec;
}

/**
 * A point given by galactocentric radius R (kpc), azimuth beta (rad, 0 toward the Sun, growing the way the
 * Galaxy turns) and height z (kpc above the plane), in heliocentric ecliptic AU.
 */
export function galactic(r: number, beta: number, z: number): Vec {
  return toEcliptic(R0 - r * Math.cos(beta), r * Math.sin(beta), z - Z_SUN);
}

/** Where arm `a` crosses radius r, as an azimuth in radians. */
export function armBeta(a: (typeof ARMS)[number], r: number) {
  return (a.beta * Math.PI) / 180 - Math.log(r / a.r) / Math.tan((a.pitch * Math.PI) / 180);
}

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aColor;
attribute float aSize;
uniform float scale;
uniform float pxMin;
uniform float pxMax;
uniform float gain;
uniform vec2 shrink;
varying vec3 vColor;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // aSize is a size in AU; on screen it shrinks with distance like anything real
  float px = aSize * scale / max(-mv.z, 1.0);
  gl_PointSize = clamp(px, pxMin, pxMax);
  // a point held up at the minimum size spreads the same light over more pixels
  float f = min(px / pxMin, 1.0);
  vFade = f * f * gain;
  // close up the haze would only be a blur over the points that already show the structure
  vFade *= 1.0 - smoothstep(shrink.x, shrink.y, px);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float opacity;
varying vec3 vColor;
varying float vFade;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.0);
  gl_FragColor = vec4(vColor, a * vFade * opacity);
  #include <colorspace_fragment>
}
`;

const COLORS = {
  bulge: new Color('#ffd7a3'),
  disk: new Color('#efe3cf'),
  arm: new Color('#c4d6ff'),
  hii: new Color('#ff8fb8'),
};

class Cloud {
  readonly mat: ShaderMaterial;
  readonly points: Points;

  constructor(
    parent: Group,
    pos: number[],
    col: number[],
    size: number[],
    pxMin: number,
    pxMax: number,
    gain: number,
    shrink = new Vector2(1e6, 2e6),
  ) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aSize', new BufferAttribute(new Float32Array(size), 1));
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        scale: { value: 1 },
        opacity: { value: 0 },
        pxMin: { value: pxMin },
        pxMax: { value: pxMax },
        gain: { value: gain },
        shrink: { value: shrink },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }
}

/**
 * The Milky Way as a model: a bar and bulge, an exponential disk, and the spiral arms above, built from
 * points. Its scale, the Sun's place in it and its tilt on our sky are measured; its look is not.
 */
export class Galaxy {
  private readonly stars: Cloud;
  private readonly haze: Cloud;

  /** `dwarfs` are satellite galaxies, drawn as loose clouds of points around their real positions. */
  constructor(parent: Group, dwarfs: { pos: Vec; radius: number }[] = []) {
    const rand = rng(2019);
    const gauss = () => {
      const u = Math.max(rand(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const star = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const haze = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const ly = AU_PER_LY;
    const push = (to: typeof star, p: Vec, c: Color, size: number, k = 1) => {
      to.pos.push(...p);
      to.col.push(c.r * k, c.g * k, c.b * k);
      to.size.push(size);
    };

    // bar, about 4.5 kpc half length, its near end 27° toward l > 0
    const barAngle = (27 * Math.PI) / 180;
    for (let i = 0; i < 40000; i++) {
      const a = gauss() * 1.6;
      const b = gauss() * 0.6;
      const z = gauss() * 0.35;
      // in a frame where x points from the centre toward the Sun
      const x = a * Math.cos(barAngle) - b * Math.sin(barAngle);
      const y = a * Math.sin(barAngle) + b * Math.cos(barAngle);
      const p = galactic(Math.hypot(x, y), Math.atan2(y, x), z);
      push(star, p, COLORS.bulge, 60 * ly, 0.2);
      if (i % 4 === 0) {
        push(haze, p, COLORS.bulge, 900 * ly, 0.025);
      }
    }

    // the disk, an exponential with a 2.6 kpc scale length, cut off near 15 kpc
    for (let i = 0; i < 70000; i++) {
      const r = Math.min(15, -2.6 * Math.log(Math.max(rand(), 1e-6)) + 1.2);
      const beta = rand() * Math.PI * 2;
      const z = gauss() * 0.3;
      const p = galactic(r, beta, z);
      push(star, p, COLORS.disk, 50 * ly, 0.4);
      if (i % 5 === 0) {
        push(haze, p, COLORS.disk, 1200 * ly, 0.035);
      }
    }

    // the arms: young blue stars and, here and there, pink glowing gas
    for (const arm of ARMS) {
      const n = Math.round(70000 * arm.weight);
      for (let i = 0; i < n; i++) {
        const r = 3.5 + rand() * 11.5;
        let beta = armBeta(arm, r);
        if ('span' in arm) {
          const s = arm.span;
          const deg = (beta * 180) / Math.PI;
          if (deg < s[0] || deg > s[1]) {
            continue;
          }
        }
        // spread across the arm about 0.35 kpc, more at large radii
        const w = 0.25 + r * 0.02;
        const dr = gauss() * w;
        beta += (gauss() * w) / r;
        const z = gauss() * 0.12;
        const p = galactic(r + dr, beta, z);
        const hii = rand() < 0.04;
        push(star, p, hii ? COLORS.hii : COLORS.arm, (hii ? 90 : 45) * ly, hii ? 1 : 0.85);
        if (i % 6 === 0) {
          push(haze, p, COLORS.arm, 1000 * ly, 0.06);
        }
      }
    }

    for (const d of dwarfs) {
      const n = Math.round(4000 * (d.radius / (7000 * ly)));
      for (let i = 0; i < n; i++) {
        const s = d.radius * 0.45;
        const p: Vec = [d.pos[0] + gauss() * s, d.pos[1] + gauss() * s, d.pos[2] + gauss() * s * 0.6];
        push(star, p, COLORS.arm, 60 * ly, 0.5);
        if (i % 3 === 0) {
          push(haze, p, COLORS.disk, 1500 * ly, 0.12);
        }
      }
    }

    this.stars = new Cloud(parent, star.pos, star.col, star.size, 1.5, 4, 0.45);
    this.haze = new Cloud(parent, haze.pos, haze.col, haze.size, 1.5, 120, 0.6, new Vector2(6, 24));
  }

  /** Shows the model once the camera is far enough out that the Galaxy, not the nearby stars, fills the view. */
  update(height: number, fovDeg: number, sunDist: number) {
    const scale = height / (2 * Math.tan(MathUtils.degToRad(fovDeg / 2)));
    const k = Galaxy.presence(sunDist);
    // the glow only reads as a glow from well outside; from inside it breaks into blobs
    const h = k * MathUtils.smoothstep(Math.log10(sunDist / AU_PER_LY), 3.9, 4.6);
    for (const [c, o] of [
      [this.stars, k],
      [this.haze, h],
    ] as const) {
      c.mat.uniforms.scale.value = scale;
      c.mat.uniforms.opacity.value = o;
      c.points.visible = o > 0.01;
    }
  }

  /** 0..1, by the camera's distance from the Sun in AU: from about 2,000 to 15,000 light years. */
  static presence(sunDist: number) {
    return MathUtils.smoothstep(Math.log10(sunDist / AU_PER_LY), 3.3, 4.2);
  }
}
