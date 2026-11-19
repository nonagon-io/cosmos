import { type AstroTime, MakeTime } from 'astronomy-engine';
import { Group, MathUtils, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { type Ephemeris, J2000, type OrbitData } from '../astro/ephemeris';
import { type PeriElements, periodDays, type Vec } from '../astro/kepler';
import type { Body, Kind } from '../data/schema';
import { t } from '../i18n';
import type { Store } from '../store';
import { BodyVisual } from './bodies';
import { CameraRig } from './camera';
import { Heliosphere } from './heliosphere';
import { type LabelEntry, Labels } from './labels';
import { ellipseHead, ellipseLoop, OrbitLine, pathLine, sampleLoop } from './orbits';
import { type ElementSets, OortCloud, SmallBodies } from './particles';
import { NearStars, type StarData, skyStars } from './stars';
import { CometTails } from './tails';

const PRIORITY: Record<Kind, number> = {
  star: 80,
  planet: 70,
  dwarf: 52,
  spacecraft: 46,
  interstellar: 40,
  comet: 36,
  moon: 30,
  asteroid: 30,
};

// spacecraft have no size; this is how close the camera may get to their marker
const CRAFT_RADIUS_AU = 3e-9;
const LONG_PERIOD = 200 * 365.25;

type OrbitKind =
  | { kind: 'loop'; period: number; samples: number; rebuild: number }
  | { kind: 'ellipse'; el: PeriElements }
  | { kind: 'path'; span: number };

interface Orbit {
  line: OrbitLine;
  spec: OrbitKind;
}

interface Projected {
  x: number;
  y: number;
  r: number;
  dist: number;
}

const v3 = new Vector3();

/** Owns the renderer, the scene graph and the per-frame update of everything in it. */
export class World {
  readonly renderer: WebGLRenderer;
  readonly rig: CameraRig;
  readonly positions = new Map<string, Vec>();
  readonly projected = new Map<string, Projected>();
  private readonly scene = new Scene();
  private readonly world = new Group();
  private readonly sky = new Scene();
  private readonly skyCamera = new PerspectiveCamera(45, 1, 0.1, 10);
  private readonly visuals = new Map<string, BodyVisual>();
  private readonly orbits = new Map<string, Orbit>();
  private readonly order: Body[];
  private readonly smallBodies: SmallBodies;
  private readonly oort: OortCloud;
  private readonly heliosphere: Heliosphere;
  private readonly tails: CometTails;
  private readonly nearStars: NearStars;
  private readonly labels: Labels;
  private width = 1;
  private height = 1;
  private lastDay = Number.NaN;

  constructor(
    canvas: HTMLCanvasElement,
    labelRoot: HTMLElement,
    private readonly store: Store,
    private readonly eph: Ephemeris,
    private readonly orbitData: OrbitData,
    elementSets: ElementSets,
    readonly stars: StarData,
    onPick: (id: string) => void,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x020308, 1);

    // ecliptic (x, y, z) is scene (x, z, -y): y up is ecliptic north
    const root = new Group();
    root.rotation.x = -Math.PI / 2;
    root.add(this.world);
    this.scene.add(root);
    const skyRoot = new Group();
    skyRoot.rotation.x = -Math.PI / 2;
    this.sky.add(skyRoot);
    skyStars(skyRoot, stars);

    // parents before their moons, so each frame can add the parent's position
    const depth = (b: Body): number => (b.parent ? 1 + depth(store.bodyById.get(b.parent) as Body) : 0);
    this.order = [...store.data.bodies].sort((a, b) => depth(a) - depth(b));

    for (const b of store.data.bodies) {
      const v = new BodyVisual(b);
      this.visuals.set(b.id, v);
      this.world.add(v.group);
      const orbit = this.makeOrbit(b);
      if (orbit) {
        this.orbits.set(b.id, orbit);
        this.world.add(orbit.line.line);
      }
    }
    this.smallBodies = new SmallBodies(this.world, elementSets);
    this.oort = new OortCloud(this.world);
    this.heliosphere = new Heliosphere(this.world);
    this.tails = new CometTails(this.world, store.data.bodies, (id) => eph.perihelion(id));
    this.nearStars = new NearStars(this.world, stars.near);
    this.labels = new Labels(labelRoot, onPick);

    const { focus, distance } = store.data.timeline.initialView;
    this.rig = new CameraRig(
      canvas,
      focus,
      distance,
      (id) => this.positions.get(id) ?? null,
      (id) => this.minDistance(id),
    );
    this.rig.zoomOnWheel(labelRoot);
  }

  minDistance(id: string) {
    const b = this.store.bodyById.get(id);
    if (!b) {
      return 1e-6;
    }
    return b.kind === 'spacecraft' ? CRAFT_RADIUS_AU : (this.visuals.get(id)?.radiusAu ?? 1e-6);
  }

  private makeOrbit(b: Body): Orbit | null {
    if (b.id === 'sun') {
      return null;
    }
    if (b.orbit === 'craft') {
      const c = this.orbitData.craft[b.id];
      if (!c) {
        return null;
      }
      const line = new OrbitLine(b, true);
      pathLine(line, c.path);
      line.material.uniforms.span.value = 365.25 * 40;
      line.material.uniforms.future.value = 0.1;
      line.material.uniforms.pastFloor.value = 0.22;
      return { line, spec: { kind: 'path', span: 365.25 * 40 } };
    }
    if (b.orbit === 'named') {
      const n = this.orbitData.named[b.id];
      if (!n) {
        return null;
      }
      const el = n.elements;
      const period = el.e < 1 ? periodDays(el.q / (1 - el.e)) : Number.POSITIVE_INFINITY;
      if (period > LONG_PERIOD && el.e < 1) {
        // one lap is longer than the data; the ellipse is the whole orbit
        const line = new OrbitLine(b, false);
        ellipseLoop(line, el, 2048);
        return { line, spec: { kind: 'ellipse', el } };
      }
      const line = new OrbitLine(b, true);
      pathLine(line, n.path);
      const span = Number.isFinite(period) ? period : 365.25 * 30;
      line.material.uniforms.span.value = span;
      return { line, spec: { kind: 'path', span } };
    }
    const period = b.period ?? 365;
    const line = new OrbitLine(b, false);
    const planet = !b.parent;
    return {
      line,
      spec: {
        kind: 'loop',
        period,
        samples: planet ? 1024 : 480,
        // orbit shapes drift slowly; planets are rebuilt every 20 years, moons every 30 days (their nodes precess)
        rebuild: planet ? 365.25 * 20 : Math.max(30, period * 2),
      },
    };
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
  }

  /** Positions of every body at `day`, parents first. */
  private computePositions(day: number, time: AstroTime) {
    this.positions.clear();
    for (const b of this.order) {
      if (!this.eph.exists(b.id, day)) {
        continue;
      }
      const local = this.eph.local(b.id, day, time);
      if (!local) {
        continue;
      }
      const parent = b.parent ? this.positions.get(b.parent) : undefined;
      if (b.parent && !parent) {
        continue;
      }
      this.positions.set(
        b.id,
        parent ? [local[0] + parent[0], local[1] + parent[1], local[2] + parent[2]] : local,
      );
    }
  }

  frame(dt: number) {
    const { store } = this;
    const day = store.day;
    const time = MakeTime(day);
    this.computePositions(day, time);
    const camOffset = this.rig.update(dt, this.width, this.height);
    const focus = this.rig.focusPos;
    const cam = this.rig.camera;
    const camDist = this.rig.distance;
    const layers = store.layers;
    const pr = this.renderer.getPixelRatio();
    // world camera position in the ecliptic frame
    const cx = focus[0] + camOffset[0];
    const cy = focus[1] + camOffset[1];
    const cz = focus[2] + camOffset[2];
    this.world.position.set(-focus[0], -focus[1], -focus[2]);
    this.world.updateMatrixWorld();

    const view = cam.matrixWorldInverse;
    const sunView = v3.set(-focus[0], -focus[2], focus[1]).applyMatrix4(view).clone();
    const selectedId = store.selection?.kind === 'body' ? store.selection.body.id : null;
    const markerScale = Math.min(1.25, Math.max(0.85, this.height / 900));

    this.projected.clear();
    for (const [id, vis] of this.visuals) {
      const p = this.positions.get(id);
      const shown =
        p !== undefined && (vis.body.kind !== 'spacecraft' || layers.spacecraft || id === this.rig.focusId);
      vis.group.visible = shown;
      if (!p || !shown) {
        continue;
      }
      vis.group.position.set(p[0], p[1], p[2]);
      if (vis.body.kind !== 'spacecraft') {
        vis.setOrientation(this.eph.axis(id, day, time), day);
      }
      vis.setCloudDrift(day);
      const dist = Math.max(1e-12, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz));
      const pxPerAu = this.rig.pxPerAu(dist, this.height);
      const r = vis.update(sunView, view, pxPerAu, camDist, markerScale, layers.trueSize);
      // screen position, for labels and picking
      v3.set(p[0] - focus[0], p[2] - focus[2], -(p[1] - focus[1])).project(cam);
      if (v3.z < 1 && Math.abs(v3.x) < 1.2 && Math.abs(v3.y) < 1.2) {
        this.projected.set(id, {
          x: ((v3.x + 1) / 2) * this.width,
          y: ((1 - v3.y) / 2) * this.height,
          r,
          dist,
        });
      }
    }

    this.hideOccluded();

    for (const [id, o] of this.orbits) {
      this.updateOrbit(id, o, day, cx, cy, cz, selectedId);
    }

    const sunDist = Math.max(1e-9, Math.hypot(cx, cy, cz));
    this.smallBodies.update(
      day,
      pr,
      layers.smallBodies,
      this.rig.pxPerAu(sunDist, this.height),
      this.height,
      layers.trueSize,
    );
    this.oort.update(pr, layers.oort, camDist, layers.trueSize);
    this.heliosphere.update(layers.oort || layers.spacecraft, camDist);
    this.tails.update(
      (id) => this.positions.get(id),
      (id) => this.eph.velocity(id, day),
      [cx, cy, cz],
      (p) => this.rig.pxPerAu(Math.max(1e-12, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz)), this.height),
    );
    this.nearStars.update(pr, camDist);

    this.renderer.clear();
    this.skyCamera.quaternion.copy(cam.quaternion);
    this.skyCamera.fov = cam.fov;
    this.skyCamera.aspect = cam.aspect;
    this.skyCamera.updateProjectionMatrix();
    this.renderer.render(this.sky, this.skyCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, cam);

    if (layers.labels) {
      this.layoutLabels(selectedId, camDist);
    } else {
      this.labels.render([]);
    }
    this.lastDay = day;
  }

  /** Drops bodies hidden behind a sphere that is big on screen, so their labels don't show through it. */
  private hideOccluded() {
    const disks = [...this.projected.values()].filter((p) => p.r > 3);
    if (!disks.length) {
      return;
    }
    for (const [id, p] of this.projected) {
      for (const d of disks) {
        if (d !== p && p.dist > d.dist && Math.hypot(p.x - d.x, p.y - d.y) < d.r) {
          this.projected.delete(id);
          break;
        }
      }
    }
  }

  private updateOrbit(
    id: string,
    o: Orbit,
    day: number,
    cx: number,
    cy: number,
    cz: number,
    selectedId: string | null,
  ) {
    const { line, spec } = o;
    const body = line.body;
    const p = this.positions.get(id);
    const parentId = body.parent ?? 'sun';
    const parent = this.positions.get(parentId);
    const craftHidden = body.kind === 'spacecraft' && !this.store.layers.spacecraft;
    if (!this.store.layers.orbits || !p || !parent || craftHidden) {
      line.line.visible = false;
      return;
    }
    if (spec.kind === 'loop' && Number.isNaN(line.builtAt)) {
      sampleLoop(line, this.eph, day, spec.period, spec.samples);
    }
    const u = line.material.uniforms;
    if (spec.kind === 'loop') {
      u.head.value = ((((day - line.builtAt) / spec.period) % 1) + 1) % 1;
    } else if (spec.kind === 'ellipse') {
      u.head.value = ellipseHead(spec.el, day + J2000);
    } else {
      u.now.value = day;
    }
    line.line.position.set(parent[0], parent[1], parent[2]);

    // fade orbits that are tiny on screen, and the focused body's own orbit when the camera is right on it
    const parentDist = Math.max(1e-12, Math.hypot(parent[0] - cx, parent[1] - cy, parent[2] - cz));
    const sizePx = line.size * this.rig.pxPerAu(parentDist, this.height);
    const bodyDist = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
    const r = Math.max(this.minDistance(id), 1e-9);
    let alpha = MathUtils.smoothstep(sizePx, 8, 40) * MathUtils.smoothstep(bodyDist / r, 25, 220);
    // an orbit many screens wide only crosses the view as a straight line; keep those quiet
    alpha *= 1 - 0.7 * MathUtils.smoothstep(sizePx, this.height * 4, this.height * 40);
    if (id === selectedId) {
      alpha = Math.min(1, alpha * 1.6);
    }
    line.line.visible = alpha > 0.01;
    u.opacity.value = 0.55 * alpha;
    // resample drifting loops only while they show, and at fast playback no more than twice a second
    const stale = Math.max(spec.kind === 'loop' ? spec.rebuild : 0, Math.abs(this.store.speed) * 0.5);
    if (spec.kind === 'loop' && line.line.visible && Math.abs(day - line.builtAt) > stale) {
      sampleLoop(line, this.eph, day, spec.period, spec.samples);
    }
  }

  private layoutLabels(selectedId: string | null, camDist: number) {
    const entries: LabelEntry[] = [];
    const sun = this.projected.get('sun');
    for (const [id, pr] of this.projected) {
      const b = this.store.bodyById.get(id) as Body;
      const parent = this.projected.get(b.parent ?? 'sun');
      const important = id === selectedId || id === this.rig.focusId;
      // small things far beyond what the camera is looking at only line up by chance; leave them unlabelled
      const minor = b.kind !== 'planet' && b.kind !== 'star' && b.kind !== 'dwarf';
      if (!important && minor && pr.dist > camDist * 30) {
        continue;
      }
      if (!important && id !== 'sun') {
        // a label crowding its parent says nothing; wait until the two are apart on screen
        const ref = parent ?? sun;
        const sep = ref ? Math.hypot(pr.x - ref.x, pr.y - ref.y) : 1e9;
        if (sep < (b.parent ? 22 : 16)) {
          continue;
        }
      }
      let priority = PRIORITY[b.kind] + Math.log10(b.radius ?? 1) * 2;
      if (important) {
        priority += 100;
      }
      entries.push({
        id,
        text: b.name,
        x: pr.x,
        y: pr.y,
        priority,
        color: b.color,
        className: `k-${b.kind}${id === selectedId ? ' sel' : ''}`,
        offset: Math.max(7, pr.r + 5),
      });
    }

    // regions get a label at the scales where they make sense
    for (const reg of this.store.data.regions) {
      if (camDist < reg.view / 9 || camDist > reg.view * 6) {
        continue;
      }
      const mid = reg.id === 'oort-cloud' ? reg.outer * 0.8 : (reg.inner + reg.outer) / 2;
      const ang = MathUtils.degToRad(reg.id === 'oort-cloud' ? 40 : 205);
      const s = this.screenOf([
        Math.cos(ang) * mid,
        Math.sin(ang) * mid,
        reg.id === 'oort-cloud' ? mid * 0.35 : 0,
      ]);
      if (s) {
        entries.push({
          id: `region:${reg.id}`,
          text: reg.name,
          x: s.x,
          y: s.y,
          priority: 20,
          color: '#9fb3d1',
          className: 'region',
          offset: -((reg.name.length * 6.6) / 2),
        });
      }
    }

    const presence = NearStars.presence(camDist);
    if (presence > 0.3) {
      for (const [i, s] of this.stars.near.entries()) {
        const p = this.screenOf([s.x, s.y, s.z]);
        if (p) {
          entries.push({
            id: `star:${i}`,
            text: t.starNames.get(s.name) ?? s.name,
            x: p.x,
            y: p.y,
            priority: 60 - s.absmag,
            color: '#ffe9c4',
            className: 'star',
            offset: 8,
          });
        }
      }
    }
    this.labels.render(entries);
  }

  /** Screen position of an ecliptic point, or null when it is off screen. */
  screenOf(p: Vec) {
    const f = this.rig.focusPos;
    v3.set(p[0] - f[0], p[2] - f[2], -(p[1] - f[1])).project(this.rig.camera);
    if (v3.z >= 1 || Math.abs(v3.x) > 1.1 || Math.abs(v3.y) > 1.1) {
      return null;
    }
    return { x: ((v3.x + 1) / 2) * this.width, y: ((1 - v3.y) / 2) * this.height };
  }

  /** The body under a screen point, if any. */
  pick(x: number, y: number): string | null {
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [id, p] of this.projected) {
      const d = Math.hypot(p.x - x, p.y - y);
      const reach = Math.max(14, p.r + 6);
      if (d < reach) {
        // prefer what is in front, then what is closest to the pointer
        const score = d / reach + p.dist * 1e-12;
        if (score < bestScore) {
          bestScore = score;
          best = id;
        }
      }
    }
    return best;
  }

  get day() {
    return this.lastDay;
  }
}
