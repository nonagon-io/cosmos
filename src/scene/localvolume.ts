import {
  AdditiveBlending,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MathUtils,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import type { Vec } from '../astro/kepler';
import { Galaxy } from './galaxy';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { AU_PER_LY, eclipticDir } from './stars';

/**
 * A row of localvolume.json: name, RA, Dec (deg), distance (Mpc), Holmberg diameter (kpc), axis ratio,
 * inclination (deg), morphological type T, absolute B magnitude, position angle (deg, or null).
 */
export type LocalVolumeRow = [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number | null,
];

const AU_PER_KPC = 3261.56 * AU_PER_LY;
// smallest on-screen radius a galaxy is drawn at unless true size is on; brighter ones are held bigger
const MIN_PX = 2;
// galaxies this bright, and the Messier ones, get a name on screen once the camera is out among them
const LABEL_MAG = -20;
const LABELS_FROM = 3e6 * AU_PER_LY;

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;
const toEcl = (x: number, y: number, z: number): Vec => [
  x,
  y * Math.cos(OBLIQUITY) + z * Math.sin(OBLIQUITY),
  -y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY),
];

// a stable number in 0..1 from a name, for what the catalogues leave open
const hash = (s: string) => {
  let h = 2166136261;
  for (const c of s) {
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  }
  return (h >>> 0) / 4294967296;
};

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 iCenter;
attribute vec3 iMajor;
attribute vec3 iSide;
attribute vec4 iLook; // radius (AU), kind, brightness, min size factor
attribute vec2 iShape; // axis ratio for ellipticals, seed
uniform float scale;
uniform float minPx;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vLight;
void main() {
  vec4 c = modelViewMatrix * vec4(iCenter, 1.0);
  float px = iLook.x * scale / max(-c.z, 1.0);
  float grow = minPx > 0.0 ? max(1.0, minPx * iLook.w / px) : 1.0;
  // at true size a galaxy under a pixel or so fades rather than holding a pixel's worth of light
  float f = minPx > 0.0 ? 1.0 : min(px / 1.5, 1.0);
  vLight = iLook.z * f * f;
  vUv = position.xy;
  vKind = iLook.y;
  vSeed = iShape.y;
  float r = iLook.x * grow;
  if (iLook.y < 0.5) {
    // ellipticals have no disk to tilt: they face the camera, flattened by their measured axis ratio
    float a = iShape.y * 6.2832;
    vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * vec2(position.x, position.y * iShape.x);
    gl_Position = projectionMatrix * (c + vec4(q * r, 0.0, 0.0));
  } else {
    vec3 w = iCenter + (position.x * iMajor + position.y * iSide) * r;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 1.0);
  }
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float opacity;
varying vec2 vUv;
varying float vKind;
varying float vSeed;
varying float vLight;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  ${LOGDEPTH_FRAG}
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 col;
  if (vKind < 0.5) {
    // elliptical: a smooth warm glow, bright to the centre
    col = vec3(1.0, 0.86, 0.68) * (exp(-r * 6.0) * 1.4 + exp(-r * r * 80.0));
  } else if (vKind < 1.5) {
    // spiral: two trailing arms on an exponential disk, around a yellow bulge
    float th = atan(vUv.y, vUv.x);
    float arm = cos(2.0 * (th + log(max(r, 0.04)) / 0.4) + vSeed * 6.2832);
    arm = smoothstep(0.1, 1.0, arm) * smoothstep(0.08, 0.3, r);
    col = vec3(0.72, 0.8, 1.0) * exp(-r * 4.0) * (0.35 + 1.4 * arm) + vec3(1.0, 0.85, 0.6) * exp(-r * r * 90.0) * 1.6;
  } else {
    // irregular: clumps of young blue stars
    float n = noise(vUv * 4.0 + vSeed * 40.0) * 0.6 + noise(vUv * 9.0 - vSeed * 17.0) * 0.4;
    col = vec3(0.7, 0.8, 1.0) * exp(-r * 3.0) * smoothstep(0.35, 0.9, n) * 1.6;
  }
  col *= smoothstep(1.0, 0.75, r);
  gl_FragColor = vec4(col, vLight * opacity);
  #include <colorspace_fragment>
}
`;

/**
 * Galaxies beyond the Local Group out to about 35 million light years, from the Updated Nearby Galaxy Catalog,
 * each a flat sketch of its type at its measured distance, size and inclination.
 */
export class LocalVolume {
  private readonly group = new Group();
  private readonly mat: ShaderMaterial;
  /** The brightest, for names on screen: where each is, before the Galaxy's timeline moves it. */
  readonly named: { name: string; at: Vec; mag: number }[] = [];

  /** `skip` are positions already labelled as regions. */
  constructor(parent: Group, rows: LocalVolumeRow[], skip: Vec[]) {
    const n = rows.length;
    const center = new Float32Array(n * 3);
    const major = new Float32Array(n * 3);
    const side = new Float32Array(n * 3);
    const look = new Float32Array(n * 4);
    const shape = new Float32Array(n * 2);
    for (const [k, [name, ra, dec, mpc, kpc, ba, incl, tt, mag, pa]] of rows.entries()) {
      const los = eclipticDir(ra, dec);
      const p: Vec = [
        los[0] * mpc * 1000 * AU_PER_KPC,
        los[1] * mpc * 1000 * AU_PER_KPC,
        los[2] * mpc * 1000 * AU_PER_KPC,
      ];
      center.set(p, k * 3);
      const a = ra * MathUtils.DEG2RAD;
      const d = dec * MathUtils.DEG2RAD;
      const north = toEcl(-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d));
      const east = toEcl(-Math.sin(a), Math.cos(a), 0);
      // without a measured position angle, any will do: the card says so
      const t = (pa ?? hash(name) * 180) * MathUtils.DEG2RAD;
      const i = incl * MathUtils.DEG2RAD;
      const m = [0, 1, 2].map((j) => Math.cos(t) * north[j] + Math.sin(t) * east[j]);
      const minor = [0, 1, 2].map((j) => -Math.sin(t) * north[j] + Math.cos(t) * east[j]);
      const nrm = [0, 1, 2].map((j) => -Math.cos(i) * los[j] + Math.sin(i) * minor[j]);
      major.set(m, k * 3);
      side.set(
        [nrm[1] * m[2] - nrm[2] * m[1], nrm[2] * m[0] - nrm[0] * m[2], nrm[0] * m[1] - nrm[1] * m[0]],
        k * 3,
      );
      const kind = tt <= 0 ? 0 : tt >= 9 ? 2 : 1;
      look.set(
        [
          (kpc / 2) * AU_PER_KPC,
          kind,
          MathUtils.clamp(0.25 + (-mag - 14) * 0.12, 0.15, 1.1),
          MathUtils.clamp((-mag - 13) / 2.5, 1, 3),
        ],
        k * 4,
      );
      shape.set([ba, hash(`${name}~`)], k * 2);
      const labelled = skip.some(
        (s) => Math.hypot(s[0] - p[0], s[1] - p[1], s[2] - p[2]) < 0.02 * Math.hypot(...p),
      );
      if ((mag <= LABEL_MAG || /^M\d/.test(name)) && !labelled) {
        this.named.push({ name, at: p, mag });
      }
    }
    const quad = new PlaneGeometry(2, 2);
    const geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iCenter', new InstancedBufferAttribute(center, 3));
    geo.setAttribute('iMajor', new InstancedBufferAttribute(major, 3));
    geo.setAttribute('iSide', new InstancedBufferAttribute(side, 3));
    geo.setAttribute('iLook', new InstancedBufferAttribute(look, 4));
    geo.setAttribute('iShape', new InstancedBufferAttribute(shape, 2));
    geo.instanceCount = n;
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { scale: { value: 1 }, minPx: { value: MIN_PX }, opacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    parent.add(this.group);
  }

  /** `shift` is the Sun's move on the Galaxy's timeline: these galaxies stay put while it goes round. */
  setTime(shift: Vec) {
    this.group.position.set(-shift[0], -shift[1], -shift[2]);
  }

  /** Where a named galaxy is drawn. */
  placeOf(at: Vec): Vec {
    const g = this.group.position;
    return [g.x + at[0], g.y + at[1], g.z + at[2]];
  }

  /** Whether names should show, with the camera `sunDist` AU from the Sun. */
  static labelled(sunDist: number) {
    return sunDist > LABELS_FROM;
  }

  update(height: number, fovDeg: number, cam: Vec, trueSize: boolean, zoom: number) {
    this.mat.uniforms.scale.value = height / (2 * Math.tan(MathUtils.degToRad(fovDeg / 2)));
    this.mat.uniforms.minPx.value = trueSize ? 0 : MIN_PX;
    const seen = Galaxy.presence(zoom) * Galaxy.presence(Math.hypot(...cam));
    this.mat.uniforms.opacity.value = seen;
    this.group.visible = seen > 0.01;
  }
}
