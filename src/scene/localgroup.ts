import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MathUtils,
  Points,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { Vec } from '../astro/kepler';
import { Cloud, COLORS, exposureFor, Galaxy } from './galaxy';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { rng } from './particles';
import { AU_PER_LY, eclipticDir } from './stars';

/**
 * A row of localgroup.json: name, RA, Dec (deg), distance (kpc), half-light radius (pc), M_V, the big galaxy it
 * belongs to (MW, M31 or neither) and its morphological type.
 */
export type LocalGroupRow = [string, number, number, number, number, number, string, string];

const AU_PER_KPC = 3261.56 * AU_PER_LY;
const AU_PER_PC = AU_PER_KPC / 1000;
// the same as the Milky Way's, so the big three keep their real sizes against each other for longer
const SPIRAL_MIN_PX = 16;
const DWARF_MIN_PX = 4;
// dwarfs bright enough to get a name on screen
const LABEL_MAG = -13;

// Andromeda falls toward the Milky Way's centre at 109 km/s (van der Marel et al. 2012), taking Triangulum and its
// other satellites along. Its sideways motion is small and still uncertain (Salomon et al. 2021), so it is left
// out. 1 km/s is 1.0227 pc per million years.
const M31_SPEED = 109 * 1.0227 * AU_PER_PC;

/**
 * The two other spirals, built from points like the Milky Way model. Position angle and inclination are
 * measured, so each is tilted on our sky as photographed; the arms and ring are a sketch of what is seen.
 */
const SPIRALS: Record<
  string,
  {
    pa: number;
    incl: number;
    scale: number;
    radius: number;
    bulge: number;
    bulgeShare: number;
    pitch: number;
    ring: number;
    n: number;
  }
> = {
  // PA 38°, i 77° (Walterbos & Kennicutt 1987), the star-forming ring at 10 kpc
  andromeda: {
    pa: 38,
    incl: 77,
    scale: 5.3,
    radius: 25,
    bulge: 1.2,
    bulgeShare: 0.25,
    pitch: 8,
    ring: 10,
    n: 60000,
  },
  // PA 23°, i 55° (McConnachie 2012; Kam et al. 2015), loose arms and almost no bulge
  triangulum: {
    pa: 23,
    incl: 55,
    scale: 1.8,
    radius: 9,
    bulge: 0.3,
    bulgeShare: 0.04,
    pitch: 22,
    ring: 0,
    n: 25000,
  },
};

/** Galaxies in Andromeda's group, which moves with it on the Galaxy's timeline. */
export const M31_SYSTEM = new Set(['andromeda', 'triangulum']);

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;
const toEcl = (x: number, y: number, z: number): Vec => [
  x,
  y * Math.cos(OBLIQUITY) + z * Math.sin(OBLIQUITY),
  -y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY),
];

/** Line of sight, north and east on the sky at RA/Dec, as ecliptic unit vectors. */
function skyAxes(ra: number, dec: number) {
  const a = ra * MathUtils.DEG2RAD;
  const d = dec * MathUtils.DEG2RAD;
  return {
    los: eclipticDir(ra, dec) as Vec,
    north: toEcl(-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)),
    east: toEcl(-Math.sin(a), Math.cos(a), 0),
  };
}

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aColor;
attribute float aSize;
uniform float scale;
uniform float minPx;
varying vec3 vColor;
varying float vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = aSize * scale / max(-mv.z, 1.0);
  gl_PointSize = min(max(px, minPx), 256.0);
  // at true size a blob under a pixel or two spreads its light thinner instead; a big one is spread thin too,
  // as dwarf galaxies are faint for their size
  float f = minPx > 0.0 ? 1.0 : min(px / 1.5, 1.0);
  vFade = f * f * min(1.0, 64.0 / (px * px));
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
  gl_FragColor = vec4(vColor, exp(-d * d * 3.5) * vFade * opacity);
  #include <colorspace_fragment>
}
`;

interface Spiral {
  id: string;
  pos: Vec;
  radius: number;
  group: Group;
  stars: Cloud;
  haze: Cloud;
}

/**
 * The Local Group beyond the Magellanic Clouds: Andromeda and Triangulum as point models, and the dwarf galaxies
 * of the Local Volume Database (Pace et al. 2024) as soft blobs their measured size, at their measured distances.
 */
export class LocalGroup {
  private readonly spirals: Spiral[] = [];
  private readonly dwarfMat: ShaderMaterial;
  // Andromeda's satellites ride in their own group so they move with it
  private readonly near = new Group();
  private readonly m31 = new Group();
  private readonly m31Base: Vec;
  private readonly toCentre: Vec;
  /** Named dwarfs: where each is in its group, and which group. */
  readonly named: { name: string; mag: number; at: Vec; m31: boolean }[] = [];

  /** `spirals` are the deep-sky entries for Andromeda and Triangulum, whose `pos` the World keeps moving. */
  constructor(
    parent: Group,
    rows: LocalGroupRow[],
    spirals: { id: string; pos: Vec; radius: number; ra: number; dec: number }[],
    mwCentre: Vec,
  ) {
    const m31 = spirals.find((s) => s.id === 'andromeda');
    this.m31Base = m31 ? [...m31.pos] : [0, 0, 0];
    const d = [0, 1, 2].map((i) => mwCentre[i] - this.m31Base[i]);
    const dl = Math.hypot(...d) || 1;
    this.toCentre = d.map((x) => x / dl) as Vec;

    for (const s of spirals) {
      const spec = SPIRALS[s.id];
      if (spec) {
        this.spirals.push(this.buildSpiral(parent, s, spec));
      }
    }

    const sets = {
      near: { pos: [] as number[], col: [] as number[], size: [] as number[] },
      m31: { pos: [] as number[], col: [] as number[], size: [] as number[] },
    };
    const col = new Color();
    for (const [name, ra, dec, kpc, pc, mag, sub, type] of rows) {
      const dir = eclipticDir(ra, dec);
      const inM31 = sub === 'M31';
      const p: Vec = [0, 1, 2].map((i) => dir[i] * kpc * AU_PER_KPC - (inM31 ? this.m31Base[i] : 0)) as Vec;
      // brighter galaxies glow brighter; star-forming irregulars are bluer than the old spheroidals
      const k = MathUtils.clamp(0.2 + (-mag - 6) * 0.08, 0.15, 1);
      col.set(/Irr/.test(type) ? '#d9e2ff' : '#ffe6c7').multiplyScalar(k);
      const set = inM31 ? sets.m31 : sets.near;
      set.pos.push(...p);
      set.col.push(col.r, col.g, col.b);
      set.size.push(pc * 2 * AU_PER_PC);
      if (mag <= LABEL_MAG) {
        this.named.push({ name, mag, at: p, m31: inM31 });
      }
    }
    this.dwarfMat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { scale: { value: 1 }, minPx: { value: DWARF_MIN_PX }, opacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    for (const [g, set] of [
      [this.near, sets.near],
      [this.m31, sets.m31],
    ] as const) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(set.pos), 3));
      geo.setAttribute('aColor', new BufferAttribute(new Float32Array(set.col), 3));
      geo.setAttribute('aSize', new BufferAttribute(new Float32Array(set.size), 1));
      const pts = new Points(geo, this.dwarfMat);
      pts.frustumCulled = false;
      g.add(pts);
      parent.add(g);
    }
  }

  private buildSpiral(
    parent: Group,
    s: { id: string; pos: Vec; radius: number; ra: number; dec: number },
    spec: (typeof SPIRALS)[string],
  ): Spiral {
    const { los, north, east } = skyAxes(s.ra, s.dec);
    const pa = spec.pa * MathUtils.DEG2RAD;
    const inc = spec.incl * MathUtils.DEG2RAD;
    const major = [0, 1, 2].map((i) => Math.cos(pa) * north[i] + Math.sin(pa) * east[i]);
    const minor = [0, 1, 2].map((i) => -Math.sin(pa) * north[i] + Math.cos(pa) * east[i]);
    // tilted so the north-west side is the near one, as Andromeda's dust lanes show
    const normal = [0, 1, 2].map((i) => -Math.cos(inc) * los[i] + Math.sin(inc) * minor[i]);
    const side = [
      normal[1] * major[2] - normal[2] * major[1],
      normal[2] * major[0] - normal[0] * major[2],
      normal[0] * major[1] - normal[1] * major[0],
    ];
    const at = (r: number, phi: number, z: number) =>
      [0, 1, 2].map(
        (i) => (r * Math.cos(phi) * major[i] + r * Math.sin(phi) * side[i] + z * normal[i]) * AU_PER_KPC,
      );

    const rand = rng(s.id.length * 7919);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9))) * Math.cos(2 * Math.PI * rand());
    const star = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const haze = { pos: [] as number[], col: [] as number[], size: [] as number[] };
    const ly = AU_PER_LY;
    const push = (to: typeof star, p: number[], c: Color, size: number, k: number) => {
      to.pos.push(...p);
      to.col.push(c.r * k, c.g * k, c.b * k);
      to.size.push(size);
    };
    const n = spec.n;
    for (let i = 0; i < n * spec.bulgeShare; i++) {
      const p = [gauss() * spec.bulge, gauss() * spec.bulge, gauss() * spec.bulge * 0.7];
      const q = at(Math.hypot(p[0], p[1]), Math.atan2(p[1], p[0]), p[2]);
      push(star, q, COLORS.bulge, 60 * ly, 0.25);
      if (i % 4 === 0) {
        push(haze, q, COLORS.bulge, 900 * ly, 0.03);
      }
    }
    for (let i = 0; i < n * 0.4; i++) {
      const r = Math.min(spec.radius, -spec.scale * Math.log(Math.max(rand(), 1e-6)) + 0.3);
      const q = at(r, rand() * Math.PI * 2, gauss() * 0.25);
      push(star, q, COLORS.disk, 50 * ly, 0.4);
      if (i % 5 === 0) {
        push(haze, q, COLORS.disk, 1200 * ly, 0.035);
      }
    }
    // two trailing arms: the galaxy turns toward growing phi, so the arms fall behind further out
    const tanP = Math.tan(spec.pitch * MathUtils.DEG2RAD);
    const r0 = spec.scale * 0.6;
    for (let i = 0; i < n * (spec.ring ? 0.2 : 0.35); i++) {
      const r = r0 + rand() * (spec.radius * 0.8 - r0);
      const phi = (i % 2) * Math.PI - Math.log(r / r0) / tanP + gauss() * 0.12;
      const hii = rand() < 0.05;
      push(
        star,
        at(r, phi, gauss() * 0.12),
        hii ? COLORS.hii : COLORS.arm,
        (hii ? 90 : 45) * ly,
        hii ? 1 : 0.85,
      );
      if (i % 6 === 0) {
        push(haze, at(r, phi, 0), COLORS.arm, 1000 * ly, 0.06);
      }
    }
    if (spec.ring) {
      for (let i = 0; i < n * 0.15; i++) {
        const r = spec.ring + gauss() * 0.7;
        const hii = rand() < 0.08;
        const q = at(r, rand() * Math.PI * 2, gauss() * 0.1);
        push(star, q, hii ? COLORS.hii : COLORS.arm, (hii ? 90 : 45) * ly, hii ? 1 : 0.85);
        if (i % 6 === 0) {
          push(haze, q, COLORS.arm, 1000 * ly, 0.06);
        }
      }
    }
    const group = new Group();
    parent.add(group);
    return {
      id: s.id,
      pos: s.pos,
      radius: s.radius,
      group,
      stars: new Cloud(group, star.pos, star.col, star.size, 1.5, 4, 0.45),
      haze: new Cloud(group, haze.pos, haze.col, haze.size, 1.5, 120, 0.6, new Vector2(6, 24)),
    };
  }

  /** How far Andromeda and its group have moved, `myr` million years from now, in ecliptic AU. */
  driftAt(myr: number): Vec {
    return this.toCentre.map((x) => x * M31_SPEED * myr) as Vec;
  }

  /** `shift` is the Sun's move on the Galaxy's timeline (Galaxy.sunShift), `drift` Andromeda's (driftAt). */
  setTime(shift: Vec, drift: Vec) {
    this.near.position.set(-shift[0], -shift[1], -shift[2]);
    this.m31.position.set(...([0, 1, 2].map((i) => this.m31Base[i] - shift[i] + drift[i]) as Vec));
  }

  /** Where a named dwarf is drawn. */
  placeOf(d: { at: Vec; m31: boolean }): Vec {
    const g = d.m31 ? this.m31.position : this.near.position;
    return [g.x + d.at[0], g.y + d.at[1], g.z + d.at[2]];
  }

  update(height: number, fovDeg: number, cam: Vec, trueSize: boolean, zoom: number) {
    const scale = height / (2 * Math.tan(MathUtils.degToRad(fovDeg / 2)));
    // like the Magellanic Clouds, out of the picture while zoomed in on something small
    const seen = Galaxy.presence(zoom) * Galaxy.presence(Math.hypot(...cam));
    for (const s of this.spirals) {
      s.group.position.set(...s.pos);
      const dist = Math.hypot(cam[0] - s.pos[0], cam[1] - s.pos[1], cam[2] - s.pos[2]);
      const px = (2 * s.radius * scale) / Math.max(dist, 1);
      const grow = trueSize ? 1 : Math.max(1, SPIRAL_MIN_PX / px);
      const o = seen * (trueSize ? MathUtils.smoothstep(px, 1.5, 6) : 1);
      s.group.scale.setScalar(grow);
      for (const [c, k] of [
        [s.stars, o],
        [s.haze, o * MathUtils.smoothstep(Math.log10(dist / AU_PER_LY), 3.9, 4.6)],
      ] as const) {
        c.mat.uniforms.scale.value = scale;
        c.mat.uniforms.grow.value = grow;
        c.show(k * exposureFor(px * grow), px * grow);
      }
    }
    this.dwarfMat.uniforms.scale.value = scale;
    this.dwarfMat.uniforms.minPx.value = trueSize ? 0 : DWARF_MIN_PX;
    this.dwarfMat.uniforms.opacity.value = seen;
    this.near.visible = seen > 0.01;
    this.m31.visible = seen > 0.01;
  }
}
