import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PlaneGeometry,
  Points,
  PointsMaterial,
  ShaderMaterial,
} from 'three';
import { orient, solveKepler, type Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { texture } from './textures';

// Orbits of the S-stars as astronomers see them on the sky: a (arcsec), e, i, Ω, ω (degrees), time of
// pericentre and period (years). Gillessen et al. 2017, S2 from GRAVITY 2019, S4711 and S4714 from Peißker
// et al. 2020.
const S_STARS = [
  { id: 'S2', a: 0.1251, e: 0.8843, i: 133.91, node: 228.07, peri: 66.25, tp: 2018.379, p: 16.0518 },
  { id: 'S1', a: 0.595, e: 0.556, i: 119.14, node: 342.04, peri: 122.3, tp: 2001.8, p: 166.0 },
  { id: 'S8', a: 0.4047, e: 0.8031, i: 74.37, node: 315.43, peri: 346.7, tp: 1983.64, p: 92.9 },
  { id: 'S12', a: 0.2987, e: 0.8883, i: 33.56, node: 230.1, peri: 317.9, tp: 1995.59, p: 58.9 },
  { id: 'S13', a: 0.2641, e: 0.425, i: 24.7, node: 74.5, peri: 245.2, tp: 2004.86, p: 49.0 },
  { id: 'S14', a: 0.2863, e: 0.9761, i: 100.59, node: 226.38, peri: 334.59, tp: 2000.12, p: 55.3 },
  { id: 'S29', a: 0.428, e: 0.728, i: 105.8, node: 161.96, peri: 346.5, tp: 2025.96, p: 101.0 },
  { id: 'S38', a: 0.1416, e: 0.8201, i: 171.1, node: 101.06, peri: 17.99, tp: 2003.19, p: 19.2 },
  { id: 'S55', a: 0.1078, e: 0.7209, i: 150.1, node: 325.5, peri: 331.5, tp: 2009.34, p: 12.8 },
  { id: 'S4711', a: 0.0751, e: 0.768, i: 114.71, node: 20.1, peri: 131.59, tp: 2010.85, p: 7.6 },
  { id: 'S4714', a: 0.102, e: 0.985, i: 127.7, node: 129.28, peri: 357.25, tp: 2017.29, p: 12.0 },
];

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;

// Sgr A*: 4.3 million suns, so a Schwarzschild radius of 0.085 AU. The ring the EHT saw is 51.8 µas across,
// about 0.42 AU at this distance; the shadow inside it is close to what general relativity predicts.
const RING_R = 0.21;
const SHADOW_R = 0.16;
// half the width of the EHT image in AU: its bright ridge is about 230 of its 640 px half width from the middle
const PHOTO_HALF = (RING_R * 640) / 230;

/** A round mask, so the photo's square edge doesn't show. */
function roundMask() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, '#fff');
    g.addColorStop(0.6, '#fff');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
  }
  return new CanvasTexture(c);
}

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec2 vP;
void main() {
  vP = position.xy;
  // a billboard: the quad always faces the camera
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float ringR;
uniform float shadowR;
uniform float opacity;
varying vec2 vP;
void main() {
  ${LOGDEPTH_FRAG}
  float r = length(vP);
  float th = atan(vP.y, vP.x);
  float w = ringR * 0.2;
  float ring = exp(-pow((r - ringR) / w, 2.0));
  // brighter on one side, where the gas swirls toward us, with a few knots like the EHT image
  ring *= (0.45 + 0.55 * pow(0.5 + 0.5 * cos(th + 1.9), 1.5)) * (0.85 + 0.15 * sin(3.0 * th + 0.7));
  float halo = 0.12 * exp(-max(r - ringR, 0.0) / (ringR * 0.6)) * step(shadowR, r);
  float I = clamp(ring + halo, 0.0, 1.0);
  vec3 col = vec3(1.0, 0.45, 0.08) * I + vec3(1.0, 0.85, 0.5) * I * I * I;
  float shadow = 1.0 - smoothstep(shadowR * 0.9, shadowR * 1.1, r);
  gl_FragColor = vec4(col, max(I, shadow) * opacity);
  #include <colorspace_fragment>
}
`;

/**
 * Sgr A* up close: the ring and shadow the Event Horizon Telescope imaged, drawn as a simulation at its real
 * size, and the S-stars on their measured orbits. Everything sits in a group at Sgr A*'s position, so the
 * vertices stay small numbers that 32-bit floats hold exactly.
 */
export class SgrA {
  readonly group = new Group();
  readonly stars = S_STARS.map((s) => s.id);
  private readonly ring: ShaderMaterial;
  private readonly photo: MeshBasicMaterial;
  private readonly orbitMat = new LineBasicMaterial({
    color: '#9d8cff',
    transparent: true,
    depthWrite: false,
  });
  private readonly points: Points;
  private readonly starPos: Float32Array;
  // unit vectors of the sky at Sgr A* in ecliptic coordinates: north, east, and away from us
  private readonly axes: [Vec, Vec, Vec];
  private readonly auPerArcsec: number;
  readonly local: Vec[] = S_STARS.map(() => [0, 0, 0]);
  /** 1 while the real EHT image is shown, 0 for the simulated ring. */
  photoWeight = 0;

  constructor(parent: Group, pos: Vec, ra: number, dec: number, pc: number) {
    this.group.position.set(...pos);
    parent.add(this.group);
    this.auPerArcsec = pc;
    const a = ra * MathUtils.DEG2RAD;
    const d = dec * MathUtils.DEG2RAD;
    const ecl = (v: Vec): Vec => [
      v[0],
      v[1] * Math.cos(OBLIQUITY) + v[2] * Math.sin(OBLIQUITY),
      -v[1] * Math.sin(OBLIQUITY) + v[2] * Math.cos(OBLIQUITY),
    ];
    this.axes = [
      ecl([-Math.sin(d) * Math.cos(a), -Math.sin(d) * Math.sin(a), Math.cos(d)]),
      ecl([-Math.sin(a), Math.cos(a), 0]),
      ecl([Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]),
    ];

    this.ring = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { ringR: { value: RING_R }, shadowR: { value: SHADOW_R }, opacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    const quad = new Mesh(new PlaneGeometry(RING_R * 5, RING_R * 5), this.ring);
    quad.frustumCulled = false;
    this.group.add(quad);

    // the real image, laid flat on the sky as we see it: north up, east to the left
    const [north, east] = this.axes;
    const corner = (u: number, v: number) => [0, 1, 2].map((c) => PHOTO_HALF * (-u * east[c] + v * north[c]));
    const pg = new BufferGeometry();
    pg.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)]),
        3,
      ),
    );
    pg.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    pg.setIndex([0, 1, 2, 0, 2, 3]);
    this.photo = new MeshBasicMaterial({
      map: texture('sgra_eht'),
      alphaMap: roundMask(),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    const photo = new Mesh(pg, this.photo);
    photo.frustumCulled = false;
    this.group.add(photo);

    for (const s of S_STARS) {
      const n = 512;
      const line = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) {
        line.set(this.sky(s, (k / n) * Math.PI * 2), k * 3);
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(line, 3));
      const loop = new LineLoop(g, this.orbitMat);
      loop.frustumCulled = false;
      this.group.add(loop);
    }

    this.starPos = new Float32Array(S_STARS.length * 3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.starPos, 3));
    this.points = new Points(
      g,
      new PointsMaterial({
        color: new Color('#cfe0ff'),
        size: 5,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.group.add(this.points);
  }

  /** A point on star `s`'s orbit at eccentric anomaly `ea`, relative to Sgr A* in ecliptic AU. */
  private sky(s: (typeof S_STARS)[number], ea: number): Vec {
    const a = s.a * this.auPerArcsec;
    const px = a * (Math.cos(ea) - s.e);
    const py = a * Math.sqrt(1 - s.e * s.e) * Math.sin(ea);
    // north, east, and depth along the line of sight, positive away from us. Checked against S2 in 2018: this
    // gives the peak recession (about +3,900 km/s) in April and the most negative in late summer, as GRAVITY saw
    const [n, e, z] = orient(
      px,
      py,
      s.i * MathUtils.DEG2RAD,
      s.node * MathUtils.DEG2RAD,
      s.peri * MathUtils.DEG2RAD,
    );
    const [an, ae, az] = this.axes;
    return [0, 1, 2].map((c) => n * an[c] + e * ae[c] + z * az[c]) as Vec;
  }

  /**
   * Moves the stars to `day` and fades things by where the camera is: `toCam` runs from Sgr A* to the camera
   * in ecliptic AU.
   */
  update(day: number, toCam: Vec) {
    const camDist = Math.hypot(...toCam);
    // the EHT image only shows Sgr A* as seen from Earth; from any other side fall back to the simulation
    const away = this.axes[2];
    const facing = -(toCam[0] * away[0] + toCam[1] * away[1] + toCam[2] * away[2]) / Math.max(camDist, 1e-12);
    this.photoWeight = MathUtils.smoothstep(facing, Math.cos(0.6), Math.cos(0.25));
    this.photo.opacity = this.photoWeight;
    this.ring.uniforms.opacity.value = 1 - this.photoWeight;
    const year = 2000 + day / 365.25;
    for (const [k, s] of S_STARS.entries()) {
      const m = ((year - s.tp) / s.p) * Math.PI * 2;
      const p = this.sky(s, solveKepler(m, s.e));
      this.local[k] = p;
      this.starPos.set(p, k * 3);
    }
    (this.points.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    const lg = Math.log10(camDist);
    // the orbits span a few thousand AU; far out they would only be a speck over the Galaxy model
    const near = 1 - MathUtils.smoothstep(lg, 4.6, 5.4);
    this.orbitMat.opacity = 0.45 * near;
    (this.points.material as PointsMaterial).opacity = near;
    this.group.visible = near > 0.001;
  }

  /** Ecliptic position of star `k` in the scene, for labels. */
  positionOf(k: number): Vec {
    const p = this.group.position;
    const l = this.local[k];
    return [p.x + l[0], p.y + l[1], p.z + l[2]];
  }
}
