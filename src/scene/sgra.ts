import {
  AdditiveBlending,
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
  Vector3,
} from 'three';
import { orient, solveKepler, type Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { rng } from './particles';
import { dot } from './textures';

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

// The stars round it, drawn on circular orbits at the speed its mass gives them
const clusterVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
attribute vec3 aAxis;
attribute float aOmega;
attribute vec3 aColor;
attribute float aSize;
attribute float aFar;
attribute float aPick;
uniform float ppa;
uniform float year;
uniform float dist;
uniform vec2 full;
uniform float boost;
uniform float pr;
uniform vec3 cam;
uniform vec3 gpole;
uniform float dust;
varying vec3 vColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1) * 17.0;
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
float clouds(vec3 x) {
  float v = 0.0;
  float a = 0.5;
  for (int k = 0; k < 4; k++) {
    v += a * noise(x);
    x = x * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

// Visual extinction in magnitudes between the camera and a star, both in pc from Sgr A*. The dust is a layer
// along the Galactic plane, thinning as exp(-|z|/H), cut off at the disk's edge and broken into clouds
const float H = 100.0;
const float EDGE = 15000.0;
float extinction(vec3 s) {
  vec3 d = s - cam;
  float len = length(d);
  vec3 u = d / len;
  float b = dot(cam, u);
  float c = dot(cam, cam) - EDGE * EDGE;
  float disc = b * b - c;
  if (disc <= 0.0) return 0.0;
  float t0 = max(0.0, -b - sqrt(disc));
  if (t0 >= len) return 0.0;
  len -= t0;
  vec3 a = cam + u * t0;
  float z0 = dot(a, gpole);
  float z1 = dot(s, gpole);
  float dz = z1 - z0;
  // z runs straight along the path, so the integral of exp(-|z|/H) has a closed form
  float path = abs(dz) < 0.01 * H
    ? len * exp(-abs(z0 + z1) * 0.5 / H)
    : len * (sign(z1) * (1.0 - exp(-abs(z1) / H)) - sign(z0) * (1.0 - exp(-abs(z0) / H))) * H / dz;
  // clouds at about 1 and 3 kpc along the line of sight, where most of the dust toward the centre is
  float lumps = 0.5 * (clouds((a + u * min(len, 1000.0)) / 90.0) + clouds((a + u * min(len, 3000.0)) / 150.0));
  return dust * path * (0.3 + 2.2 * smoothstep(0.3, 0.7, lumps));
}

void main() {
  float th = aOmega * year;
  vec3 v = position;
  vec3 p = v * cos(th) + cross(aAxis, v) * sin(th) + aAxis * dot(aAxis, v) * (1.0 - cos(th));
  // the stars crowd toward the middle as r^-2, so on screen the middle piles thousands onto each pixel; past
  // about one a pixel, keep only a share there, brighter
  float rpx = length(position) * ppa;
  float keep = clamp(rpx * rpx / 3000.0, 0.002, 1.0);
  if (aPick > keep) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_PointSize = aSize * pr;
  // from further than 'full' away the stars crowd closer on screen as 1/d^2, so each is dimmed as much: the cluster
  // and the bulge keep the same surface brightness as the camera comes in, a bright speck growing until it
  // breaks up into stars, as a real one would
  float f = mix(full.x, full.y, aFar) / dist;
  // dust reddens as it dims: blue is lost about 1.3 times as fast as visual, red at 0.75
  float av = extinction(p / 206265.0);
  vec3 dim = pow(vec3(10.0), -0.4 * av * vec3(0.75, 1.0, 1.3));
  vColor = aColor * dim * min(1.0, f * f) * boost / keep;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  ${LOGDEPTH_VERT}
}
`;
const clusterFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
varying vec3 vColor;
void main() {
  ${LOGDEPTH_FRAG}
  float d = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(vColor, 1.0 - smoothstep(0.35, 1.0, d));
  #include <colorspace_fragment>
}
`;

// 4.3 million suns: a circular orbit of `a` AU takes sqrt(a³ / M) years
const M_SUNS = 4.3e6;
const AU_PER_PC = 206265;
const BULGE_AU = 1500 * AU_PER_PC;
const BAR_GLOW = 5;
// how near, in AU, the cluster's and the bulge's stars are drawn at full brightness (see clusterVert)
const FULL_CLUSTER = 2500 * 63241;
const FULL_BULGE = 2500 * 63241;

/**
 * Sgr A* up close: a simulated accretion disk around a shadow of the real size, traced with gravitational
 * lensing, and the S-stars on their measured orbits. Everything sits in a group at Sgr A*'s position, so the
 * vertices stay small numbers that 32-bit floats hold exactly.
 */
export class SgrA {
  readonly group = new Group();
  readonly stars = S_STARS.map((s) => s.id);
  private readonly disk: ShaderMaterial;
  /** The billboard the disk is traced on. */
  readonly quad: Mesh;
  private readonly loops: LineLoop[] = [];
  private readonly orbitMat = new LineBasicMaterial({
    color: '#9d8cff',
    transparent: true,
    depthWrite: false,
  });
  private readonly points: Points;
  private readonly cluster: Points;
  private clusterCount = 0;
  /** Close enough for the disk, the S-stars and their orbits to show. */
  close = false;
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
    this.quad = new Mesh(new PlaneGeometry(half * 2, half * 2), this.disk);
    this.quad.frustumCulled = false;
    // the shadow is black and opaque: drawn after everything else, so nothing behind it shows through. Only
    // the camera could be nearer to it than the stars and the Galaxy are.
    this.quad.renderOrder = 1000;
    this.group.add(this.quad);

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
      this.loops.push(loop);
    }

    this.starPos = new Float32Array(S_STARS.length * 3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.starPos, 3));
    this.points = new Points(
      g,
      new PointsMaterial({
        color: new Color('#cfe0ff'),
        map: dot(),
        size: 8,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.cluster = this.makeCluster();
    this.group.add(this.cluster);
  }

  /**
   * The nuclear star cluster, as a model: a few tens of thousands of its brightest stars, mostly old red giants,
   * thicker toward the middle as measured (density falling as r^-1.5), on circular orbits tilted every way. The
   * young blue stars between 0.04 and 0.5 pc share one disk turning clockwise on our sky, tilted as measured
   * (i 130°, Ω 96°; Yelda 2014). No one star here is in its real place, unlike the S-stars.
   */
  private makeCluster() {
    const rand = rng(4300000);
    const pos: number[] = [];
    const axis: number[] = [];
    const omega: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    const [an, ae, az] = this.axes;
    const sky = (v: Vec): Vec => [0, 1, 2].map((c) => v[0] * an[c] + v[1] * ae[c] + v[2] * az[c]) as Vec;
    const far: number[] = [];
    const add = (p: Vec, ax: Vec, c: Color, s: number, bulge = 0) => {
      const r = Math.hypot(...p);
      pos.push(...p);
      axis.push(...ax);
      // the bulge's stars take hundreds of thousands of years or more to go round: still, at any speed here
      omega.push(bulge ? 0 : (2 * Math.PI) / Math.sqrt(r ** 3 / M_SUNS));
      col.push(c.r, c.g, c.b);
      size.push(s);
      far.push(bulge);
    };
    const unit = (): Vec => {
      const z = rand() * 2 - 1;
      const a = rand() * 2 * Math.PI;
      const k = Math.sqrt(1 - z * z);
      return [k * Math.cos(a), k * Math.sin(a), z];
    };
    const cross = (a: Vec, b: Vec): Vec => {
      const c: Vec = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const l = Math.hypot(...c);
      return [c[0] / l, c[1] / l, c[2] / l];
    };
    const giant = new Color('#ffb27a');
    const yellow = new Color('#fff0d8');
    const blue = new Color('#a9c6ff');
    const rMax = 2 * AU_PER_PC;
    for (let n = 0; n < 30000; ) {
      const r = rMax * rand() ** (2 / 3);
      if (r < 1500) {
        continue;
      }
      n++;
      const d = unit();
      const bright = rand() < 0.04;
      add(
        [d[0] * r, d[1] * r, d[2] * r],
        cross(d, unit()),
        (rand() < 0.85 ? giant : yellow).clone().multiplyScalar(bright ? 1 : 0.45 + rand() * 0.35),
        bright ? 3 : 1.6,
      );
    }
    // and on out through the bulge to about 1.5 kpc, as one population thinning as r^-2, so it shows no edge:
    // the Galaxy model has too few points to fill the sky from in here. Flattened to the Galactic plane about
    // 2:1 beyond the cluster, old orange and yellow stars
    const ra = 192.8595 * MathUtils.DEG2RAD;
    const de = 27.1283 * MathUtils.DEG2RAD;
    const eq = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)];
    const pole: Vec = [
      eq[0],
      eq[1] * Math.cos(OBLIQUITY) + eq[2] * Math.sin(OBLIQUITY),
      -eq[1] * Math.sin(OBLIQUITY) + eq[2] * Math.cos(OBLIQUITY),
    ];
    for (let i = 0; i < 130000; i++) {
      const r = 2 * AU_PER_PC * (1500 / 2) ** rand();
      const d = unit();
      const h = d[0] * pole[0] + d[1] * pole[1] + d[2] * pole[2];
      const flat = 0.5 * MathUtils.smoothstep(r, 20 * AU_PER_PC, 200 * AU_PER_PC);
      const p: Vec = [0, 1, 2].map((c) => (d[c] - flat * h * pole[c]) * r) as Vec;
      const inner = r < 60 * AU_PER_PC;
      add(
        p,
        inner ? cross(d, unit()) : pole,
        (rand() < 0.75 ? giant : yellow).clone().multiplyScalar(0.3 + rand() * 0.45),
        rand() < 0.03 ? 2.6 : 1.5,
        inner ? 0 : 1,
      );
    }
    // the bar most of the bulge's light comes from, about 1.5 kpc long and a few hundred pc thick, its near end
    // toward positive longitude about 27 degrees off our line of sight (after Dwek 1995 and Wegg & Gerhard
    // 2013). Seen from the Sun it stands some 5 degrees either side of the plane, out of the worst of the dust
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const away = this.axes[2];
    const ah = away[0] * pole[0] + away[1] * pole[1] + away[2] * pole[2];
    // toward the Sun in the plane, and toward longitude 90
    const l90 = cross([0, 1, 2].map((c) => -(away[c] - ah * pole[c])) as Vec, pole);
    const toSun = cross(pole, l90);
    const tilt = 27 * MathUtils.DEG2RAD;
    const long: Vec = [0, 1, 2].map((c) => Math.cos(tilt) * toSun[c] + Math.sin(tilt) * l90[c]) as Vec;
    const wide = cross(pole, long);
    for (let i = 0; i < 150000; i++) {
      const [x, y, z] = [gauss() * 1100, gauss() * 420, gauss() * 300].map((v) => v * AU_PER_PC);
      add(
        [0, 1, 2].map((c) => x * long[c] + y * wide[c] + z * pole[c]) as Vec,
        pole,
        (rand() < 0.75 ? giant : yellow).clone().multiplyScalar(BAR_GLOW * (0.3 + rand() * 0.45)),
        rand() < 0.03 ? 2.6 : 1.5,
        1,
      );
    }
    // the disk's plane on the sky, from two directions in it
    const u = sky(orient(1, 0, 130 * MathUtils.DEG2RAD, 96 * MathUtils.DEG2RAD, 0));
    const w = sky(orient(0, 1, 130 * MathUtils.DEG2RAD, 96 * MathUtils.DEG2RAD, 0));
    const normal = cross(u, w);
    for (let i = 0; i < 120; i++) {
      const r = 0.04 * AU_PER_PC * (0.5 / 0.04) ** rand();
      const a = rand() * 2 * Math.PI;
      const h = (rand() - 0.5) * 0.15 * r;
      const p: Vec = [0, 1, 2].map(
        (c) => r * (Math.cos(a) * u[c] + Math.sin(a) * w[c]) + h * normal[c],
      ) as Vec;
      add(p, normal, blue, 3.5);
    }
    // shuffled, so any leading share of the stars is a fair sample of all of them (see update)
    const n = size.length;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const pick = (a: number[], k: number) => {
      const out = new Float32Array(n * k);
      for (const [to, from] of order.entries()) {
        for (let c = 0; c < k; c++) {
          out[to * k + c] = a[from * k + c];
        }
      }
      return out;
    };
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pick(pos, 3), 3));
    g.setAttribute('aAxis', new BufferAttribute(pick(axis, 3), 3));
    g.setAttribute('aOmega', new BufferAttribute(pick(omega, 1), 1));
    g.setAttribute('aColor', new BufferAttribute(pick(col, 3), 3));
    g.setAttribute('aSize', new BufferAttribute(pick(size, 1), 1));
    g.setAttribute('aFar', new BufferAttribute(pick(far, 1), 1));
    g.setAttribute(
      'aPick',
      new BufferAttribute(
        Float32Array.from({ length: n }, () => rand()),
        1,
      ),
    );
    this.clusterCount = n;
    const pts = new Points(
      g,
      new ShaderMaterial({
        vertexShader: clusterVert,
        fragmentShader: clusterFrag,
        uniforms: {
          year: { value: 0 },
          dist: { value: 1 },
          boost: { value: 1 },
          ppa: { value: 1 },
          full: { value: new Vector2(FULL_CLUSTER, FULL_BULGE) },
          pr: { value: 1 },
          cam: { value: new Vector3() },
          gpole: { value: new Vector3(...pole) },
          // magnitudes per parsec in the plane
          dust: { value: 0.0015 },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    pts.frustumCulled = false;
    return pts;
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
  update(day: number, toCam: Vec, pxPerAu: number, trueSize: boolean, orbits: boolean, pr = 1) {
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
    this.close = near > 0.001;
    this.orbitMat.opacity = 0.45 * near;
    for (const l of this.loops) {
      l.visible = orbits && this.close;
    }
    (this.points.material as PointsMaterial).opacity = near;
    this.points.visible = this.close;
    this.quad.visible = this.close;
    const cu = (this.cluster.material as ShaderMaterial).uniforms;
    cu.year.value = day / 365.25;
    cu.dist.value = camDist;
    cu.pr.value = pr;
    cu.cam.value.set(toCam[0] / AU_PER_PC, toCam[1] / AU_PER_PC, toCam[2] / AU_PER_PC);
    // once the whole bulge is under a pixel the Galaxy model's own is all there is to see. Smaller than the
    // screen, it needs only so many stars, drawn brighter: all of them piled onto a few pixels stall the GPU
    const across = 2 * BULGE_AU * pxPerAu * pr;
    this.group.visible = across > 1;
    const k = Math.max(1, Math.min(this.clusterCount, Math.ceil(across * across * 0.3)));
    this.cluster.geometry.setDrawRange(0, k);
    cu.boost.value = this.clusterCount / k;
    cu.ppa.value = pxPerAu * pr;
  }

  /**
   * The way to look at the hole to see its disk nearly edge on, as in the film pictures: the camera a little
   * above the plane, the disk rising to the right on screen, and the gas coming toward us, which is brightest,
   * on the right. Returns the look direction and the turn of the picture about it that does that.
   */
  diskLook(): { look: Vec; roll: number } {
    const n = this.disk.uniforms.diskN.value as Vec;
    const cross = (x: Vec, y: Vec): Vec => [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
    const norm = (v: Vec): Vec => {
      const l = Math.hypot(...v);
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const dotp = (x: Vec, y: Vec) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
    const p = norm(cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
    const q = cross(n, p);
    const up = 9 * MathUtils.DEG2RAD;
    const want = -24 * MathUtils.DEG2RAD;
    let best = { look: [-n[0], -n[1], -n[2]] as Vec, roll: 0 };
    let cost = Number.POSITIVE_INFINITY;
    // which side of the disk the camera is on decides which way the gas goes round as seen; only one side puts
    // the gas coming toward us on the right
    for (const side of [1, -1]) {
      const m: Vec = [n[0] * side, n[1] * side, n[2] * side];
      for (let deg = 0; deg < 360; deg += 2) {
        const f = deg * MathUtils.DEG2RAD;
        const c = [0, 1, 2].map(
          (k) => Math.cos(up) * (Math.cos(f) * p[k] + Math.sin(f) * q[k]) + Math.sin(up) * m[k],
        ) as Vec;
        const look: Vec = [-c[0], -c[1], -c[2]];
        const right = norm(cross(look, [0, 0, 1]));
        const screenUp = cross(right, look);
        // the axis on the camera's side, on screen, as an angle from up toward right; a turn of the camera by
        // `roll` adds to it
        const tilt = Math.atan2(dotp(m, right), dotp(m, screenUp));
        const roll = Math.atan2(Math.sin(want - tilt), Math.cos(want - tilt));
        const r2 = [0, 1, 2].map((k) => right[k] * Math.cos(roll) + screenUp[k] * Math.sin(roll)) as Vec;
        // gas on the right of the hole moves along n × right; toward the camera is along c
        const toward = dotp(cross(n, r2), c) > 0;
        // as level a camera as can be, so dragging round from there feels natural
        const k = Math.abs(look[2]) + Math.abs(roll) * 0.3 + (toward ? 0 : 10);
        if (k < cost) {
          cost = k;
          best = { look, roll };
        }
      }
    }
    return best;
  }

  /** Width on screen of the quad the disk is traced on, given the scale at Sgr A*. */
  quadPx(pxPerAu: number) {
    return 2 * QUAD_RS * this.disk.uniforms.rs.value * pxPerAu;
  }

  /** Ecliptic position of star `k` in the scene, for labels. */
  positionOf(k: number): Vec {
    const p = this.group.position;
    const l = this.local[k];
    return [p.x + l[0], p.y + l[1], p.z + l[2]];
  }
}
