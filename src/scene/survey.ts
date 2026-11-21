import { AdditiveBlending, BufferAttribute, BufferGeometry, Group, Points, ShaderMaterial } from 'three';
import type { Vec } from '../astro/kepler';
import { Cosmicflows, POINT_FRAG, POINT_VERT, SEEN, WEB_LAYER } from './cosmicflows';
import { AU_PER_LY, eclipticDir } from './stars';

const AU_PER_MPC = 3.26156e6 * AU_PER_LY;
// the brightness one point gets with this many loaded; more share it, so the picture fills in rather than flares
const REF_COUNT = 100000;
// what the GPU starts out allowed to draw, and the floor it can be cut to on a slow machine
const BUDGET = 3e6;
const MIN_BUDGET = 150000;

export type SurveyName = 'sdss' | 'desi' | 'quaia';

export interface SurveyManifest {
  files: number;
  count: number;
  unit: number;
}

/**
 * The galaxies of a big redshift survey (SDSS, DESI), loaded a file at a time into one buffer sized for all of them. The files are slices of
 * one random order, so whatever has arrived is an even sample of the whole, and so is any prefix of it: a slow
 * machine draws fewer.
 */
export class Survey {
  private fade = 1;
  private readonly group = new Group();
  private readonly mat: ShaderMaterial;
  private readonly geo = new BufferGeometry();
  private readonly pos: BufferAttribute;
  private loaded = 0;
  // eases toward `loaded`, for both how many are drawn and how bright each is
  private shown = 0;
  private budget = BUDGET;

  constructor(
    parent: Group,
    readonly name: SurveyName,
    private readonly manifest: SurveyManifest,
  ) {
    this.pos = new BufferAttribute(new Float32Array(manifest.count * 3), 3);
    this.geo.setAttribute('position', this.pos);
    this.geo.setDrawRange(0, 0);
    this.mat = new ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        size: { value: 2 },
        opacity: { value: 0 },
        zoom: SEEN.zoom,
        reach: SEEN.reach,
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const points = new Points(this.geo, this.mat);
    points.frustumCulled = false;
    points.layers.set(WEB_LAYER);
    this.group.add(points);
    this.group.visible = false;
    parent.add(this.group);
  }

  get files() {
    return this.manifest.files;
  }

  /** Adds the next file's galaxies, as fetched: uint16 RA, Dec and distance per galaxy. */
  add(data: Uint16Array) {
    const a = this.pos.array as Float32Array;
    const start = this.loaded;
    const n = Math.min(data.length / 3, this.manifest.count - start);
    for (let i = 0; i < n; i++) {
      const ra = (data[i * 3] / 65535) * 360;
      const dec = (data[i * 3 + 1] / 65535) * 180 - 90;
      const r = data[i * 3 + 2] * this.manifest.unit * AU_PER_MPC;
      const d = eclipticDir(ra, dec);
      a[(start + i) * 3] = d[0] * r;
      a[(start + i) * 3 + 1] = d[1] * r;
      a[(start + i) * 3 + 2] = d[2] * r;
    }
    this.pos.addUpdateRange(start * 3, n * 3);
    this.pos.needsUpdate = true;
    this.loaded += n;
  }

  get visible() {
    return this.group.visible;
  }

  /**
   * Back on the universe's timeline: `a` is its size then against now, which every distance out here scales
   * with, and `fade` how much of today's galaxies to show, fewer when it was young.
   */
  setExpansion(a: number, fade: number) {
    this.group.scale.setScalar(a);
    this.fade = fade;
  }

  setTime(shift: Vec) {
    this.group.position.set(-shift[0], -shift[1], -shift[2]);
  }

  update(sunDist: number, pixelRatio: number, dt: number, frameMs: number, on: boolean) {
    const k = Cosmicflows.presence(sunDist);
    this.group.visible = on && k > 0.01 && this.loaded > 0;
    if (!this.group.visible) {
      return;
    }
    // only blame these for slow frames while there are enough of them on screen to be the cause
    if (this.shown > MIN_BUDGET) {
      if (frameMs > 22) {
        this.budget = Math.max(MIN_BUDGET, this.budget * 0.97);
      } else if (frameMs < 18) {
        this.budget = Math.min(BUDGET, this.budget * 1.01);
      }
    }
    const target = Math.min(this.loaded, this.budget);
    // a new file fades in over a second or so instead of landing all at once
    this.shown += (target - this.shown) * Math.min(1, dt * 2.5);
    if (Math.abs(target - this.shown) < 1) {
      this.shown = target;
    }
    this.geo.setDrawRange(0, Math.round(this.shown));
    // spread the light over however many are drawn, a little less than evenly so more reads as more detail
    const share = (REF_COUNT / Math.max(this.shown, REF_COUNT)) ** 0.4;
    this.mat.uniforms.opacity.value = 0.6 * k * share * this.fade;
    this.mat.uniforms.size.value = 2 * pixelRatio;
  }
}
