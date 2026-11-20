import {
  BackSide,
  FrontSide,
  Group,
  LinearFilter,
  MathUtils,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  TextureLoader,
} from 'three';
import type { Vec } from '../astro/kepler';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';
import { AU_PER_LY } from './stars';

/**
 * Comoving distance to the surface of last scattering at z = 1090, for the same flat universe the galaxies are
 * placed in (H0 = 75, Ωm = 0.3), about 41 billion light years.
 */
export const CMB_AU = 2.62e15;
// light years from the Sun over which it fades in, past the farthest galaxies
const FADE_FROM = 1.2e10;
const FADE_TO = 3e10;

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH_VERT}
}
`;

// grey is temperature from -400 to +400 µK; coloured on the usual Planck ramp, cold blue to hot red
const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform sampler2D map;
uniform float opacity;
varying vec3 vDir;
void main() {
  ${LOGDEPTH_FRAG}
  vec3 d = normalize(vDir);
  vec2 uv = vec2(fract(atan(d.y, d.x) / 6.28318531), 0.5 + asin(d.z) / 3.14159265);
  float t = texture2D(map, uv).r * 2.0 - 1.0;
  vec3 cold = mix(vec3(0.98, 0.94, 0.82), vec3(0.0, 0.4, 0.85), smoothstep(0.0, 0.45, -t));
  cold = mix(cold, vec3(0.02, 0.05, 0.35), smoothstep(0.45, 1.0, -t));
  vec3 hot = mix(vec3(0.98, 0.94, 0.82), vec3(1.0, 0.55, 0.1), smoothstep(0.0, 0.45, t));
  hot = mix(hot, vec3(0.65, 0.05, 0.02), smoothstep(0.45, 1.0, t));
  gl_FragColor = vec4(t < 0.0 ? cold : hot, opacity);
  #include <colorspace_fragment>
}
`;

/**
 * The cosmic microwave background as Planck mapped it, on a sphere at the distance its light comes from: the
 * edge of what can be seen at all. Inside it shows as the sky around; from outside, as a ball.
 */
export class Cmb {
  private readonly group = new Group();
  // the inside of the shell, which is the sky from within and the far side from without
  private readonly back: ShaderMaterial;
  // the outside, the near side once the camera has left: it fades in only well clear of the shell
  private readonly front: ShaderMaterial;
  private tex: Texture | null = null;

  constructor(
    parent: Group,
    private readonly url: string,
  ) {
    const geo = new SphereGeometry(CMB_AU, 128, 64);
    const make = (side: typeof BackSide | typeof FrontSide, order: number) => {
      const mat = new ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { map: { value: null }, opacity: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side,
      });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.group.add(mesh);
      return mat;
    };
    this.back = make(BackSide, -11);
    this.front = make(FrontSide, -10);
    this.group.visible = false;
    parent.add(this.group);
  }

  setTime(shift: Vec) {
    this.group.position.set(-shift[0], -shift[1], -shift[2]);
  }

  /** `sunDist` is the camera's distance from the Sun in AU. */
  update(sunDist: number) {
    const k = MathUtils.smoothstep(
      Math.log10(sunDist / AU_PER_LY),
      Math.log10(FADE_FROM),
      Math.log10(FADE_TO),
    );
    const r = sunDist / CMB_AU;
    // from within it is a map laid over a sky the eye would see dark: barely there among the galaxies, and
    // brought up only over the last stretch to the shell
    this.back.uniforms.opacity.value = k * MathUtils.lerp(0.04, 0.35, MathUtils.smoothstep(r, 0.8, 1));
    this.front.uniforms.opacity.value = k * 0.28 * MathUtils.smoothstep(r, 1.15, 2);
    // fetched only once someone comes out this far, and shown once it is in
    if (k > 0.01 && !this.tex) {
      this.tex = new TextureLoader().load(this.url, () => {
        this.back.uniforms.map.value = this.tex;
        this.front.uniforms.map.value = this.tex;
      });
      // the longitude wraps at the seam, where mipmaps would draw a line
      this.tex.generateMipmaps = false;
      this.tex.minFilter = LinearFilter;
    }
    this.group.visible = k > 0.01 && this.back.uniforms.map.value !== null;
  }
}
