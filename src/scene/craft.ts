import {
  AmbientLight,
  DirectionalLight,
  Group,
  Matrix4,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { KM_PER_AU } from '../astro/ephemeris';
import type { Vec } from '../astro/kepler';

const M_PER_AU = KM_PER_AU * 1000;
// fetched once the craft is this many pixels across, and drawn from there on
const LOAD_PX = 1;
const SHOW_PX = 2;

// the loader too waits until someone zooms in on a craft
const load = (url: string) =>
  Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js'),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }]) =>
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url),
  );
const cache = new Map<string, Promise<Object3D>>();

/** Directions at the craft, all ecliptic: to Earth, to the Sun, and for an Earth orbiter its velocity and up. */
export interface Frame {
  toEarth: Vec;
  toSun: Vec;
  velocity?: Vec;
  up?: Vec;
}

const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const NORTH: Vec = [0, 0, 1];
const neg = (v: Vec): Vec => [-v[0], -v[1], -v[2]];

function orbitPole(f: Frame): Vec {
  const { up, velocity: v } = f;
  if (!up || !v) {
    return neg(f.toSun);
  }
  const n: Vec = [up[1] * v[2] - up[2] * v[1], up[2] * v[0] - up[0] * v[2], up[0] * v[1] - up[1] * v[0]];
  return n[0] * f.toSun[0] + n[1] * f.toSun[1] + n[2] * f.toSun[2] > 0 ? neg(n) : n;
}

/**
 * How each model is held: one of its axes on a direction, another as near to a second as it goes. The model
 * files are made with their main axis on +z (see the README).
 */
const ATTITUDE: Record<string, (f: Frame) => [Vector3, Vec, Vector3, Vec]> = {
  // high-gain dish on Earth, as they flew between encounters
  earth: (f) => [Z, f.toEarth, Y, NORTH],
  // aperture on the pole of its orbit, on the side away from the Sun: a target Earth never hides (the
  // continuous viewing zone) and well clear of the Sun. Rolled so the Sun is in the plane the panels turn in.
  hubble: (f) => [Z, orbitPole(f), Y, f.toSun],
  // sunshield between the Sun and the telescope, which sits on its +y side
  webb: (f) => [Y, neg(f.toSun), Z, NORTH],
  // modules along the direction of flight and the truss across the orbit, with the truss on the zenith side
  iss: (f) => [Z, f.velocity ?? f.toEarth, Y, f.up ?? NORTH],
};

const m1 = new Matrix4();
const m2 = new Matrix4();
const t1 = new Vector3();
const t2 = new Vector3();
const t3 = new Vector3();
const a3 = new Vector3();

function orient(q: Quaternion, [a1, d1, a2, d2]: [Vector3, Vec, Vector3, Vec]) {
  t1.set(...d1).normalize();
  t2.set(...d2);
  t2.addScaledVector(t1, -t2.dot(t1));
  if (t2.lengthSq() < 1e-12) {
    t2.set(1, 0, 0).addScaledVector(t1, -t1.x);
  }
  t2.normalize();
  t3.crossVectors(t1, t2);
  a3.crossVectors(a1, a2);
  m1.makeBasis(t1, t2, t3);
  m2.makeBasis(a1, a2, a3).transpose();
  return q.setFromRotationMatrix(m1.multiply(m2));
}

/** A part that turns on its own to face the Sun, like Hubble's solar arrays: about `axis`, cells on `face`. */
interface Tracker {
  pivot: Group;
  axis: Vector3;
  face: Vector3;
}

function trackers(model: Object3D) {
  const found: Object3D[] = [];
  model.traverse((o) => {
    // not `pivot`, which three's GLTFLoader takes for a pattern of its own and strips
    if (o.userData.hinge) {
      found.push(o);
    }
  });
  return found.map((o): Tracker => {
    const { hinge, axis, face } = o.userData as Record<string, [number, number, number]>;
    // hung from a group at the pivot, so turning the group turns the part about it
    const g = new Group();
    g.position.set(...hinge);
    (o.parent as Object3D).add(g);
    o.position.sub(g.position);
    g.add(o);
    return { pivot: g, axis: new Vector3(...axis), face: new Vector3(...face) };
  });
}

const s1 = new Vector3();
const s2 = new Vector3();
const s3 = new Vector3();
const qi = new Quaternion();

/** `toSun` in the frame of `node`, which sits somewhere inside `model`. */
function sunIn(out: Vector3, toSun: Vec, node: Object3D, model: Object3D) {
  qi.identity();
  for (let n: Object3D | null = node; n && n !== model.parent; n = n.parent) {
    qi.premultiply(n.quaternion);
  }
  return out.set(...toSun).applyQuaternion(qi.invert());
}

class CraftModel {
  model: Object3D | null = null;
  parts: Tracker[] = [];
  private loading = false;

  constructor(
    private readonly parent: Group,
    private readonly url: string,
    readonly attitude: string,
  ) {}

  /** Whether the model is in and shows at `px`, the craft's radius on screen. */
  ready(px: number) {
    if (!this.model && !this.loading && px > LOAD_PX) {
      this.loading = true;
      let p = cache.get(this.url);
      if (!p) {
        p = load(this.url).then((g) => g.scene);
        cache.set(this.url, p);
      }
      // the two Pioneers and the two Voyagers share a file, so each takes its own copy
      p.then((scene) => {
        this.model = scene.clone();
        this.model.visible = false;
        this.parts = trackers(this.model);
        this.parent.add(this.model);
      });
    }
    return this.model !== null && px > SHOW_PX;
  }
}

/**
 * The spacecraft models, drawn after everything else in a scene of their own, in metres with the camera at
 * the origin. In the main scene the depth buffer is logarithmic in AU, and on the GPU 1 + 3e-10 AU (a craft
 * 45 m off) rounds to 1, so every part of a craft would land on the same depth. Here distances are tens of
 * metres, worked out from the camera in doubles before they reach the GPU.
 */
export class CraftScene {
  private readonly scene = new Scene();
  // the ecliptic, turned the way the main scene's is
  private readonly root = new Group();
  private readonly camera = new PerspectiveCamera();
  private readonly models = new Map<string, CraftModel>();
  // Out where most craft are the Sun is far too faint to show them, so the light is held at a level that
  // shows their shape, with some fill on the dark side.
  private readonly sun = new DirectionalLight(0xffffff, 2.6);
  private readonly fill = new AmbientLight(0xbfcfff, 0.35);
  private reach = 0;
  private lightAt = Number.POSITIVE_INFINITY;
  private readonly q = new Quaternion();

  constructor() {
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    this.root.add(this.sun, this.sun.target, this.fill);
  }

  /** A craft with `model`; one without an attitude of its own holds its dish on Earth. */
  add(id: string, model: string) {
    const url = `${import.meta.env.BASE_URL}models/${model}.glb`;
    this.models.set(id, new CraftModel(this.root, url, model in ATTITUDE ? model : 'earth'));
  }

  has(id: string) {
    return this.models.has(id);
  }

  begin() {
    for (const m of this.models.values()) {
      if (m.model) {
        m.model.visible = false;
      }
    }
    this.reach = 0;
    this.lightAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Puts `id` at `rel`, its offset from the camera in ecliptic AU, if it is big enough on screen (`px` is its
   * radius there). `radius` is how far it reaches, in AU.
   */
  place(id: string, px: number, rel: Vec, radius: number, frame: Frame) {
    const m = this.models.get(id);
    if (!m?.ready(px) || !m.model) {
      return;
    }
    const o = m.model;
    o.visible = true;
    o.position.set(rel[0] * M_PER_AU, rel[1] * M_PER_AU, rel[2] * M_PER_AU);
    o.quaternion.copy(orient(this.q, ATTITUDE[m.attitude](frame)));
    if (m.parts.length) {
      // outer joints come first, so each part sees the Sun in a frame its parents have already turned; the turn
      // about its axis that brings its cells round to the Sun
      for (const t of m.parts) {
        sunIn(s1, frame.toSun, t.pivot.parent as Object3D, o);
        s2.copy(s1).addScaledVector(t.axis, -s1.dot(t.axis));
        const angle = Math.atan2(t.axis.dot(s3.crossVectors(t.face, s2)), t.face.dot(s2));
        t.pivot.quaternion.setFromAxisAngle(t.axis, angle);
      }
    }
    const d = Math.hypot(...rel);
    this.reach = Math.max(this.reach, (d + radius * 2) * M_PER_AU);
    // lit for the nearest one; a step toward the Sun gives the light's direction
    if (d < this.lightAt) {
      this.lightAt = d;
      const s = Math.hypot(...frame.toSun) || 1;
      this.sun.target.position.copy(o.position);
      this.sun.position.set(
        o.position.x + frame.toSun[0] / s,
        o.position.y + frame.toSun[1] / s,
        o.position.z + frame.toSun[2] / s,
      );
    }
  }

  /** Draws them over the frame, from where the main camera looks. */
  render(renderer: WebGLRenderer, cam: PerspectiveCamera) {
    if (!this.reach) {
      return;
    }
    const c = this.camera;
    c.fov = cam.fov;
    c.aspect = cam.aspect;
    c.far = this.reach * 1.5;
    c.near = Math.max(0.01, c.far * 1e-5);
    c.updateProjectionMatrix();
    c.position.set(0, 0, 0);
    c.quaternion.copy(cam.quaternion);
    renderer.clearDepth();
    renderer.render(this.scene, c);
  }
}
