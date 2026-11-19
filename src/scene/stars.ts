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

export interface NearStar {
  name: string;
  x: number;
  y: number;
  z: number;
  mag: number;
  absmag: number;
  ci: number;
  ly: number;
}

export interface StarData {
  // flat [ra deg, dec deg, magnitude, B-V] per star
  sky: number[];
  names: [number, number, string][];
  near: NearStar[];
}

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;

/** Unit vector in the ecliptic frame for an equatorial RA/Dec in degrees. */
function eclipticDir(ra: number, dec: number): [number, number, number] {
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
export function skyStars(parent: Group, data: StarData) {
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

const nearVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aColor;
attribute float aSize;
uniform float scale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_PointSize = aSize * scale;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH_VERT}
}
`;

const nearFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float opacity;
varying vec3 vColor;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 4.0) + 0.6 * exp(-d * d * 40.0);
  gl_FragColor = vec4(vColor, a * opacity);
  #include <colorspace_fragment>
}
`;

/** Stars within 17 light years at their real positions, for when the camera is out among them. */
export class NearStars {
  private readonly mat: ShaderMaterial;
  private readonly points: Points;

  constructor(
    parent: Group,
    readonly stars: NearStar[],
  ) {
    const pos = new Float32Array(stars.length * 3);
    const col = new Float32Array(stars.length * 3);
    const size = new Float32Array(stars.length);
    for (const [i, s] of stars.entries()) {
      pos.set([s.x, s.y, s.z], i * 3);
      const c = starColor(s.ci);
      col.set([c.r, c.g, c.b], i * 3);
      // brighter stars (lower absolute magnitude) draw bigger
      size[i] = MathUtils.clamp(9 - s.absmag * 0.45, 3, 10);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aColor', new BufferAttribute(col, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    this.mat = new ShaderMaterial({
      vertexShader: nearVert,
      fragmentShader: nearFrag,
      uniforms: { scale: { value: 1 }, opacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  /** 0..1: how far the camera is into interstellar distances. */
  static presence(camDist: number) {
    return MathUtils.smoothstep(Math.log10(camDist), 4.6, 5.4);
  }

  update(pixelRatio: number, camDist: number) {
    const k = NearStars.presence(camDist);
    this.points.visible = k > 0.01;
    this.mat.uniforms.opacity.value = k;
    this.mat.uniforms.scale.value = pixelRatio;
  }
}
