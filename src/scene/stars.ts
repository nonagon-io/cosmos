import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  type Group,
  MathUtils,
  Points,
  ShaderMaterial,
} from 'three';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

export interface StarData {
  // naked-eye stars with no usable distance, drawn on the sky sphere: flat [ra deg, dec deg, magnitude, B-V]
  sky: number[];
  // [index into the field, name]
  labels: [number, string][];
}

/** Stars at their real 3D positions: flat [x, y, z (ecliptic light years), absolute magnitude, B-V]. */
export type StarField = Float32Array;

export const AU_PER_LY = 63241.077;

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;

/** Unit vector in the ecliptic frame for an equatorial RA/Dec in degrees. */
export function eclipticDir(ra: number, dec: number): [number, number, number] {
  const a = ra * MathUtils.DEG2RAD;
  const d = dec * MathUtils.DEG2RAD;
  const x = Math.cos(d) * Math.cos(a);
  const y = Math.cos(d) * Math.sin(a);
  const z = Math.sin(d);
  return [
    x,
    y * Math.cos(OBLIQUITY) + z * Math.sin(OBLIQUITY),
    -y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY),
  ];
}

/** Approximate star colour from the B-V index, through its temperature (Ballesteros 2012). */
export function starColor(bv: number) {
  const b = MathUtils.clamp(bv, -0.4, 2);
  const t = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
  // blackbody colour, fitted to the CIE tables
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.7 * (k - 60) ** -0.1332;
  const g = k <= 66 ? 99.47 * Math.log(k) - 161.1 : 288.1 * (k - 60) ** -0.0755;
  const bl = k >= 66 ? 255 : k <= 19 ? 0 : 138.5 * Math.log(k - 10) - 305;
  const c = new Color(
    MathUtils.clamp(r, 0, 255) / 255,
    MathUtils.clamp(g, 0, 255) / 255,
    MathUtils.clamp(bl, 0, 255) / 255,
  );
  // keep them pale; saturated colours read as fake
  return c.lerp(new Color(1, 1, 1), 0.35);
}

const skyVert = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
uniform float scale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  // flux relative to a magnitude 0 star; size grows slowly, brightness carries the rest
  float flux = pow(10.0, -0.4 * aMag);
  gl_PointSize = clamp(1.6 + 2.4 * pow(flux, 0.3), 1.6, 9.0) * scale;
  vAlpha = clamp(0.25 + flux * 3.0, 0.25, 1.0);
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const skyFrag = /* glsl */ `
uniform float opacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 5.0);
  gl_FragColor = vec4(vColor, a * vAlpha * opacity);
  #include <colorspace_fragment>
}
`;

/** Naked-eye stars on the sky sphere, rendered in their own scene with a rotation-only camera. */
export function skyStars(parent: Group, data: StarData): ShaderMaterial {
  const n = data.sky.length / 4;
  const pos = new Float32Array(n * 3);
  const mag = new Float32Array(n);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [ra, dec, m, bv] = data.sky.slice(i * 4, i * 4 + 4);
    pos.set(eclipticDir(ra, dec), i * 3);
    mag[i] = m;
    const c = starColor(bv);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aMag', new BufferAttribute(mag, 1));
  g.setAttribute('aColor', new BufferAttribute(col, 3));
  const mat = new ShaderMaterial({
    vertexShader: skyVert,
    fragmentShader: skyFrag,
    uniforms: { scale: { value: 1 }, opacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
  const points = new Points(g, mat);
  points.frustumCulled = false;
  parent.add(points);
  return mat;
}

const fieldVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aColor;
attribute float aAbs;
uniform float scale;
uniform float exposure;
uniform float floor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // apparent magnitude from the camera, brightened by the exposure once we are out among the stars
  float pc = max(length(mv.xyz) / 206264.806, 1e-7);
  float mag = aAbs + 5.0 * log(pc) / log(10.0) - 5.0 - exposure;
  float flux = pow(10.0, -0.4 * mag);
  gl_PointSize = clamp(1.6 + 2.4 * pow(flux, 0.3), 1.6, 9.0) * scale;
  // the same look as the sky sphere, and the naked-eye limit there
  vAlpha = clamp(floor + flux * 3.0, floor, 1.0) * (1.0 - smoothstep(6.2, 7.0, mag));
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const fieldFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float opacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  ${LOGDEPTH_FRAG}
  if (vAlpha < 0.004) discard;
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 5.0);
  gl_FragColor = vec4(vColor, a * vAlpha * opacity);
  #include <colorspace_fragment>
}
`;

/**
 * Every catalogued star with a distance, at its real position. Seen from the Solar System it is the same sky as
 * the sky sphere; flown out of it, the stars spread out into 3D.
 */
export class Stars3D {
  private readonly mat: ShaderMaterial;
  readonly count: number;

  constructor(
    parent: Group,
    readonly field: StarField,
  ) {
    const n = field.length / 5;
    this.count = n;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const abs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = field[i * 5] * AU_PER_LY;
      pos[i * 3 + 1] = field[i * 5 + 1] * AU_PER_LY;
      pos[i * 3 + 2] = field[i * 5 + 2] * AU_PER_LY;
      abs[i] = field[i * 5 + 3];
      const c = starColor(field[i * 5 + 4]);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    g.setAttribute('aAbs', new BufferAttribute(abs, 1));
    this.mat = new ShaderMaterial({
      vertexShader: fieldVert,
      fragmentShader: fieldFrag,
      uniforms: {
        scale: { value: 1 },
        opacity: { value: 1 },
        exposure: { value: 0 },
        floor: { value: 0.25 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(g, this.mat);
    points.frustumCulled = false;
    parent.add(points);
  }

  /** Ecliptic position in AU of star `i`. */
  position(i: number): [number, number, number] {
    const f = this.field;
    return [f[i * 5] * AU_PER_LY, f[i * 5 + 1] * AU_PER_LY, f[i * 5 + 2] * AU_PER_LY];
  }

  absmag(i: number) {
    return this.field[i * 5 + 3];
  }

  /** 0..1: how far the camera is into interstellar distances. */
  static presence(camDist: number) {
    return MathUtils.smoothstep(Math.log10(camDist), 4.6, 5.4);
  }

  /**
   * Out among the stars almost all of them are too faint for the eye; brighten them as a long exposure would,
   * by a magnitude shift that grows with the camera's distance from the Sun (in AU).
   */
  static exposure(sunDist: number) {
    return 3 * Math.log10(Math.max(1, sunDist / AU_PER_LY / 15));
  }

  update(pixelRatio: number, sunDist: number, camDist: number, opacity = 1) {
    this.mat.uniforms.scale.value = pixelRatio;
    this.mat.uniforms.opacity.value = opacity;
    this.mat.uniforms.exposure.value = Stars3D.exposure(sunDist);
    // tens of thousands of faint stars piled up read as a white wall; keep the faint ones quieter out there
    this.mat.uniforms.floor.value = 0.25 * (1 - 0.65 * Stars3D.presence(camDist));
  }
}
