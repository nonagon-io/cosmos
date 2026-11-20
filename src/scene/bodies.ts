import {
  AdditiveBlending,
  type BufferAttribute,
  Color,
  DoubleSide,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';
import type { Axis } from '../astro/ephemeris';
import { KM_PER_AU } from '../astro/ephemeris';
import type { Body, Kind } from '../data/schema';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { dot, glow, texture } from './textures';

const OBLIQUITY = 23.4392911 * MathUtils.DEG2RAD;
const sphere = new SphereGeometry(1, 96, 64);

/** A unit sphere roughened with a few smooth bumps, for small bodies drawn from a shape model. */
function rockGeometry() {
  const g = new SphereGeometry(1, 64, 48);
  const pos = g.getAttribute('position') as BufferAttribute;
  const waves = [
    [3.1, 1.7, -2.3, 0.4, 0.07],
    [-1.4, 4.2, 2.6, 1.9, 0.05],
    [5.3, -2.8, 3.9, 2.7, 0.03],
    [-6.7, 5.1, -4.4, 0.8, 0.02],
    [9.2, 7.4, -8.1, 2.2, 0.012],
    [-11.3, -9.6, 12.7, 1.1, 0.008],
  ];
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    let r = 1;
    for (const [kx, ky, kz, ph, amp] of waves) {
      r += amp * Math.sin(kx * x + ky * y + kz * z + ph);
    }
    pos.setXYZ(i, x * r, y * r, z * r);
  }
  g.computeVertexNormals();
  return g;
}

// the tumbling body's spin axis leans this far off the axis it swings around
const TUMBLE_TILT = 0.6;
const qa = new Quaternion();
const qb = new Quaternion();
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

/** Marker size in px by kind; the dot shows where a body is when it is too small to see. */
export const MARKER_PX: Record<Kind, number> = {
  star: 10,
  planet: 8,
  dwarf: 6,
  moon: 5,
  asteroid: 4.5,
  comet: 4.5,
  interstellar: 5,
  spacecraft: 5,
};

// atmosphere rim: colour and strength
const RIM: Record<string, [string, number]> = {
  venus: ['#f3dca8', 0.7],
  earth: ['#7fb4ff', 0.9],
  mars: ['#e8a07a', 0.25],
  jupiter: ['#e6d3b8', 0.3],
  saturn: ['#eadbb5', 0.3],
  uranus: ['#bff2f5', 0.5],
  neptune: ['#8aa4ff', 0.5],
  titan: ['#e7b36a', 0.8],
  pluto: ['#c9d8f0', 0.2],
};

const planetVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const planetFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform sampler2D map;
uniform sampler2D nightMap;
uniform bool hasMap;
uniform bool hasNight;
uniform bool clouds;
uniform vec3 color;
uniform vec3 sunView;
uniform vec3 rimColor;
uniform float rimStrength;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  ${LOGDEPTH_FRAG}
  vec3 n = normalize(vNormal);
  vec3 l = normalize(sunView - vView);
  vec3 v = normalize(-vView);
  float ndl = dot(n, l);
  float lit = smoothstep(-0.04, 0.12, ndl) * max(ndl, 0.0) * 0.85 + smoothstep(-0.1, 0.2, ndl) * 0.15;
  vec4 tex = hasMap ? texture2D(map, vUv) : vec4(color, 1.0);
  vec3 c = tex.rgb * (lit + 0.015);
  if (hasNight) {
    vec3 city = texture2D(nightMap, vUv).rgb;
    c += city * vec3(1.0, 0.8, 0.55) * 0.9 * (1.0 - smoothstep(-0.18, 0.05, ndl));
  }
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * rimStrength * smoothstep(-0.25, 0.3, ndl);
  c += rimColor * rim;
  float alpha = 1.0;
  if (clouds) {
    alpha = tex.r * 0.9;
    c = vec3(1.0) * (lit + 0.01);
  }
  gl_FragColor = vec4(c, alpha);
  #include <colorspace_fragment>
}
`;

const sunFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  ${LOGDEPTH_FRAG}
  float mu = max(dot(normalize(vNormal), normalize(-vView)), 0.0);
  // limb darkening, Eddington approximation
  float limb = 0.4 + 0.6 * mu;
  vec3 c = texture2D(map, vUv).rgb * vec3(1.35, 1.15, 0.9) * limb + vec3(0.25, 0.14, 0.03) * limb;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const ringVert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
uniform float inner;
uniform float outer;
varying float vR;
varying vec3 vView;
void main() {
  vR = (length(position.xy) - inner) / (outer - inner);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const ringFrag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform sampler2D map;
uniform vec3 sunView;
uniform vec3 planetView;
uniform float planetRadius;
varying float vR;
varying vec3 vView;
void main() {
  ${LOGDEPTH_FRAG}
  vec4 t = texture2D(map, vec2(vR, 0.5));
  // the planet's shadow: does the ray towards the Sun pass through it?
  vec3 l = normalize(sunView - vView);
  vec3 oc = vView - planetView;
  float b = dot(oc, l);
  float c = dot(oc, oc) - planetRadius * planetRadius;
  float shade = (b < 0.0 && b * b - c > 0.0) ? 0.06 : 1.0;
  gl_FragColor = vec4(t.rgb * shade * 1.1, t.a * 0.95);
  #include <colorspace_fragment>
}
`;

const tmp = new Vector3();
const rot = new Matrix4();
const pole = new Matrix4();

/**
 * Rotation from a body's pole frame into the ecliptic, in the textured sphere's convention (y north,
 * longitude 0 on +x). The IAU gives the passive rotation Rz(W)·Rx(90°−δ)·Rz(90°+α) from ICRF to the body;
 * as active rotations of the body that is Rz(90°+α)·Rx(90°−δ)·Rz(W). The spin W is applied separately.
 */
export function poleMatrix(axis: Axis, out: Matrix4) {
  const ra = axis.ra * MathUtils.DEG2RAD;
  const dec = axis.dec * MathUtils.DEG2RAD;
  out.makeRotationX(-OBLIQUITY);
  out.multiply(rot.makeRotationZ(Math.PI / 2 + ra));
  out.multiply(rot.makeRotationX(Math.PI / 2 - dec));
  return out.multiply(rot.makeRotationX(Math.PI / 2));
}

/** Everything drawn for one body: the sphere at true size, the marker dot, rings and glow. */
export class BodyVisual {
  readonly group = new Group();
  readonly marker: Sprite;
  readonly radiusAu: number;
  private readonly tilt = new Group();
  private readonly spin = new Group();
  private readonly materials: ShaderMaterial[] = [];
  private readonly ring: Mesh | null = null;
  private readonly glare: Sprite | null = null;
  private readonly clouds: Mesh | null = null;
  markerAlpha = 1;

  constructor(readonly body: Body) {
    const axes = body.shape?.axes;
    this.radiusAu = (axes ? axes[0] : (body.radius ?? 0.001)) / KM_PER_AU;
    this.group.add(this.tilt);
    this.tilt.add(this.spin);

    if (body.kind !== 'spacecraft') {
      const mat = body.id === 'sun' ? this.sunMaterial() : this.planetMaterial(body);
      const mesh = new Mesh(axes ? rockGeometry() : sphere, mat);
      if (axes) {
        // the short axis is the spin axis, which is the sphere's y
        mesh.scale.set(axes[0] / KM_PER_AU, axes[2] / KM_PER_AU, axes[1] / KM_PER_AU);
      } else {
        mesh.scale.set(this.radiusAu, this.radiusAu * (1 - (body.flattening ?? 0)), this.radiusAu);
      }
      this.spin.add(mesh);
    }
    if (body.id === 'earth') {
      const mat = this.planetMaterial(body, texture('earth_clouds'));
      mat.uniforms.clouds.value = true;
      mat.transparent = true;
      mat.depthWrite = false;
      const c = new Mesh(sphere, mat);
      c.scale.setScalar(this.radiusAu * 1.006);
      this.tilt.add(c);
      this.clouds = c;
    }
    if (body.rings) {
      const { inner, outer } = body.rings;
      const geo = new RingGeometry(inner / KM_PER_AU, outer / KM_PER_AU, 256, 1);
      const mat = new ShaderMaterial({
        vertexShader: ringVert,
        fragmentShader: ringFrag,
        uniforms: {
          map: { value: texture(body.rings.texture) },
          inner: { value: inner / KM_PER_AU },
          outer: { value: outer / KM_PER_AU },
          sunView: { value: new Vector3() },
          planetView: { value: new Vector3() },
          planetRadius: { value: this.radiusAu },
        },
        transparent: true,
        side: DoubleSide,
        depthWrite: false,
      });
      const ring = new Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      this.materials.push(mat);
      this.tilt.add(ring);
      this.ring = ring;
    }
    if (body.id === 'sun') {
      const g = new Sprite(
        new SpriteMaterial({ map: glow(), blending: AdditiveBlending, depthWrite: false, transparent: true }),
      );
      this.group.add(g);
      this.glare = g;
    }
    this.marker = new Sprite(
      new SpriteMaterial({
        map: dot(),
        color: new Color(body.color),
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    this.marker.renderOrder = 2;
    this.group.add(this.marker);
  }

  private planetMaterial(body: Body, map?: Texture) {
    const rim = RIM[body.id] ?? ['#ffffff', 0];
    const tex =
      map ??
      (body.texture ? texture(body.texture, { center: body.textureCenter, unmapped: body.unmapped }) : null);
    const mat = new ShaderMaterial({
      vertexShader: planetVert,
      fragmentShader: planetFrag,
      uniforms: {
        map: { value: tex },
        nightMap: { value: body.id === 'earth' ? texture('earth_nightmap') : null },
        hasMap: { value: tex !== null },
        hasNight: { value: body.id === 'earth' && !map },
        clouds: { value: false },
        color: { value: new Color(body.color) },
        sunView: { value: new Vector3() },
        rimColor: { value: new Color(rim[0]) },
        rimStrength: { value: rim[1] },
      },
    });
    this.materials.push(mat);
    return mat;
  }

  private sunMaterial() {
    return new ShaderMaterial({
      vertexShader: planetVert,
      fragmentShader: sunFrag,
      uniforms: { map: { value: texture('sun') } },
    });
  }

  setOrientation(axis: Axis, day: number) {
    this.tilt.quaternion.setFromRotationMatrix(poleMatrix(axis, pole));
    // body z is the sphere's y, so the spin about the pole is a rotation about y
    const spin = axis.spin * MathUtils.DEG2RAD;
    const tumble = this.body.shape?.tumble;
    if (!tumble) {
      this.spin.rotation.y = spin;
      return;
    }
    // the spin axis leans off the pole and swings around it once per `tumble` hours
    const swing = (((day * 24) / tumble) % 1) * Math.PI * 2;
    this.spin.quaternion
      .setFromAxisAngle(Y, swing)
      .multiply(qa.setFromAxisAngle(X, TUMBLE_TILT))
      .multiply(qb.setFromAxisAngle(Y, spin));
  }

  /**
   * Per-frame sizing. `pxPerAu` is how many pixels one AU spans at the body's distance from the camera.
   * Returns the body's radius on screen in px.
   */
  update(
    sunView: Vector3,
    view: Matrix4,
    pxPerAu: number,
    camDist: number,
    markerScale: number,
    trueSize = false,
  ) {
    for (const m of this.materials) {
      m.uniforms.sunView.value.copy(sunView);
    }
    if (this.ring) {
      const u = (this.ring.material as ShaderMaterial).uniforms;
      u.planetView.value.copy(this.group.getWorldPosition(tmp).applyMatrix4(view));
    }
    const screenR = this.radiusAu * pxPerAu;
    // in true size the dot only stands in for a sphere too small to rasterise: its bright core is about a pixel
    const px = trueSize ? 1.5 : MARKER_PX[this.body.kind] * markerScale;
    // the dot fades out once the sphere itself is bigger than it
    const target = screenR > (trueSize ? 1 : px * 0.6) ? 0 : 1;
    this.markerAlpha += (target - this.markerAlpha) * 0.25;
    const mm = this.marker.material as SpriteMaterial;
    mm.opacity = this.markerAlpha * (this.body.kind === 'spacecraft' ? 1 : 0.95);
    this.marker.visible = this.markerAlpha > 0.02;
    this.marker.scale.setScalar((px * 2) / pxPerAu);
    if (this.glare) {
      // glare at least a bright star's size, and never smaller than a few solar radii
      let glarePx = trueSize
        ? Math.max(screenR * 7, 2)
        : Math.max(screenR * 7, Math.min(90, 26 + 8 * Math.log10(1 + 1 / Math.max(camDist, 1e-9))));
      // light years out, the Sun is one star among many
      const far = MathUtils.smoothstep(Math.log10(camDist), 5.5, 7);
      glarePx = glarePx * (1 - far) + Math.max(screenR * 7, 7) * far;
      this.glare.scale.setScalar((glarePx * 2) / pxPerAu);
      // and millions of light years out it would only hide the Galaxy it is in
      (this.glare.material as SpriteMaterial).opacity =
        1 - MathUtils.smoothstep(Math.log10(camDist), 10.5, 11.2);
      this.marker.visible = false;
    }
    return screenR;
  }

  /** Clouds drift slowly against the surface. */
  setCloudDrift(day: number) {
    if (this.clouds) {
      this.clouds.rotation.y = -(day * 2.1) % (Math.PI * 2);
    }
  }
}
