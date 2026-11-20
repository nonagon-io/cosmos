import {
  type Camera,
  Color,
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector2,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

const size = new Vector2();
const clear = new Color();

/**
 * Draws one layer of a scene at a fraction of the screen's resolution and lays it over the frame, scaled up.
 * For something soft and expensive per pixel, like the ray-traced disk around Sgr A*.
 */
export class LowResPass {
  private readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly overlay = new Scene();
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    // the target holds premultiplied colour, as the disk shader writes it
    const mat = new MeshBasicMaterial({
      map: this.target.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    this.overlay.add(new Mesh(new PlaneGeometry(2, 2), mat));
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, layer: number, scale: number) {
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.round(size.x * scale));
    const h = Math.max(1, Math.round(size.y * scale));
    if (this.target.width !== w || this.target.height !== h) {
      this.target.setSize(w, h);
    }
    renderer.getClearColor(clear);
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    const mask = camera.layers.mask;
    camera.layers.set(layer);
    renderer.render(scene, camera);
    camera.layers.mask = mask;
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    renderer.render(this.overlay, this.cam);
  }
}
