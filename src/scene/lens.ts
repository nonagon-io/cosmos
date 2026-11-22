import {
  FramebufferTexture,
  LinearFilter,
  MathUtils,
  Mesh,
  OrthographicCamera,
  type PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';

const size = new Vector2();

// Each pixel's ray is followed back past the hole and the frame is read where the bent ray points. Lengths are
// in Schwarzschild radii, the hole at the origin. Close in the ray is stepped as in the disk shader (sgra.ts);
// further out, and for the legs before and after the stepped part, the bend of a straight line past a mass
// is added up in closed form: (Rs / b)(s1 / r1 - s0 / r0) between points s0 and s1 along it.
const frag = /* glsl */ `
uniform sampler2D map;
uniform vec3 center;
uniform float rs;
// tan of half the field of view, across and up: the camera's near and far planes are too far apart for its
// projection matrix to be inverted in 32-bit floats
uniform vec2 halfTan;
uniform vec2 texel;
varying vec2 vUv;

// turns v toward the hole by the bend a straight line from s0 to s1 would pick up
vec3 bend(vec3 p, vec3 v, float s0, float s1) {
  vec3 perp = p - dot(p, v) * v;
  float b = length(perp);
  float a = (s1 / sqrt(b * b + s1 * s1) - s0 / sqrt(b * b + s0 * s0)) / b;
  return normalize(v - perp / b * a);
}

void main() {
  vec3 d = normalize(vec3((vUv * 2.0 - 1.0) * halfTan, -1.0));
  vec3 cam = -center / rs;
  float tc = dot(-cam, d);
  float b = length(cam + d * tc);
  vec3 v;
  if (b < 20.0 && tc > 0.0) {
    float lead = min(tc, 22.0);
    vec3 p = cam + d * (tc - lead);
    v = bend(cam, d, -tc, -lead);
    vec3 l = cross(p, v);
    float h2 = dot(l, l);
    for (int i = 0; i < 260; i++) {
      float r = length(p);
      if (r < 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      if (r > 24.0 && dot(p, v) > 0.0) break;
      float dt = clamp(0.07 * r, 0.03, 1.2);
      vec3 a = -1.5 * h2 * p / pow(r, 5.0);
      p += (v + a * dt) * dt;
      v = normalize(v + a * dt);
    }
    v = bend(p, v, dot(p, v), 1e9);
  } else {
    // b from the camera's own leg on, plus the next order of the full bend, so there is no seam at b = 20
    v = bend(cam, d, -tc, 1e9);
    float full = 1.0 - smoothstep(-0.5, 1.0, -tc / max(length(cam), 1e-6));
    vec3 perp = cam + d * tc;
    v = normalize(v - normalize(perp) * full * 2.9452 / (b * b));
  }
  // bent round behind the camera: nothing on screen to show there
  if (v.z > -1e-4) {
    gl_FragColor = vec4(0.008, 0.012, 0.031, 1.0);
    return;
  }
  vec2 uv = v.xy / -v.z / halfTan * 0.5 + 0.5;
  if (length((uv - vUv) / texel) < 0.25) discard;
  // past the edge of the frame there is nothing to read either; fade to the sky's colour
  vec2 out2 = max(max(-uv, uv - 1.0), 0.0);
  float edge = smoothstep(0.0, 0.04, max(out2.x, out2.y));
  vec3 c = texture2D(map, clamp(uv, texel * 0.5, 1.0 - texel * 0.5)).rgb;
  gl_FragColor = vec4(mix(c, vec3(0.008, 0.012, 0.031), edge), 1.0);
}
`;

/**
 * Bends the finished frame around a black hole: everything already drawn is read back and drawn again where
 * light passing the hole would show it, so stars behind it smear into arcs, show twice, or ring it. The frame
 * only holds what is on screen, so light bent round from off screen or from behind the camera can't be shown.
 */
export class LensPass {
  private tex = new FramebufferTexture(1, 1);
  private readonly mat: ShaderMaterial;
  private readonly overlay = new Scene();
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.mat = new ShaderMaterial({
      uniforms: {
        map: { value: this.tex },
        center: { value: new Vector3() },
        rs: { value: 1 },
        halfTan: { value: new Vector2() },
        texel: { value: new Vector2() },
      },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
    });
    this.overlay.add(new Mesh(new PlaneGeometry(2, 2), this.mat));
  }

  /** `center` is the hole in view space, in the same units as `rs`. */
  render(renderer: WebGLRenderer, camera: PerspectiveCamera, center: Vector3, rs: number) {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    if (this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex.dispose();
      this.tex = new FramebufferTexture(w, h);
      this.tex.minFilter = LinearFilter;
      this.tex.magFilter = LinearFilter;
      this.mat.uniforms.map.value = this.tex;
    }
    renderer.copyFramebufferToTexture(this.tex);
    const u = this.mat.uniforms;
    u.center.value.copy(center);
    u.rs.value = rs;
    const tan = Math.tan(MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
    u.halfTan.value.set(tan * camera.aspect, tan);
    u.texel.value.set(1 / w, 1 / h);
    renderer.render(this.overlay, this.cam);
  }
}
