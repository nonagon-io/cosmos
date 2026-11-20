import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineLoop,
  MathUtils,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  Points,
  PointsMaterial,
  ShaderMaterial,
  Vector2,
} from 'three';
import { orient, solveKepler, type Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

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

// Sgr A*: 4.3 million suns, so a Schwarzschild radius of 0.085 AU. Its shadow is about 5.2 of those across,
// which matches the 51.8 µas ring the EHT measured.
const RS = 0.0848;
// how far out the quad the disk is traced on reaches, in Schwarzschild radii
const QUAD_RS = 16;
// on-screen size the shadow is held at, like the marker dots on planets
const HOLE_MIN_PX = 5;
// seconds each copy of the gas pattern lives for (about one orbit of the inner edge), and that edge's
// angular speed in rad/s
const SHEAR_PERIOD = 2000;
const INNER_OMEGA = 0.0167 * 3 ** -1.5;
// The disk's tilt to our line of sight and the position angle its near side leans to. Chosen so that from
// Earth it looks like the EHT image: seen fairly face on, brightest toward the top right.
const DISK_INCLINATION = 30;
const DISK_TILT_PA = 240;

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform float size;
uniform vec3 diskN;
uniform vec3 diskT;
varying vec3 vView;
varying vec3 vCenter;
varying vec3 vN;
varying vec3 vT;
void main() {
  // a billboard: the quad always faces the camera
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vCenter = c.xyz;
  vView = c.xyz + vec3(position.xy * size, 0.0);
  vN = normalize((modelViewMatrix * vec4(diskN, 0.0)).xyz);
  vT = normalize((modelViewMatrix * vec4(diskT, 0.0)).xyz);
  gl_Position = projectionMatrix * vec4(vView, 1.0);
  ${LOGDEPTH_VERT}
}
`;

// Traces each pixel's ray back past the hole, bending it as light bends around a non-spinning black hole,
// and shades the disk where the ray crosses it. Lengths are in Schwarzschild radii.
const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform float rs;
varying vec3 vView;
varying vec3 vCenter;
varying vec3 vN;
varying vec3 vT;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 x) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(x);
    x *= 2.03;
    a *= 0.5;
  }
  return s;
}

// Clumps of gas carried round at the real orbital speed: Ω = (c / Rs) / sqrt(2 r³), so once round the inner
// edge in about 33 minutes. That shear winds any pattern into plain rings, so two copies take turns; the
// timing for both comes from JS (see SgrA.update), where doubles hold the date without rounding.
uniform vec2 clock;
uniform vec2 seeds;
uniform float fade;
uniform float blur;
float clumps(vec3 hp, float hr, vec3 B, float t, float seed) {
  float ang = atan(dot(hp, B), dot(hp, vT)) - 0.0167 * pow(hr, -1.5) * t;
  vec3 q = vec3(cos(ang) * hr, sin(ang) * hr, seed);
  // stretched along the orbit, so the clumps read as streaks of gas
  vec3 s = vec3(cos(ang) * 2.2, sin(ang) * 2.2, hr * 1.6 + seed);
  return 0.55 * fbm(q * 0.9) + 0.6 * fbm(s * 2.0);
}
float gas(vec3 hp, float hr, vec3 B) {
  float g = mix(clumps(hp, hr, B, clock.x, seeds.x), clumps(hp, hr, B, clock.y, seeds.y), fade);
  // played fast, the inner gas laps many times a frame and smears into an even glow, as a long exposure would
  return mix(g, 0.62, clamp(blur * pow(3.0 / hr, 1.5), 0.0, 1.0));
}

void main() {
  ${LOGDEPTH_FRAG}
  vec3 ro = -vCenter / rs;
  vec3 rd = normalize(vView);
  float tc = dot(-ro, rd);
  if (length(ro + rd * tc) > 15.5 && tc > 0.0) discard;
  vec3 p = ro + rd * max(tc - 22.0, 0.0);
  vec3 v = rd;
  vec3 B = cross(vN, vT);
  vec3 l = cross(p, v);
  float h2 = dot(l, l);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float minR = 1e9;
  for (int i = 0; i < 220; i++) {
    float r = length(p);
    minR = min(minR, r);
    if (r < 1.0) {
      alpha = 1.0;
      break;
    }
    if (r > 24.0 && dot(p, v) > 0.0) break;
    float dt = clamp(0.07 * r, 0.03, 1.2);
    vec3 a = -1.5 * h2 * p / pow(r, 5.0);
    vec3 q = p + (v + a * dt) * dt;
    float s0 = dot(p, vN);
    float s1 = dot(q, vN);
    if (s0 * s1 < 0.0) {
      vec3 hp = mix(p, q, s0 / (s0 - s1));
      float hr = length(hp);
      if (hr > 2.9 && hr < 14.0) {
        float d = smoothstep(0.32, 0.9, gas(hp, hr, B)) * 1.2 + 0.08;
        float profile = pow(3.0 / hr, 2.0) * smoothstep(2.9, 3.6, hr) * (1.0 - smoothstep(9.0, 14.0, hr));
        // the gas moving toward us is boosted and bluer, the gas moving away dimmed and redder
        float beta = min(sqrt(0.5 / (hr - 1.0)), 0.7);
        float gam = 1.0 / sqrt(1.0 - beta * beta);
        float cosT = dot(normalize(cross(vN, hp)), -normalize(v));
        float g = sqrt(1.0 - 1.0 / hr) / (gam * (1.0 - beta * cosT));
        float I = profile * pow(d, 1.4) * min(pow(g, 3.0), 5.0) * 4.0;
        vec3 c = mix(vec3(1.0, 0.3, 0.04), vec3(1.0, 0.8, 0.5), clamp(I * 0.6, 0.0, 1.0));
        c = mix(c, vec3(0.85, 0.9, 1.0), clamp((g - 1.2) * 0.8, 0.0, 0.6));
        float ah = clamp(profile * d * 1.4, 0.0, 0.95);
        col += (1.0 - alpha) * c * I;
        alpha += (1.0 - alpha) * ah;
        if (alpha > 0.98) break;
      }
    }
    v = normalize(v + a * dt);
    p = q;
  }
  // light that skimmed the photon sphere at 1.5 before escaping piles up into a thin bright ring
  if (alpha < 1.0) {
    float ring = exp(-pow((minR - 1.55) / 0.12, 2.0));
    col += (1.0 - alpha) * vec3(1.0, 0.7, 0.4) * ring * 1.5;
    alpha += (1.0 - alpha) * ring * 0.8;
  }
  // soft tone curve, so the hot inner disk goes white instead of clipping
  col = 1.0 - exp(-col * 1.3);
  col *= alpha > 0.0 ? 1.0 : 0.0;
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;

/**
 * Sgr A* up close: a simulated accretion disk around a shadow of the real size, traced with gravitational
 * lensing, and the S-stars on their measured orbits. Everything sits in a group at Sgr A*'s position, so the
 * vertices stay small numbers that 32-bit floats hold exactly.
 */
export class SgrA {
  readonly group = new Group();
  readonly stars = S_STARS.map((s) => s.id);
  private readonly disk: ShaderMaterial;
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
  private lastDay = Number.NaN;
  readonly local: Vec[] = S_STARS.map(() => [0, 0, 0]);

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

    // the disk's axis: tipped from our line of sight toward DISK_TILT_PA on the sky
    const [north, east, away] = this.axes;
    const pa = DISK_TILT_PA * MathUtils.DEG2RAD;
    const inc = DISK_INCLINATION * MathUtils.DEG2RAD;
    const n = [0, 1, 2].map(
      (c) => -Math.cos(inc) * away[c] + Math.sin(inc) * (Math.cos(pa) * north[c] + Math.sin(pa) * east[c]),
    ) as Vec;
    const t = [
      n[1] * away[2] - n[2] * away[1],
      n[2] * away[0] - n[0] * away[2],
      n[0] * away[1] - n[1] * away[0],
    ];
    const tl = Math.hypot(...t);

    this.disk = new ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        size: { value: 1 },
        rs: { value: RS },
        clock: { value: new Vector2() },
        seeds: { value: new Vector2() },
        fade: { value: 0 },
        blur: { value: 0 },
        diskN: { value: n },
        diskT: { value: t.map((x) => x / tl) },
      },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    const half = QUAD_RS * RS;
    const quad = new Mesh(new PlaneGeometry(half * 2, half * 2), this.disk);
    quad.frustumCulled = false;
    this.group.add(quad);

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
  update(day: number, toCam: Vec, pxPerAu: number, trueSize: boolean) {
    const camDist = Math.hypot(...toCam);
    // grow the hole, rays and all, so it stays visible from far off unless true size is on
    const px = 5.2 * RS * pxPerAu;
    const grow = trueSize || px >= HOLE_MIN_PX ? 1 : HOLE_MIN_PX / Math.max(px, 1e-9);
    this.disk.uniforms.size.value = grow;
    this.disk.uniforms.rs.value = RS * grow;
    // the gas turns with the timeline, so it stands still while paused. Each of the two copies lives one
    // SHEAR_PERIOD and is shown most in the middle of its life, when it is half wound.
    const sec = day * 86400;
    const u = this.disk.uniforms;
    const t1 = sec / SHEAR_PERIOD;
    const t2 = t1 + 0.5;
    u.clock.value.set((t1 - Math.floor(t1) - 0.5) * SHEAR_PERIOD, (t2 - Math.floor(t2) - 0.5) * SHEAR_PERIOD);
    u.seeds.value.set((Math.floor(t1) % 97) * 7.3, (Math.floor(t2) % 97) * 7.3 + 3.1);
    u.fade.value = Math.abs(1 - 2 * (t1 - Math.floor(t1)));
    // how far the inner edge turns between frames
    const step = Number.isNaN(this.lastDay) ? 0 : Math.abs(day - this.lastDay) * 86400 * INNER_OMEGA;
    this.lastDay = day;
    u.blur.value = MathUtils.lerp(u.blur.value, MathUtils.smoothstep(step, 0.15, 1.2), 0.1);
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
