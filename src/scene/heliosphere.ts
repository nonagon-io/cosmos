import {
  AdditiveBlending,
  Color,
  FrontSide,
  type Group,
  MathUtils,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { LOGDEPTH_FRAG, LOGDEPTH_FRAG_PARS, LOGDEPTH_VERT, LOGDEPTH_VERT_PARS } from './glsl';

const vert = /* glsl */ `
${LOGDEPTH_VERT_PARS}
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
  ${LOGDEPTH_VERT}
}
`;

const frag = /* glsl */ `
${LOGDEPTH_FRAG_PARS}
uniform vec3 color;
uniform float opacity;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  ${LOGDEPTH_FRAG}
  float f = 1.0 - abs(dot(normalize(vNormal), normalize(-vView)));
  gl_FragColor = vec4(color, pow(f, 2.5) * opacity);
  #include <colorspace_fragment>
}
`;

/**
 * The termination shock (94 AU) and heliopause (121 AU) where Voyager 1 crossed them. The real heliosphere is
 * blunt towards the interstellar wind and trails away from it; spheres are the honest simple version.
 */
export class Heliosphere {
  private readonly shells: { mesh: Mesh; mat: ShaderMaterial; base: number }[] = [];

  constructor(parent: Group) {
    const geo = new SphereGeometry(1, 96, 64);
    for (const [r, color, base] of [
      [94, '#6f8fd8', 0.22],
      [121, '#86a8ff', 0.4],
    ] as const) {
      const mat = new ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { color: { value: new Color(color) }, opacity: { value: base } },
        transparent: true,
        depthWrite: false,
        side: FrontSide,
        blending: AdditiveBlending,
      });
      const mesh = new Mesh(geo, mat);
      mesh.scale.setScalar(r);
      parent.add(mesh);
      this.shells.push({ mesh, mat, base });
    }
  }

  update(visible: boolean, camDist: number) {
    // from inside, the rim effect turns into a fog; show it only once the camera is well outside
    const k =
      MathUtils.smoothstep(Math.log10(camDist), 2.25, 2.6) *
      (1 - MathUtils.smoothstep(Math.log10(camDist), 4.3, 5));
    for (const s of this.shells) {
      s.mesh.visible = visible && k > 0.01;
      s.mat.uniforms.opacity.value = s.base * k;
    }
  }
}
