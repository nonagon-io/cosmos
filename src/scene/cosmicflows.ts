import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  MathUtils,
  Points,
  ShaderMaterial,
} from 'three';
import type { Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { AU_PER_LY, eclipticDir } from './stars';

// as written by fetch-data: three uint16 per galaxy, RA and Dec over their full range and distance in these
const MPC_UNIT = 1 / 64;
/** The layer the galaxy points draw on, added up apart from the scene and toned onto it. */
export const WEB_LAYER = 2;
const AU_PER_MPC = 3.26156e6 * AU_PER_LY;
// light years from the Sun over which these fade in, past the Local Volume's 35 million
const FADE_FROM = 2.5e7;
const FADE_TO = 6e7;
const LABELS_TO = 7e8;

/**
 * Big clusters to name, at the distance of their members in the catalogue. RA, Dec in degrees, Mpc.
 * Names are i18n keys under `clusters`.
 */
const CLUSTERS: { id: string; ra: number; dec: number; mpc: number }[] = [
  { id: 'virgo', ra: 187.7, dec: 12.39, mpc: 16.5 },
  { id: 'fornax', ra: 54.62, dec: -35.45, mpc: 19 },
  { id: 'centaurus', ra: 192.2, dec: -41.31, mpc: 46 },
  { id: 'hydra', ra: 159.18, dec: -27.53, mpc: 52 },
  { id: 'norma', ra: 243.59, dec: -60.91, mpc: 68 },
  { id: 'perseus', ra: 49.95, dec: 41.51, mpc: 73 },
  { id: 'coma', ra: 194.95, dec: 27.98, mpc: 99 },
  { id: 'leo', ra: 176.15, dec: 19.7, mpc: 92 },
];

export const POINT_VERT = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform float size;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size;
  ${LOGDEPTH_VERT}
}
`;

export const POINT_FRAG = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float opacity;
void main() {
  ${LOGDEPTH_FRAG}
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vec3(1.0, 0.9, 0.78) * (1.0 - r * r), opacity);
  #include <colorspace_fragment>
}
`;

/**
 * Every galaxy in Cosmicflows-4 with a measured distance, out to about 2.6 billion light years, and the rest of
 * the 2MASS Redshift Survey placed by redshift, each as a point.
 */
export class Cosmicflows {
  private readonly group = new Group();
  private readonly mat: ShaderMaterial;
  readonly clusters = CLUSTERS.map((c) => {
    const d = eclipticDir(c.ra, c.dec);
    return { id: c.id, at: d.map((x) => x * c.mpc * AU_PER_MPC) as Vec };
  });

  constructor(parent: Group, data: Uint16Array) {
    const n = data.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const ra = (data[i * 3] / 65535) * 360;
      const dec = (data[i * 3 + 1] / 65535) * 180 - 90;
      const r = data[i * 3 + 2] * MPC_UNIT * AU_PER_MPC;
      const d = eclipticDir(ra, dec);
      pos.set([d[0] * r, d[1] * r, d[2] * r], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.mat = new ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: { size: { value: 3 }, opacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(geo, this.mat);
    points.frustumCulled = false;
    points.layers.set(WEB_LAYER);
    this.group.add(points);
    parent.add(this.group);
  }

  setTime(shift: Vec) {
    this.group.position.set(-shift[0], -shift[1], -shift[2]);
  }

  placeOf(at: Vec): Vec {
    const g = this.group.position;
    return [g.x + at[0], g.y + at[1], g.z + at[2]];
  }

  /** How much these show, with the camera `sunDist` AU from the Sun. */
  static presence(sunDist: number) {
    const ly = sunDist / AU_PER_LY;
    return MathUtils.smoothstep(Math.log10(ly), Math.log10(FADE_FROM), Math.log10(FADE_TO));
  }

  /** Whether the cluster names fit, before they all crowd into the middle. */
  static labelled(sunDist: number) {
    const ly = sunDist / AU_PER_LY;
    return Cosmicflows.presence(sunDist) > 0.3 && ly < LABELS_TO;
  }

  get visible() {
    return this.group.visible;
  }

  update(sunDist: number, pixelRatio: number) {
    const k = Cosmicflows.presence(sunDist);
    this.mat.uniforms.opacity.value = 0.6 * k;
    this.mat.uniforms.size.value = 2.2 * pixelRatio;
    this.group.visible = k > 0.01;
  }
}
