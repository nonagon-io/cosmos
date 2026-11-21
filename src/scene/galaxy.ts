import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MathUtils,
  Matrix4,
  Points,
  ShaderMaterial,
  type Sprite,
  type SpriteMaterial,
  Vector2,
  Vector3,
} from 'three';
import type { Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { rng } from './particles';
import { AU_PER_LY } from './stars';

// Measured: the Sun's distance from the centre (GRAVITY 2019) and its height above the plane (Bennett & Bovy 2019)
const R0 = 8.178;
const Z_SUN = 0.0208;
const LY_PER_KPC = 3261.56;

// How the Galaxy turns, in radians per million years (1 km/s is 1.0227 pc per million years). The Sun goes
// round at the circular speed, about 233 km/s (Eilers 2019), so once in some 220 million years. The spiral
// pattern is a wave the stars pass through and turns slower; its speed is still argued over, from about 17 to
// 28 km/s/kpc, and 20 is taken here, which puts the Sun near corotation.
const KMS = 1.0227;
// the rotation curve: rising through the bulge, then near flat, so the inner disk goes round in far less time
const circular = (r: number) => 233 * Math.min(1, r / 2.5) ** 0.5;
/** How fast stars at radius `r` kpc go round, in radians per million years. */
const omega = (r: number) => (circular(r) * KMS) / (Math.max(r, 0.3) * 1000);
const SUN_OMEGA = (233 * KMS) / (R0 * 1000);
const ARM_OMEGA = (20 * KMS) / 1000;
// The Sun also bobs through the plane, now rising at 7.25 km/s (Schönrich 2010), about once every 70 million years
const BOB = (2 * Math.PI) / 70;
const W_SUN = 7.25 * KMS;

// on-screen width the satellite galaxies, and from far enough out the Galaxy itself, are held at, unless true
// size is on
const DWARF_MIN_PX = 12;
const GALAXY_MIN_PX = 16;

/**
 * How much of a minimum on-screen size to keep, with the camera `sunDist` AU from the Sun, for a galaxy
 * held up between `from` and `to` light years out: past that it is one among many and drawn true to size.
 */
export function minSizeAt(sunDist: number, from: number, to: number) {
  return 1 - MathUtils.smoothstep(Math.log10(sunDist / AU_PER_LY), Math.log10(from), Math.log10(to));
}
const GALAXY_RADIUS = 50000 * AU_PER_LY;

interface Dwarf {
  pos: Vec;
  radius: number;
  glow: Sprite | null;
}

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
attribute vec3 aSpin;
uniform float scale;
uniform float myr;
uniform vec3 centre;
uniform vec3 axis;
uniform float grow;
uniform float pxMin;
uniform float pxMax;
uniform float gain;
uniform vec2 shrink;
varying vec3 vColor;
varying float vFade;
void main() {
  // aSpin: how fast the star turns round the centre ahead of the model, which turns with the spiral pattern
  // (rad per million years), how long it lives (0 for ever) and where in its life it starts. A young star
  // born in an arm drifts off it as it goes round and dies within a few tens of millions of years
  float age = aSpin.y > 0.0 ? mod(myr + aSpin.z * aSpin.y, aSpin.y) : myr;
  float th = -aSpin.x * age;
  vec3 v = position - centre;
  vec3 p = centre + v * cos(th) + cross(axis, v) * sin(th) + axis * dot(axis, v) * (1.0 - cos(th));
  float life = 1.0;
  if (aSpin.y > 0.0) {
    float u = age / aSpin.y;
    life = 2.2 * smoothstep(0.0, 0.08, u) * (1.0 - u);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // aSize is a size in AU; on screen it shrinks with distance like anything real
  float px = aSize * grow * scale / max(-mv.z, 1.0);
  gl_PointSize = clamp(px, pxMin, pxMax);
  // a point held up at the minimum size spreads the same light over more pixels
  float f = min(px / pxMin, 1.0);
  vFade = f * f * gain * life;
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

export const COLORS = {
  bulge: new Color('#ffd7a3'),
  disk: new Color('#efe3cf'),
  arm: new Color('#c4d6ff'),
  hii: new Color('#ff8fb8'),
};

export class Cloud {
  readonly mat: ShaderMaterial;
  readonly points: Points;
  private readonly count: number;

  constructor(
    parent: Group,
    pos: number[],
    col: number[],
    size: number[],
    pxMin: number,
    pxMax: number,
    gain: number,
    shrink = new Vector2(1e6, 2e6),
    spin?: number[],
  ) {
    // shuffled, so any leading share of the points is a fair sample of the whole (see show)
    const n = size.length;
    const order = Array.from({ length: n }, (_, i) => i);
    const rand = rng(n);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const p = new Float32Array(n * 3);
    const c = new Float32Array(n * 3);
    const s = new Float32Array(n);
    const w = new Float32Array(n * 3);
    for (const [k, i] of order.entries()) {
      if (spin) {
        w.set(spin.slice(i * 3, i * 3 + 3), k * 3);
      }
      p.set(pos.slice(i * 3, i * 3 + 3), k * 3);
      c.set(col.slice(i * 3, i * 3 + 3), k * 3);
      s[k] = size[i];
    }
    this.count = n;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(p, 3));
    g.setAttribute('aColor', new BufferAttribute(c, 3));
    g.setAttribute('aSize', new BufferAttribute(s, 1));
    g.setAttribute('aSpin', new BufferAttribute(w, 3));
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        scale: { value: 1 },
        grow: { value: 1 },
        opacity: { value: 0 },
        pxMin: { value: pxMin },
        pxMax: { value: pxMax },
        gain: { value: gain },
        shrink: { value: shrink },
        myr: { value: 0 },
        centre: { value: new Vector3() },
        axis: { value: new Vector3(0, 0, 1) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  /**
   * Sets the opacity for a galaxy `px` pixels across, drawing only as many points as that needs, each brighter so
   * the total light holds. A few hundred thousand piled onto a few dozen pixels would stall the GPU on blending.
   */
  show(opacity: number, px = Number.POSITIVE_INFINITY) {
    const k = Math.max(1, Math.min(this.count, Math.ceil(POINTS_PER_PX2 * px * px)));
    this.points.geometry.setDrawRange(0, k);
    this.mat.uniforms.opacity.value = (opacity * this.count) / k;
    this.points.visible = opacity > 0.01;
  }
}

// points drawn per square pixel of a galaxy's width, at most
const POINTS_PER_PX2 = 20;

/**
 * Extra brightness for a spiral galaxy `px` pixels across. Shrunk to a few dozen pixels, the faint disk between
 * the arms would leave only a dim smudge, so it is brightened as a long exposure would.
 */
export const exposureFor = (px: number) => MathUtils.clamp(250 / px, 1, 6);

/**
 * The Milky Way as a model: a bar and bulge, an exponential disk, and the spiral arms above, built from
 * points. Its scale, the Sun's place in it and its tilt on our sky are measured; its look is not.
 */
export class Galaxy {
  private readonly stars: Cloud;
  private readonly haze: Cloud;
  private readonly normal: Vec;
  private readonly centre: Vec;
  /** Holds the model, turned and shifted for the time on the Galaxy's timeline. */
  private readonly frame = new Group();
  private shift: Vec = [0, 0, 0];
  private myr = 0;
  /** How much the Galaxy is drawn bigger than it is, to stay visible from far off. */
  grow = 1;
  private readonly dwarfs: (Dwarf & { group: Group; stars: Cloud; haze: Cloud; glowSize: number })[] = [];

  /** `dwarfs` are satellite galaxies, drawn as loose clouds of points around their real positions. */
  constructor(parent: Group, dwarfs: Dwarf[] = []) {
    const rand = rng(2019);
    const gauss = () => {
      const u = Math.max(rand(), 1e-9);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    };
    const star = { pos: [] as number[], col: [] as number[], size: [] as number[], spin: [] as number[] };
    const haze = { pos: [] as number[], col: [] as number[], size: [] as number[], spin: [] as number[] };
    const ly = AU_PER_LY;
    // the bar and the arms' gas go round with their patterns, which the frame turns; stars at their own speed
    const push = (to: typeof star, p: Vec, c: Color, size: number, k = 1, r = -1, life = 0) => {
      to.pos.push(...p);
      to.col.push(c.r * k, c.g * k, c.b * k);
      to.size.push(size);
      to.spin.push(r < 0 ? 0 : omega(r) - ARM_OMEGA, life, rand());
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
      push(star, p, COLORS.disk, 50 * ly, 0.4, r);
      if (i % 5 === 0) {
        push(haze, p, COLORS.disk, 1200 * ly, 0.035, r);
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
        // blue stars live a few tens of millions of years, glowing gas around new ones about ten
        push(
          star,
          p,
          hii ? COLORS.hii : COLORS.arm,
          (hii ? 90 : 45) * ly,
          hii ? 1 : 0.85,
          r + dr,
          hii ? 10 : 40,
        );
        if (i % 6 === 0) {
          push(haze, p, COLORS.arm, 1000 * ly, 0.06);
        }
      }
    }

    // each satellite in its own group around its centre, so it can be scaled up to stay visible
    for (const d of dwarfs) {
      const ds = { pos: [] as number[], col: [] as number[], size: [] as number[], spin: [] as number[] };
      const dh = { pos: [] as number[], col: [] as number[], size: [] as number[], spin: [] as number[] };
      const n = Math.round(4000 * (d.radius / (7000 * ly)));
      for (let i = 0; i < n; i++) {
        const s = d.radius * 0.45;
        const p: Vec = [gauss() * s, gauss() * s, gauss() * s * 0.6];
        push(ds, p, COLORS.arm, 60 * ly, 0.5);
        if (i % 3 === 0) {
          push(dh, p, COLORS.disk, 1500 * ly, 0.12);
        }
      }
      const group = new Group();
      group.position.set(...d.pos);
      parent.add(group);
      this.dwarfs.push({
        ...d,
        group,
        stars: new Cloud(group, ds.pos, ds.col, ds.size, 1.5, 4, 0.45),
        haze: new Cloud(group, dh.pos, dh.col, dh.size, 1.5, 120, 0.6, new Vector2(6, 24)),
        glowSize: d.glow?.scale.x ?? 0,
      });
    }

    this.frame.matrixAutoUpdate = false;
    parent.add(this.frame);
    const n = toEcliptic(0, 0, 1);
    const nl = Math.hypot(...n);
    this.normal = [n[0] / nl, n[1] / nl, n[2] / nl];
    this.centre = galactic(0, 0, 0);

    this.stars = new Cloud(this.frame, star.pos, star.col, star.size, 1.5, 4, 0.45, undefined, star.spin);
    this.haze = new Cloud(
      this.frame,
      haze.pos,
      haze.col,
      haze.size,
      1.5,
      120,
      0.6,
      new Vector2(6, 24),
      haze.spin,
    );
    for (const c of [this.stars, this.haze]) {
      c.mat.uniforms.centre.value.set(...this.centre);
      c.mat.uniforms.axis.value.set(...this.normal);
    }
  }

  /**
   * Where the Sun has moved to, `myr` million years from now, relative to where it is now, in ecliptic AU. The
   * scene stays centred on the Sun, so everything fixed to the Galaxy moves the other way.
   */
  static sunShift(myr: number): Vec {
    const th = SUN_OMEGA * myr;
    const z = (Z_SUN * 1000 * Math.cos(BOB * myr) + (W_SUN / BOB) * Math.sin(BOB * myr)) / 1000;
    return toEcliptic(R0 - R0 * Math.cos(th), R0 * Math.sin(th), z - Z_SUN);
  }

  /** Moves the Galaxy past the Sun to `myr` million years from now; `update` then turns its spiral pattern. */
  setTime(myr: number) {
    this.myr = myr;
    this.shift = Galaxy.sunShift(myr);
    this.stars.mat.uniforms.myr.value = myr;
    this.haze.mat.uniforms.myr.value = myr;
  }

  private placeFrame() {
    const s = this.shift;
    const c = this.centre;
    // seen from the north galactic pole the Galaxy turns clockwise
    const m = new Matrix4()
      .makeTranslation(c[0] - s[0], c[1] - s[1], c[2] - s[2])
      .multiply(new Matrix4().makeRotationAxis(new Vector3(...this.normal), -ARM_OMEGA * this.myr))
      .multiply(new Matrix4().makeScale(this.grow, this.grow, this.grow))
      .multiply(new Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
    this.frame.matrix.copy(m);
    this.frame.matrixWorldNeedsUpdate = true;
  }

  /** A point of the model, given as at the present, where it is now drawn. */
  place(p: Vec): Vec {
    const v = new Vector3(...p).applyMatrix4(this.frame.matrix);
    return [v.x, v.y, v.z];
  }

  /** Shows the model once the camera is far enough out that the Galaxy, not the nearby stars, fills the view. */
  update(height: number, fovDeg: number, cam: Vec, trueSize: boolean, zoom: number) {
    const sunDist = Math.hypot(...cam);
    const scale = height / (2 * Math.tan(MathUtils.degToRad(fovDeg / 2)));
    // zoomed in close on something out there, a nebula a few light years across, its stand-in stars would be
    // big blobs drifting through the view; they are there for the shape of the Galaxy, not for close-ups
    const k = Galaxy.presence(sunDist) * MathUtils.smoothstep(Math.log10(zoom / AU_PER_LY), 1, 2);
    const lg = Math.log10(sunDist / AU_PER_LY);
    // the glow only reads as a glow from well outside; from inside it breaks into blobs
    const h = k * MathUtils.smoothstep(lg, 3.9, 4.6);
    const c = this.centre;
    const s = this.shift;
    const d = [cam[0] - c[0] + s[0], cam[1] - c[1] + s[1], cam[2] - c[2] + s[2]];
    const px = (2 * GALAXY_RADIUS * scale) / Math.max(Math.hypot(...d), 1);
    // among the galaxies of the Local Volume, it shrinks to their size
    const minPx = Math.max(3, GALAXY_MIN_PX * minSizeAt(sunDist, 2e7, 1.5e8));
    this.grow = trueSize ? 1 : Math.max(1, minPx / px);
    this.placeFrame();
    for (const [c, o] of [
      [this.stars, k],
      [this.haze, h],
    ] as const) {
      c.mat.uniforms.scale.value = scale;
      c.mat.uniforms.grow.value = this.grow;
      c.show(o * exposureFor(px * this.grow), px * this.grow);
    }

    for (const d of this.dwarfs) {
      const dist = Math.hypot(cam[0] - d.pos[0], cam[1] - d.pos[1], cam[2] - d.pos[2]);
      const px = (2 * d.radius * scale) / Math.max(dist, 1);
      // the Clouds are held up to be found around the Galaxy, not once out among other galaxies
      const grow = trueSize ? 1 : Math.max(1, (DWARF_MIN_PX * minSizeAt(sunDist, 3e5, 2e6)) / px);
      // at true size, a galaxy only a pixel or two across is not worth drawing
      // and zoomed in on something small, like Sgr A*, galaxies 160,000 light years off are out of the picture
      const seen = k * Galaxy.presence(zoom) * (trueSize ? MathUtils.smoothstep(px, 1.5, 6) : 1);
      d.group.scale.setScalar(grow);
      for (const [c, o] of [
        [d.stars, seen],
        [d.haze, seen * MathUtils.smoothstep(lg, 3.9, 4.6)],
      ] as const) {
        c.mat.uniforms.scale.value = scale;
        c.mat.uniforms.grow.value = grow;
        c.show(o, px * grow);
      }
      if (d.glow) {
        d.glow.scale.setScalar(d.glowSize * grow);
        (d.glow.material as SpriteMaterial).opacity *= seen;
      }
    }
  }

  /** 0..1, by the camera's distance from the Sun in AU: from about 2,000 to 15,000 light years. */
  static presence(sunDist: number) {
    return MathUtils.smoothstep(Math.log10(sunDist / AU_PER_LY), 3.3, 4.2);
  }
}
