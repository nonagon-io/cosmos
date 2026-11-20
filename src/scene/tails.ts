import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  type Group,
  MathUtils,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
} from 'three';
import type { Vec } from '../astro/kepler';
import type { Body } from '../data/schema';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { coma } from './textures';

const KM_PER_AU = 149597870.7;
// the coma never shrinks below a soft halo this many px across, except at true size
const COMA_MIN_PX = 3;

const SEGMENTS = 48;

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec2 aST;
varying vec2 vST;
void main() {
  vST = aST;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 color;
uniform float opacity;
uniform float falloff;
varying vec2 vST;
void main() {
  ${LOGDEPTH_FRAG}
  float along = pow(1.0 - vST.x, falloff) * smoothstep(0.0, 0.02, vST.x + 0.005);
  float across = 1.0 - vST.y * vST.y;
  gl_FragColor = vec4(color, along * across * across * opacity);
  #include <colorspace_fragment>
}
`;

interface Style {
  color: string;
  opacity: number;
  falloff: number;
  // half width at the head and at the far end, as fractions of the length
  width: [number, number];
  // how far the far end bends back along the orbit, as a fraction of the length
  bend: number;
}

const ION: Style = { color: '#8fc4ff', opacity: 0.55, falloff: 1.8, width: [0.005, 0.016], bend: 0 };
const DUST: Style = { color: '#fff0d8', opacity: 0.5, falloff: 1.3, width: [0.02, 0.14], bend: 0.35 };

class Ribbon {
  readonly mesh: Mesh;
  private readonly pos = new Float32Array((SEGMENTS + 1) * 6);
  private readonly mat: ShaderMaterial;

  constructor(
    parent: Group,
    readonly style: Style,
  ) {
    const st = new Float32Array((SEGMENTS + 1) * 4);
    const index: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      st.set([i / SEGMENTS, -1, i / SEGMENTS, 1], i * 4);
      if (i < SEGMENTS) {
        const a = i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('aST', new BufferAttribute(st, 2));
    g.setIndex(index);
    this.mat = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        color: { value: new Color(style.color) },
        opacity: { value: 0 },
        falloff: { value: style.falloff },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.mesh = new Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  /**
   * Lays the ribbon from `head` along `away` (unit, from the Sun), bending toward `back` (unit, behind the
   * motion), turned to face the camera at `cam`. `minHalf` keeps it at least a pixel or so wide.
   */
  set(head: Vec, away: Vec, back: Vec, length: number, cam: Vec, minHalf: number, opacity: number) {
    const { width, bend } = this.style;
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      const k = length * bend * s * s;
      const c = [0, 1, 2].map((j) => head[j] + length * s * away[j] + k * back[j]);
      // tangent of the curve, and the side direction across it as seen from the camera
      const tg = [0, 1, 2].map((j) => away[j] + 2 * bend * s * back[j]);
      const to = [cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]];
      let sx = tg[1] * to[2] - tg[2] * to[1];
      let sy = tg[2] * to[0] - tg[0] * to[2];
      let sz = tg[0] * to[1] - tg[1] * to[0];
      const n = Math.hypot(sx, sy, sz) || 1;
      const half = Math.max(minHalf, length * (width[0] + (width[1] - width[0]) * s));
      sx = (sx / n) * half;
      sy = (sy / n) * half;
      sz = (sz / n) * half;
      this.pos.set([c[0] - sx, c[1] - sy, c[2] - sz, c[0] + sx, c[1] + sy, c[2] + sz], i * 6);
    }
    (this.mesh.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.mat.uniforms.opacity.value = opacity;
    this.mesh.visible = opacity > 0.003;
  }

  hide() {
    this.mesh.visible = false;
  }
}

/**
 * Ion and dust tails and the glowing coma of the named comets. The directions follow physics (the ion tail straight away from the
 * Sun, the dust tail curving back along the orbit); the lengths are scaled from roughly what each comet showed,
 * by the inverse square of its distance from the Sun.
 */
export class CometTails {
  private readonly tails: { body: Body; q: number; ion: Ribbon; dust: Ribbon; coma: Sprite | null }[] = [];

  constructor(parent: Group, bodies: Body[], perihelion: (id: string) => number | null) {
    for (const body of bodies) {
      const q = perihelion(body.id);
      if (body.tail && q) {
        let halo: Sprite | null = null;
        if (body.tail.coma) {
          halo = new Sprite(
            new SpriteMaterial({
              map: coma(),
              blending: AdditiveBlending,
              depthWrite: false,
              transparent: true,
            }),
          );
          halo.visible = false;
          parent.add(halo);
        }
        this.tails.push({
          body,
          q,
          ion: new Ribbon(parent, ION),
          dust: new Ribbon(parent, DUST),
          coma: halo,
        });
      }
    }
  }

  /** `pxPerAu(p)` gives the screen scale at a point, for the minimum width. */
  update(
    positionOf: (id: string) => Vec | undefined,
    velocityOf: (id: string) => Vec | null,
    cam: Vec,
    pxPerAu: (p: Vec) => number,
    trueSize: boolean,
  ) {
    for (const t of this.tails) {
      const p = positionOf(t.body.id);
      const tail = t.body.tail;
      const r = p ? Math.hypot(p[0], p[1], p[2]) : 0;
      const onset = tail?.onset ?? 4;
      const active = 1 - MathUtils.smoothstep(r, onset * 0.6, onset);
      const v = active > 0 && p ? velocityOf(t.body.id) : null;
      if (!p || !tail || !v || r === 0) {
        t.ion.hide();
        t.dust.hide();
        if (t.coma) {
          t.coma.visible = false;
        }
        continue;
      }
      const away: Vec = [p[0] / r, p[1] / r, p[2] / r];
      // behind the motion, square to the Sun direction
      const dot = v[0] * away[0] + v[1] * away[1] + v[2] * away[2];
      const b = [0, 1, 2].map((j) => -(v[j] - dot * away[j]));
      const bn = Math.hypot(b[0], b[1], b[2]) || 1;
      const back: Vec = [b[0] / bn, b[1] / bn, b[2] / bn];
      const scale = Math.min(1.5, (t.q / r) ** 2) * active;
      const px = pxPerAu(p);
      const minHalf = 0.8 / px;
      if (t.coma && tail.coma) {
        // a coma swells less steeply than the tails as the comet nears the Sun
        const size = (tail.coma / KM_PER_AU) * Math.min(1.5, t.q / r) * active;
        const radius = trueSize ? size : Math.max(size, COMA_MIN_PX / px);
        t.coma.position.set(p[0], p[1], p[2]);
        // the haze fades out well past the nominal radius
        t.coma.scale.setScalar(radius * 3);
        const mat = t.coma.material as SpriteMaterial;
        // from inside or right next to it a coma is too thin to see, it would only wash over the screen
        const near = 1 - MathUtils.smoothstep(radius * px, 120, 500);
        mat.opacity = 0.75 * Math.min(1, (t.q / r) ** 1.5) * active * near;
        t.coma.visible = mat.opacity > 0.01;
      }
      const glow = Math.sqrt(scale);
      // right at the head the tail is wider than the view and only washes over it
      const camDist = Math.hypot(cam[0] - p[0], cam[1] - p[1], cam[2] - p[2]);
      for (const [ribbon, peak] of [
        [t.ion, tail.ion],
        [t.dust, tail.dust],
      ] as const) {
        if (peak > 0) {
          const head = peak * scale * ribbon.style.width[0];
          const near = MathUtils.smoothstep(camDist, head * 2, head * 12);
          ribbon.set(p, away, back, peak * scale, cam, minHalf, ribbon.style.opacity * glow * near);
        } else {
          ribbon.hide();
        }
      }
    }
  }
}
