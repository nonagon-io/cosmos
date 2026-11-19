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

/** Flat [a, e, i, node, peri, M at J2000] per object, as written by the fetch script. */
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

const keplerVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
${KEPLER}
attribute vec3 el1;
attribute vec3 el2;
uniform float day;
uniform float size;
void main() {
  vec3 p = keplerPosition(el1, el2, day);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = size;
  ${LOGDEPTH_VERT}
}
`;

const staticVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute float aSize;
uniform float size;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * aSize;
  ${LOGDEPTH_VERT}
}
`;

const pointFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 color;
uniform float opacity;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, d);
  gl_FragColor = vec4(color, a * opacity);
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
      const n = flat.length / 6;
      const el1 = new Float32Array(n * 3);
      const el2 = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        el1.set(flat.slice(i * 6, i * 6 + 3), i * 3);
        el2.set(flat.slice(i * 6 + 3, i * 6 + 6), i * 3);
      }
      const g = new BufferGeometry();
      g.setAttribute('el1', new BufferAttribute(el1, 3));
      g.setAttribute('el2', new BufferAttribute(el2, 3));
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
      // at true size every one of these is far below a pixel and too faint to see; leave a trace of the shape
      s.mat.uniforms.size.value = (trueSize ? 1 : s.size) * pixelRatio;
      s.mat.uniforms.opacity.value = s.alpha * k * (trueSize ? 0.12 : 1);
    }
  }
}

/** Seeded so the model cloud is the same on every load. */
function rng(seed: number) {
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
    const sizes = new Float32Array(count);
    // inverse CDF of n(r) r^2 ~ r^-1.5 between r0 and r1
    const sampleR = (r0: number, r1: number) => {
      const a = r0 ** -0.5;
      const b = r1 ** -0.5;
      return (a + (b - a) * rand()) ** -2;
    };
    for (let i = 0; i < count; i++) {
      const inner = rand() < 0.3;
      const r = inner ? sampleR(2000, 20000) : sampleR(20000, 100000);
      const lon = rand() * Math.PI * 2;
      let lat: number;
      if (inner) {
        // thick disk, flattening with distance into the sphere
        const spread = 0.25 + 0.9 * ((r - 2000) / 18000);
        const g = Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(Math.PI * 2 * rand());
        lat = MathUtils.clamp(g * spread * 0.6, -Math.PI / 2, Math.PI / 2);
      } else {
        lat = Math.asin(2 * rand() - 1);
      }
      pos[i * 3] = r * Math.cos(lat) * Math.cos(lon);
      pos[i * 3 + 1] = r * Math.cos(lat) * Math.sin(lon);
      pos[i * 3 + 2] = r * Math.sin(lat);
      sizes[i] = 0.7 + rand() * rand() * 1.6;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSize', new BufferAttribute(sizes, 1));
    this.mat = pointMaterial(staticVert, '#a9c6ee', 0.4);
    this.points = new Points(g, this.mat);
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  update(pixelRatio: number, visible: boolean, camDist: number, trueSize = false) {
    // seen from inside it would only be a haze over the whole sky, so it appears as the camera leaves it
    const k = MathUtils.smoothstep(Math.log10(camDist), 2.9, 3.9);
    this.points.visible = visible && k > 0.01;
    this.mat.uniforms.opacity.value = 0.42 * k * (trueSize ? 0.03 : 1);
    this.mat.uniforms.size.value = (trueSize ? 0.7 : 1.4) * pixelRatio;
  }
}
