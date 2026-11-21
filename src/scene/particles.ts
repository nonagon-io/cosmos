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
import { KEPLER, LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

/** Flat [a, e, i, node, peri, M at J2000, H] per object, as written by the fetch script. */
export type ElementSets = Record<'belt' | 'neo' | 'trojans' | 'centaurs' | 'tno' | 'comets', number[]>;

// `extent` is the set's typical distance from the Sun in AU; once that is only a few px on screen the set is
// one overlapping glare, so it fades out
const STYLE: Record<keyof ElementSets, { color: string; size: number; alpha: number; extent: number }> = {
  belt: { color: '#cdb895', size: 1.7, alpha: 0.62, extent: 2.8 },
  neo: { color: '#ff9467', size: 1.8, alpha: 0.75, extent: 1.5 },
  trojans: { color: '#e0b060', size: 1.7, alpha: 0.65, extent: 5.2 },
  centaurs: { color: '#9fdcae', size: 1.9, alpha: 0.75, extent: 15 },
  tno: { color: '#8fb4ff', size: 1.9, alpha: 0.7, extent: 45 },
  comets: { color: '#c5e8ff', size: 1.7, alpha: 0.5, extent: 8 },
};

const MEDIAN_LIGHT = 0.55;
const SQUEEZE = 0.4;

const OORT_ALPHA = 0.6;
const INNER_START = 2000;
const INNER_EDGE = 20000;
const OUTER_EDGE = 100000;
// camera distances from the Sun, in AU, at which the innermost and outermost points look their brightest
const AU_PER_LY = 63241;
const INNER_PEAK = 11000;
const OUTER_PEAK = 4 * AU_PER_LY;
/** Camera distance from the Sun past which none of the Oort cloud shows. */
export const OORT_GONE = 3 * OUTER_PEAK;

const keplerVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
${KEPLER}
attribute vec3 el1;
attribute vec3 el2;
attribute float aLight;
uniform float day;
uniform float size;
uniform float maxGrow;
varying float vA;
void main() {
  vec3 p = keplerPosition(el1, el2, day);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  // the faint many make a haze, the few big ones stand out as dots
  vA = min(aLight, 1.0);
  gl_PointSize = size * clamp(sqrt(aLight), 0.8, maxGrow);
  ${LOGDEPTH_VERT}
}
`;

const staticVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute float aLight;
attribute float aPeak;
uniform float size;
uniform float maxGrow;
uniform float sunDist;
uniform float innerGain;
uniform float outerGain;
varying float vA;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // backing away, the cloud crowds onto fewer pixels as 1/d^2 and would brighten; past its peak each point
  // dims as much, and past the outer peak the whole fades out, as from far off comets this small could not
  // be seen
  float d = max(sunDist, 1.0);
  float hold = min(1.0, (aPeak / d) * (aPeak / d));
  hold *= mix(innerGain, outerGain, smoothstep(${INNER_PEAK}.0, ${OUTER_PEAK}.0, aPeak));
  vA = min(aLight, 1.0) * hold * (1.0 - smoothstep(${OUTER_PEAK}.0, ${OORT_GONE}.0, d));
  gl_PointSize = size * clamp(sqrt(aLight), 0.8, maxGrow);
  ${LOGDEPTH_VERT}
}
`;

const pointFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 color;
uniform float opacity;
varying float vA;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, d);
  gl_FragColor = vec4(color, a * opacity * vA);
  #include <colorspace_fragment>
}
`;

function pointMaterial(vertexShader: string, color: string, alpha: number) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader: pointFrag,
    uniforms: {
      day: { value: 0 },
      size: { value: 2 },
      maxGrow: { value: 3 },
      color: { value: new Color(color) },
      opacity: { value: alpha },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/** Asteroids, trojans, centaurs, TNOs and comets, each moved along its own orbit on the GPU. */
export class SmallBodies {
  private readonly sets: {
    points: Points;
    mat: ShaderMaterial;
    size: number;
    alpha: number;
    extent: number;
  }[] = [];

  constructor(parent: Group, data: ElementSets) {
    for (const [k, flat] of Object.entries(data) as [keyof ElementSets, number[]][]) {
      const n = flat.length / 7;
      const el1 = new Float32Array(n * 3);
      const el2 = new Float32Array(n * 3);
      const mags = Float32Array.from({ length: n }, (_, i) => flat[i * 7 + 6]);
      const median = [...mags].sort((a, b) => a - b)[Math.floor(n / 2)];
      for (let i = 0; i < n; i++) {
        el1.set(flat.slice(i * 7, i * 7 + 3), i * 3);
        el2.set(flat.slice(i * 7 + 3, i * 7 + 6), i * 3);
      }
      const g = new BufferGeometry();
      g.setAttribute('el1', new BufferAttribute(el1, 3));
      g.setAttribute('el2', new BufferAttribute(el2, 3));
      // light by absolute magnitude against the set's median, which lands at MEDIAN_LIGHT. The real spread
      // runs to tens of thousands, which would leave only a handful of dots, so it is squeezed: each
      // magnitude brighter counts 1.45 times instead of 2.5
      g.setAttribute(
        'aLight',
        new BufferAttribute(
          mags.map((h) => MEDIAN_LIGHT * 10 ** (-0.4 * SQUEEZE * (h - median))),
          1,
        ),
      );
      // positions are computed in the shader; this attribute only sets the vertex count
      g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
      const style = STYLE[k];
      const mat = pointMaterial(keplerVert, style.color, style.alpha);
      const points = new Points(g, mat);
      points.frustumCulled = false;
      parent.add(points);
      this.sets.push({ points, mat, size: style.size, alpha: style.alpha, extent: style.extent });
    }
  }

  /** `pxPerAu` is the screen scale at the Sun's distance from the camera, `height` the screen height in px. */
  update(
    day: number,
    pixelRatio: number,
    visible: boolean,
    pxPerAu: number,
    height: number,
    trueSize = false,
  ) {
    for (const s of this.sets) {
      const px = s.extent * pxPerAu;
      // a set that surrounds the camera only speckles the whole sky, so it steps back
      const k =
        MathUtils.smoothstep(px, 12, 70) * (1 - 0.85 * MathUtils.smoothstep(px, height * 1.5, height * 6));
      s.points.visible = visible && k > 0.01;
      s.mat.uniforms.day.value = day;
      // at true size every one of these is far below a pixel and too faint to see; leave a haze for the shape
      s.mat.uniforms.size.value = (trueSize ? 1 : s.size) * pixelRatio;
      s.mat.uniforms.maxGrow.value = trueSize ? 1 : 3;
      // and the haze is only kept while the set fills a good part of the screen: further out, a real crowd of
      // rocks this small could not be seen at all
      const near = trueSize ? 1.2 * MathUtils.smoothstep(px / height, 0.15, 0.45) : 1;
      s.mat.uniforms.opacity.value = s.alpha * k * near;
    }
  }
}

/** Seeded so the model cloud is the same on every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A model of the Oort cloud. Nothing in it has been observed, so the distribution follows theory: an inner,
 * flattened Hills cloud from 2,000 to 20,000 AU and an outer spherical cloud to about 100,000 AU, with the
 * number density falling as r^-3.5.
 */
export class OortCloud {
  private readonly points: Points;
  private readonly mat: ShaderMaterial;

  constructor(parent: Group, count = 180000) {
    const rand = rng(1950);
    const pos = new Float32Array(count * 3);
    const light = new Float32Array(count);
    const peak = new Float32Array(count);
    // nuclei sizes from a power law, N(>D) ~ D^-1.9 as measured for Jupiter-family comets (Snodgrass et al.
    // 2011), lit as D^2 and squeezed like the small bodies' magnitudes
    const Q = 1.9;
    const median = 2 ** (1 / Q);
    // inverse CDF of n(r) r^2 ~ r^-1.5 between r0 and r1
    const sampleR = (r0: number, r1: number) => {
      const a = r0 ** -0.5;
      const b = r1 ** -0.5;
      return (a + (b - a) * rand()) ** -2;
    };
    // the inner cloud looks its brightest from INNER_PEAK and the outer from OUTER_PEAK; across the first part
    // of the outer one the peak runs smoothly from one to the other, so no sharp rim shows where it changes
    const blend = 2 * INNER_EDGE;
    for (let i = 0; i < count; i++) {
      const inner = rand() < 0.3;
      const r = inner ? sampleR(INNER_START, INNER_EDGE) : sampleR(INNER_EDGE, OUTER_EDGE);
      const lon = rand() * Math.PI * 2;
      let lat: number;
      if (inner) {
        // thick disk, flattening with distance into the sphere
        const spread = 0.25 + 0.9 * ((r - INNER_START) / (INNER_EDGE - INNER_START));
        const g = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(Math.PI * 2 * rand());
        lat = MathUtils.clamp(g * spread * 0.6, -Math.PI / 2, Math.PI / 2);
      } else {
        lat = Math.asin(2 * rand() - 1);
      }
      pos[i * 3] = r * Math.cos(lat) * Math.cos(lon);
      pos[i * 3 + 1] = r * Math.cos(lat) * Math.sin(lon);
      pos[i * 3 + 2] = r * Math.sin(lat);
      const t = MathUtils.clamp(Math.log(r / INNER_EDGE) / Math.log(blend / INNER_EDGE), 0, 1);
      peak[i] = INNER_PEAK * (OUTER_PEAK / INNER_PEAK) ** (inner ? 0 : t * t * (3 - 2 * t));
      const d = (1 - rand()) ** (-1 / Q);
      light[i] = MEDIAN_LIGHT * (d / median) ** (2 * SQUEEZE);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aLight', new BufferAttribute(light, 1));
    g.setAttribute('aPeak', new BufferAttribute(peak, 1));
    this.mat = pointMaterial(staticVert, '#a9c6ee', OORT_ALPHA);
    this.mat.uniforms.sunDist = { value: 0 };
    this.mat.uniforms.innerGain = { value: 1 };
    this.mat.uniforms.outerGain = { value: 1 };
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  update(pixelRatio: number, visible: boolean, camDist: number, trueSize = false) {
    // seen from inside it would only be a haze over the whole sky, so it appears as the camera leaves it;
    // going out, the shader fades it a shell at a time
    const k = MathUtils.smoothstep(Math.log10(camDist), 2.9, 3.9);
    this.points.visible = visible && k > 0.01 && camDist < OORT_GONE;
    this.mat.uniforms.sunDist.value = camDist;
    // at true size the haze is faint; the outer cloud, thin and spread over a sphere, more so
    this.mat.uniforms.innerGain.value = trueSize ? 1.8 : 1;
    this.mat.uniforms.outerGain.value = trueSize ? 3 : 1;
    // at true size each is far below a pixel; a haze is left for the shape
    this.mat.uniforms.opacity.value = OORT_ALPHA * k * (trueSize ? 0.6 : 1);
    this.mat.uniforms.size.value = (trueSize ? 1 : 1.4) * pixelRatio;
    this.mat.uniforms.maxGrow.value = trueSize ? 1 : 3;
  }
}
