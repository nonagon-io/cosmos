import { type AstroTime, MakeTime } from 'astronomy-engine';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineDashedMaterial,
  MathUtils,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  type ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import { type Ephemeris, J2000, leoPeriod, type OrbitData, type Path } from '../astro/ephemeris';
import { type PeriElements, periodDays, type Vec } from '../astro/kepler';
import type { Body, Kind } from '../data/schema';
import { t } from '../i18n';
import { COSMIC_AGE, HOLE_SPEEDS, type Store, scaleFactor } from '../store';
import { BodyVisual } from './bodies';
import { CameraRig } from './camera';
import { Cmb } from './cmb';
import { Cosmicflows, SEEN, WEB_LAYER } from './cosmicflows';
import { CraftScene, type Frame } from './craft';
import { ARMS, armBeta, Galaxy, galactic } from './galaxy';
import { Heliosphere } from './heliosphere';
import { type LabelEntry, Labels } from './labels';
import { LocalGroup, type LocalGroupRow, M31_SYSTEM } from './localgroup';
import { LocalVolume, type LocalVolumeRow } from './localvolume';
import { LowResPass } from './lowres';
import { Nebulae } from './nebulae';
import { ellipseHead, ellipseLoop, OrbitLine, pathLine, sampleLoop } from './orbits';
import { type ElementSets, OORT_GONE, OortCloud, SmallBodies } from './particles';
import { SgrA } from './sgra';
import { AU_PER_LY, eclipticDir, type StarData, type StarField, Stars3D, skyStars } from './stars';
import { Survey, type SurveyManifest, type SurveyName } from './survey';
import { CometTails } from './tails';
import { haze } from './textures';

const LY_PER_PC = 3.26156;
// star names shown at once out among the stars
const STAR_LABELS = 24;
// where along each spiral arm its name goes, as a galactocentric radius in kpc
// camera distances in light years where the timeline turns to millions of years and back, apart so it
// doesn't flicker between the two
// past the Oort cloud, in AU, the Solar System's timeline goes
const SOLAR_OUT = 4e5;
// within this many AU of Sgr A* its own clock shows
const HOLE_CLOCK_AU = 2e5;
const DEEP_IN = 6000;
const DEEP_OUT = 4500;
// and out at billions of light years from the Sun it counts billions of years of the universe's expansion
const COSMIC_IN = 1.5e9;
const COSMIC_OUT = 1e9;
// light years from the Sun beyond which the dwarf galaxies get names
const LOCAL_GROUP_LABELS = 500000;
// zoom, in light years, out to which the galaxy points need no extra exposure
const WEB_EXPOSE_LY = 2e9;
// device pixels the black hole's disk starts out allowed to trace, and the size past which frame times adjust
// that; the layer it is drawn on when scaled down
const HOLE_BUDGET = 300000;
const HOLE_SLOW_AREA = 50000;
const HOLE_LAYER = 1;
const ARM_LABEL_R: Record<string, number> = {
  'scutum-centaurus': 5.6,
  'sagittarius-carina': 6.4,
  local: 8.6,
  perseus: 10.6,
  outer: 14,
};

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
// how far beyond Earth, away from the Sun, the L2 point lies, and when a craft bound there got into its loop
const L2_AU = 0.01;
const CRUISE_END: Record<string, string> = { jwst: '2022-01-24' };

type OrbitKind =
  | { kind: 'loop'; period: number; samples: number; rebuild: number }
  | { kind: 'ellipse'; el: PeriElements }
  | { kind: 'path'; span: number }
  // a path held in the frame that turns with the Earth–Sun line
  | { kind: 'halo'; span: number };

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
// px a frame of orbital motion past which a label is hidden, and below which it comes back
const LABEL_TOO_FAST = 12;
const LABEL_SLOW_AGAIN = 5;

/** Owns the renderer, the scene graph and the per-frame update of everything in it. */
export class World {
  readonly renderer: WebGLRenderer;
  readonly rig: CameraRig;
  readonly positions = new Map<string, Vec>();
  // camera position in the ecliptic frame, AU from the Sun
  private camPos: Vec = [0, 0, 0];
  // clusters and nebulae: fixed ecliptic positions in AU, and a glow for the nebulae
  // `pos` is where it is drawn; for things fixed to the Galaxy rather than near the Sun it moves with the
  // Galaxy's timeline, away from `base`, where it is now
  private readonly crafts = new CraftScene();
  private readonly deepSky: {
    id: string;
    pos: Vec;
    base: Vec;
    galactic: boolean;
    // a void out in the Hubble flow, which moves with the expansion
    expands: boolean;
    radius: number;
    glow: Sprite | null;
  }[] = [];
  readonly projected = new Map<string, Projected>();
  // each body's place relative to its parent last frame, and how fast that moves on screen
  private readonly lastRel = new Map<string, Vec>();
  private readonly labelSpeed = new Map<string, number>();
  private readonly fastLabels = new Set<string>();
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
  // the empty point JWST loops round, and the Sun–Earth line it lies on
  private readonly l2 = new Group();
  private readonly l2Line: Line;
  private readonly l2Mark: Points;
  private l2Pos: Vec | null = null;
  private readonly tails: CometTails;
  private readonly stars3d: Stars3D;
  private readonly nebulae: Nebulae;
  private readonly galaxy: Galaxy;
  private readonly localGroup: LocalGroup;
  private readonly localVolume: LocalVolume;
  private readonly cosmicflows: Cosmicflows;
  private readonly cmb: Cmb;
  private readonly surveys: Survey[] = [];
  /** Galaxies other than ours, where the Solar System's dates mean nothing however close the camera is. */
  private readonly otherGalaxies: Set<string>;
  // Sgr A*'s disk is ray traced per pixel, which filling the screen can cost more than a slow GPU has. It gets a
  // pixel budget, past which it is drawn smaller and scaled up; the budget grows while frames keep up and shrinks
  // while they don't, so a fast GPU ends up at full resolution.
  private readonly holePass = new LowResPass();
  private readonly webPass = new LowResPass(true);
  private holeScale = 1;
  // on a void, out among the galaxies: everything is true to size and nothing of the Milky Way's own shows
  private onVoid = false;
  private holeBudget = HOLE_BUDGET;
  private frameMs = 1000 / 60;
  private readonly sgr: SgrA | null = null;
  private sgrId = '';
  private readonly skyMat: ShaderMaterial;
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
    field: StarField,
    localGroup: LocalGroupRow[],
    localVolume: LocalVolumeRow[],
    cosmicflows: Uint16Array,
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
    this.skyMat = skyStars(skyRoot, stars);

    // parents before their moons, so each frame can add the parent's position
    const depth = (b: Body): number => (b.parent ? 1 + depth(store.bodyById.get(b.parent) as Body) : 0);
    this.order = [...store.data.bodies].sort((a, b) => depth(a) - depth(b));

    for (const b of store.data.bodies) {
      const v = new BodyVisual(b);
      this.visuals.set(b.id, v);
      this.world.add(v.group);
      if (b.model) {
        this.crafts.add(b.id, b.model);
      }
      const orbit = this.makeOrbit(b);
      if (orbit) {
        this.orbits.set(b.id, orbit);
        this.world.add(orbit.line.line);
      }
    }
    this.smallBodies = new SmallBodies(this.world, elementSets);
    this.oort = new OortCloud(this.world);
    this.heliosphere = new Heliosphere(this.world);
    this.l2Line = new Line(
      new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)),
      new LineDashedMaterial({
        color: '#9fb3d1',
        dashSize: 0.0012,
        gapSize: 0.0012,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.l2Line.frustumCulled = false;
    const ring = document.createElement('canvas');
    ring.width = ring.height = 32;
    const g = ring.getContext('2d');
    if (g) {
      g.strokeStyle = '#fff';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(16, 16, 11, 0, Math.PI * 2);
      g.stroke();
    }
    this.l2Mark = new Points(
      new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(3), 3)),
      new PointsMaterial({
        color: '#c4de54',
        size: 11,
        sizeAttenuation: false,
        map: new CanvasTexture(ring),
        transparent: true,
        depthWrite: false,
      }),
    );
    this.l2Mark.frustumCulled = false;
    this.l2.add(this.l2Line, this.l2Mark);
    this.l2.visible = false;
    this.world.add(this.l2);
    this.tails = new CometTails(this.world, store.data.bodies, (id) => eph.perihelion(id));
    this.stars3d = new Stars3D(this.world, field);
    const gl = this.renderer.getContext();
    this.nebulae = new Nebulae(
      this.world,
      store.data.regions,
      gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
    );
    this.labels = new Labels(labelRoot, onPick);
    for (const r of store.data.regions) {
      if (!r.at) {
        continue;
      }
      const dir = eclipticDir(r.at.ra, r.at.dec);
      const d = r.at.ly * AU_PER_LY;
      const pos: Vec = [dir[0] * d, dir[1] * d, dir[2] * d];
      let glow: Sprite | null = null;
      if (r.at.glow) {
        glow = new Sprite(
          new SpriteMaterial({
            map: haze(),
            color: r.at.glow,
            blending: AdditiveBlending,
            depthWrite: false,
            transparent: true,
            opacity: 0.6,
          }),
        );
        glow.position.set(...pos);
        glow.scale.setScalar(r.at.radius * AU_PER_LY * 2.5);
        this.world.add(glow);
      }
      this.deepSky.push({
        id: `region:${r.id}`,
        pos,
        base: [...pos],
        galactic: r.at.type === 'galaxy' || r.at.type === 'blackhole',
        expands: r.at.type === 'void',
        radius: r.at.radius * AU_PER_LY,
        glow,
      });
    }
    this.galaxy = new Galaxy(
      this.world,
      this.deepSky.filter((o) => store.regionById.get(o.id.slice(7))?.at?.type === 'galaxy' && o.glow),
    );
    const spirals = this.deepSky.flatMap((o) => {
      const at = store.regionById.get(o.id.slice(7))?.at;
      return at && M31_SYSTEM.has(o.id.slice(7)) ? [{ ...o, id: o.id.slice(7), ra: at.ra, dec: at.dec }] : [];
    });
    const home = this.deepSky.find((o) => store.regionById.get(o.id.slice(7))?.at?.home);
    this.localGroup = new LocalGroup(this.world, localGroup, spirals, home?.base ?? [0, 0, 0]);
    this.otherGalaxies = new Set(
      store.data.regions.filter((r) => r.at?.type === 'galaxy' && !r.at.home).map((r) => `region:${r.id}`),
    );
    this.cosmicflows = new Cosmicflows(this.world, cosmicflows);
    this.cmb = new Cmb(this.world, `${import.meta.env.BASE_URL}textures/cmb_planck.png`);
    this.localVolume = new LocalVolume(
      this.world,
      localVolume,
      this.deepSky.map((o) => o.base),
    );
    const hole = store.data.regions.find((r) => r.at?.type === 'blackhole');
    const holePos = hole && this.deepSky.find((o) => o.id === `region:${hole.id}`)?.pos;
    if (hole?.at && holePos) {
      this.sgrId = hole.id;
      this.sgr = new SgrA(this.world, holePos, hole.at.ra, hole.at.dec, hole.at.ly / LY_PER_PC);
    }

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

  /** For a nebula with an infrared model: whether it is shown, after setting it if `on` is given. */
  infrared(id: string, on?: boolean): boolean | null {
    if (!this.nebulae.hasInfrared(id)) {
      return null;
    }
    if (on !== undefined) {
      this.nebulae.setInfrared(id, on);
    }
    return this.nebulae.isInfrared(id);
  }

  private inSolarSystem(focus: string): boolean {
    const { store } = this;
    if (store.bodyById.has(focus)) {
      return true;
    }
    if (focus.startsWith('region:')) {
      const r = store.regionById.get(focus.slice(7));
      return !!r && !r.at && !r.stars && !r.galaxies;
    }
    if (focus.startsWith('view:')) {
      const v = store.data.views.find((x) => x.id === focus.slice(5));
      return !!v && (store.bodyById.has(v.focus) || this.inSolarSystem(`region:${v.focus}`));
    }
    return false;
  }

  /** Where to look from to see Sgr A*'s disk nearly edge on, if there is one. */
  holeLook(): { look: Vec; roll: number } | undefined {
    return this.sgr?.diskLook();
  }

  infraredFromPhoto(id: string) {
    return this.nebulae.infraredFromPhoto(id);
  }

  minDistance(id: string) {
    const b = this.store.bodyById.get(id);
    if (!b) {
      const r = id.startsWith('region:') ? this.store.regionById.get(id.slice(7))?.at : undefined;
      // stop short of the ring around a black hole
      return r?.type === 'blackhole' ? r.radius * AU_PER_LY * 1.5 : 1e-6;
    }
    return b.kind === 'spacecraft' && !b.model ? CRAFT_RADIUS_AU : (this.visuals.get(id)?.radiusAu ?? 1e-6);
  }

  private makeOrbit(b: Body): Orbit | null {
    if (b.id === 'sun') {
      return null;
    }
    if (b.orbit === 'leo' && b.leo) {
      const period = leoPeriod(b.leo.alt);
      // the plane swings round by several degrees a day
      return { line: new OrbitLine(b, false), spec: { kind: 'loop', period, samples: 256, rebuild: 0.05 } };
    }
    if (b.orbit === 'craft') {
      const c = this.orbitData.craft[b.id];
      if (!c) {
        return null;
      }
      if (b.parent === 'earth') {
        // seen from a fixed direction the loop round L2 is smeared out along Earth's year
        const line = new OrbitLine(b, true);
        pathLine(line, this.corotating(c.path));
        const span = 365.25;
        line.material.uniforms.span.value = span;
        line.material.uniforms.future.value = 0.15;
        line.material.uniforms.pastFloor.value = 0.22;
        // the month-long trip out from Earth is dashed, so the loop itself reads as the orbit
        const until = CRUISE_END[b.id];
        if (until) {
          line.material.uniforms.dashUntil.value =
            Date.parse(`${until}T00:00:00Z`) / 86400000 + 2440587.5 - J2000;
          line.material.uniforms.dash.value = 0.0006;
        }
        return { line, spec: { kind: 'halo', span } };
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

  /** Earth's longitude round the Sun at `day`, radians. */
  private earthAngle(day: number) {
    const e = this.eph.position('earth', day);
    return e ? Math.atan2(e[1], e[0]) : 0;
  }

  /** A path round Earth turned into the frame where the Sun stays on the -x axis, velocities included. */
  private corotating(path: Path): Path {
    const w = (2 * Math.PI) / 365.256;
    return path.map((row) => {
      const a = -this.earthAngle(row[0] - J2000);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = c * row[1] - s * row[2];
      const y = s * row[1] + c * row[2];
      const vx = c * row[4] - s * row[5];
      const vy = s * row[4] + c * row[5];
      return [row[0], x, y, row[3], vx + w * y, vy - w * x, row[6]];
    });
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
  }

  /** A survey's galaxies, which arrive after the rest. `name` is its layer. */
  addSurvey(name: SurveyName, manifest: SurveyManifest) {
    const s = new Survey(this.world, name, manifest);
    this.surveys.push(s);
    return s;
  }

  /** Whether the camera is more than `ly` light years from the Sun. */
  outPast(ly: number) {
    return Math.hypot(...this.camPos) > ly * AU_PER_LY;
  }

  /** Positions of every body at `day`, parents first. */
  private computePositions(day: number, time: AstroTime) {
    this.positions.clear();
    const shift = Galaxy.sunShift(this.store.myr);
    const drift = this.localGroup.driftAt(this.store.myr);
    this.galaxy.setTime(this.store.myr);
    this.localGroup.setTime(shift, drift, this.store.myr);
    this.localVolume.setTime(shift);
    this.cosmicflows.setTime(shift);
    this.cmb.setTime(shift);
    for (const s of this.surveys) {
      s.setTime(shift);
    }
    // what is bound together, the Galaxy and its neighbours, keeps its size; everything further moves apart
    const a = scaleFactor(this.store.gyr);
    const fade = MathUtils.lerp(0.06, 1, MathUtils.smoothstep(COSMIC_AGE + this.store.gyr, 0.4, 3));
    this.cosmicflows.setExpansion(a, fade);
    this.cmb.setExpansion(a);
    for (const s of this.surveys) {
      s.setExpansion(a, fade);
    }
    for (const o of this.deepSky) {
      if (o.expands) {
        for (let i = 0; i < 3; i++) {
          o.pos[i] = o.base[i] * a;
        }
      }
      if (o.galactic) {
        const moves = M31_SYSTEM.has(o.id.slice(7));
        for (let i = 0; i < 3; i++) {
          o.pos[i] = o.base[i] - shift[i] + (moves ? drift[i] : 0);
        }
        o.glow?.position.set(...o.pos);
      }
      this.positions.set(o.id, o.pos);
    }
    this.sgr?.group.position.set(...(this.positions.get(`region:${this.sgrId}`) ?? [0, 0, 0]));
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
    // views framed on two things at once look at the point halfway
    const ref = (id: string) => (this.store.regionById.has(id) ? `region:${id}` : id);
    for (const v of this.store.data.views) {
      const a = this.positions.get(ref(v.focus));
      const b = v.also ? this.positions.get(ref(v.also)) : undefined;
      if (a && b) {
        this.positions.set(`view:${v.id}`, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      }
    }
  }

  frame(dt: number) {
    const { store } = this;
    // far enough out, time on the scale of days stands still: switch the timeline to millions of years
    const out = this.otherGalaxies.has(this.rig.focusId) ? Infinity : this.rig.distance / AU_PER_LY;
    if (store.deep ? out < DEEP_OUT : out > DEEP_IN) {
      store.setDeep(!store.deep);
    }
    // the days only mean something in the Solar System, and the millions of years only out among the
    // galaxies; close on a nebula or star there is nothing to run
    const shown = store.deep || (this.inSolarSystem(this.rig.focusId) && this.rig.distance < SOLAR_OUT);
    if (shown !== store.timeline) {
      store.setTimeline(shown);
    }
    const sunLy = Math.hypot(...this.camPos) / AU_PER_LY;
    if (store.deep ? (store.cosmic ? sunLy < COSMIC_OUT : sunLy > COSMIC_IN) : store.cosmic) {
      store.setCosmic(!store.cosmic);
    }
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
    this.camPos = [cx, cy, cz];
    this.world.position.set(-focus[0], -focus[1], -focus[2]);
    this.world.updateMatrixWorld();
    const fr = this.rig.focusId.startsWith('region:')
      ? store.regionById.get(this.rig.focusId.slice(7))
      : undefined;
    this.onVoid = fr?.at?.type === 'void';
    const onVoid = this.onVoid;
    const trueSize = layers.trueSize || onVoid;

    const view = cam.matrixWorldInverse;
    const sunView = v3.set(-focus[0], -focus[2], focus[1]).applyMatrix4(view).clone();
    const selectedId = store.selection?.kind === 'body' ? store.selection.body.id : null;
    const markerScale = Math.min(1.25, Math.max(0.85, this.height / 900));
    // past the Kuiper belt the planets are drawn true to size, as dots too small to hold up
    const shrink = MathUtils.smoothstep(Math.log10(Math.max(1e-9, Math.hypot(cx, cy, cz))), 2.3, 3);

    this.projected.clear();
    this.crafts.begin();
    const earth = this.positions.get('earth');
    for (const [id, vis] of this.visuals) {
      const p = this.positions.get(id);
      const shown =
        !onVoid &&
        p !== undefined &&
        (vis.body.kind !== 'spacecraft' || layers.spacecraft || id === this.rig.focusId);
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
      // from light years out every planet, moon and craft lands within a pixel or two of the Sun, and their
      // markers, each held a few pixels wide, pile up into a disk around it
      if (id !== 'sun' && id !== this.rig.focusId && id !== selectedId && Math.hypot(...p) * pxPerAu < 3) {
        vis.group.visible = false;
        continue;
      }
      const r = vis.update(
        sunView,
        view,
        pxPerAu,
        camDist,
        markerScale,
        trueSize,
        vis.body.id === 'sun' ? 0 : shrink,
      );
      if (earth && this.crafts.has(id)) {
        this.placeCraft(vis.body, p, earth, r, [p[0] - cx, p[1] - cy, p[2] - cz], vis.radiusAu, day, time);
      }
      // orbital motion on screen, leaving out the camera's own: sped up, a fast orbiter's label would
      // jump around from frame to frame
      const pp = this.positions.get(vis.body.parent ?? 'sun') ?? [0, 0, 0];
      const rel: Vec = [p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]];
      const last = this.lastRel.get(id);
      const step = last ? Math.hypot(rel[0] - last[0], rel[1] - last[1], rel[2] - last[2]) * pxPerAu : 0;
      this.lastRel.set(id, rel);
      // capped so one jump of the timeline hides a label only for a moment
      const speed = Math.max(Math.min(step, LABEL_TOO_FAST * 3), (this.labelSpeed.get(id) ?? 0) * 0.8);
      this.labelSpeed.set(id, speed);
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
    this.placeL2();

    const sunDist = Math.max(1e-9, Math.hypot(cx, cy, cz));
    this.smallBodies.update(
      day,
      pr,
      layers.smallBodies,
      this.rig.pxPerAu(sunDist, this.height),
      this.height,
      trueSize,
    );
    this.oort.update(pr, layers.oort && !onVoid, sunDist, trueSize);
    this.heliosphere.update(!onVoid && (layers.oort || layers.spacecraft), camDist);
    this.tails.update(
      (id) => this.positions.get(id),
      (id) => this.eph.velocity(id, day),
      [cx, cy, cz],
      (p) => this.rig.pxPerAu(Math.max(1e-12, Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz)), this.height),
      trueSize,
    );
    // the sky sphere only holds stars with no distance; once we leave the Sun they would be in the wrong place
    this.skyMat.uniforms.opacity.value = onVoid ? 0 : 1 - Stars3D.presence(camDist);
    const galaxy = Galaxy.presence(sunDist);
    // set before the Galaxy, which scales and fades the glows of satellite galaxies on top
    for (const o of this.deepSky) {
      if (o.glow) {
        const d = Math.hypot(o.pos[0] - cx, o.pos[1] - cy, o.pos[2] - cz);
        // seen from inside, a nebula is too thin to glow like this
        const ours = onVoid && !o.galactic;
        (o.glow.material as SpriteMaterial).opacity = ours
          ? 0
          : 0.6 * MathUtils.smoothstep(d / o.radius, 1.5, 4);
      }
    }
    this.nebulae.update([cx, cy, cz], this.height, cam.fov, pr, !onVoid, trueSize);
    if (this.sgr) {
      const g = this.sgr.group.position;
      this.galaxy.dim = 1 - 0.875 * SgrA.nearness(Math.hypot(cx - g.x, cy - g.y, cz - g.z));
    }
    this.galaxy.update(this.height, cam.fov, [cx, cy, cz], trueSize, camDist);
    this.localGroup.update(this.height, cam.fov, [cx, cy, cz], trueSize, camDist);
    this.localVolume.update(this.height, cam.fov, [cx, cy, cz], trueSize, camDist);
    SEEN.zoom.value = camDist;
    this.cosmicflows.update(Math.hypot(cx, cy, cz), pr);
    this.cmb.update(Math.hypot(cx, cy, cz));
    for (const s of this.surveys) {
      s.update(Math.hypot(cx, cy, cz), pr, dt, this.frameMs, layers[s.name]);
    }
    if (this.sgr) {
      const g = this.sgr.group.position;
      const toCam: Vec = [cx - g.x, cy - g.y, cz - g.z];
      const ppa = this.rig.pxPerAu(Math.hypot(...toCam), this.height);
      // close in, the centre runs on its own clock, since the timeline is gone there
      const near = Math.hypot(...toCam) < HOLE_CLOCK_AU;
      if (near !== store.hole.shown) {
        store.setHole({ shown: near });
      }
      if (store.hole.playing) {
        store.setHole({ day: store.hole.day + HOLE_SPEEDS[store.hole.speedIndex] * dt });
      }
      this.sgr.update(near ? store.hole.day : day, toCam, ppa, trueSize, layers.orbits, pr);
      const side = this.sgr.quadPx(ppa) * pr;
      const area = Math.min(side * side, this.width * this.height * pr * pr);
      if (dt > 0) {
        this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
      }
      // only blame the disk for slow frames while it is big enough to be the cause
      if (this.sgr.close && area > HOLE_SLOW_AREA) {
        if (this.frameMs > 22) {
          this.holeBudget = Math.max(HOLE_BUDGET / 8, this.holeBudget * 0.95);
        } else if (this.frameMs < 18) {
          this.holeBudget = Math.min(area * 1.1, this.holeBudget * 1.02);
        }
      }
      this.holeBudget = Math.max(this.holeBudget, HOLE_BUDGET / 8);
      this.holeScale = Math.min(1, Math.sqrt(this.holeBudget / Math.max(area, 1)));
      this.sgr.quad.layers.set(this.sgr.close && this.holeScale < 0.95 ? HOLE_LAYER : 0);
      if (onVoid) {
        this.sgr.group.visible = false;
      }
    }
    // from far out the catalogued stars are a small clump around the Sun; let the Galaxy model take over
    // the measured stars reach only a few thousand light years, so from out where the whole Galaxy shows they
    // would only pile up into a blob at the Sun
    const starsGone = MathUtils.smoothstep(Math.log10(sunDist / AU_PER_LY), 4.3, 4.9);
    this.stars3d.update(1, sunDist, camDist, onVoid ? 0 : (1 - 0.75 * galaxy) * (1 - starsGone));

    this.renderer.clear();
    this.skyCamera.quaternion.copy(cam.quaternion);
    this.skyCamera.fov = cam.fov;
    this.skyCamera.aspect = cam.aspect;
    this.skyCamera.updateProjectionMatrix();
    this.renderer.render(this.sky, this.skyCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, cam);
    if (this.cosmicflows.visible || this.surveys.some((s) => s.visible)) {
      // zoomed in among the galaxies they spread out over the screen, few to a pixel: expose for longer
      const zoomLy = this.rig.distance / AU_PER_LY;
      this.webPass.gain.value = 4 * MathUtils.clamp((WEB_EXPOSE_LY / zoomLy) ** 0.7, 1, 30);
      this.webPass.render(this.renderer, this.scene, cam, WEB_LAYER, 1);
    }
    if (this.sgr?.quad.layers.isEnabled(HOLE_LAYER)) {
      this.holePass.render(this.renderer, this.scene, cam, HOLE_LAYER, this.holeScale);
    }

    this.crafts.render(this.renderer, cam);

    if (layers.labels) {
      this.layoutLabels(selectedId, camDist);
    } else {
      this.labels.render([]);
    }
    this.lastDay = day;
  }

  /** Drops bodies hidden behind a sphere that is big on screen, so their labels don't show through it. */
  private placeCraft(
    b: Body,
    p: Vec,
    earth: Vec,
    px: number,
    rel: Vec,
    radius: number,
    day: number,
    time: AstroTime,
  ) {
    const frame: Frame = {
      toEarth: [earth[0] - p[0], earth[1] - p[1], earth[2] - p[2]],
      toSun: [-p[0], -p[1], -p[2]],
    };
    // the models are drawn over everything else, so one behind the planet it circles has to be left out here
    const q = b.parent ? this.positions.get(b.parent) : undefined;
    const R = b.parent ? (this.visuals.get(b.parent)?.radiusAu ?? 0) : 0;
    if (q && R) {
      const o: Vec = [q[0] - p[0] + rel[0], q[1] - p[1] + rel[1], q[2] - p[2] + rel[2]];
      const len = Math.hypot(...rel);
      const along = (o[0] * rel[0] + o[1] * rel[1] + o[2] * rel[2]) / len;
      if (along > 0 && along < len && Math.hypot(...o) ** 2 - along ** 2 < R * R) {
        return;
      }
    }
    if (b.orbit === 'leo') {
      // round Earth in 90 minutes, so the hour-wide difference in eph.velocity is far too coarse
      const dt = 30 / 86400;
      const a = this.eph.local(b.id, day - dt);
      const c = this.eph.local(b.id, day + dt);
      const up = this.eph.local(b.id, day, time);
      if (a && c && up) {
        frame.velocity = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        frame.up = up;
      }
    }
    this.crafts.place(b.id, px, rel, radius, frame);
  }

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
    if (!this.store.layers.orbits || this.onVoid || !p || !parent || craftHidden) {
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
    if (spec.kind === 'halo') {
      line.line.rotation.z = this.earthAngle(day);
    }

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

  /** Shows L2 while JWST's loop round it does, as far beyond Earth as it is, straight away from the Sun. */
  private placeL2() {
    const loop = this.orbits.get('jwst')?.line;
    const e = this.positions.get('earth');
    const shown = !!loop?.line.visible && !!e;
    this.l2.visible = shown;
    this.l2Pos = null;
    if (!shown || !loop || !e) {
      return;
    }
    const r = Math.hypot(...e);
    const p: Vec = [e[0] * (1 + L2_AU / r), e[1] * (1 + L2_AU / r), e[2] * (1 + L2_AU / r)];
    this.l2Pos = p;
    const a = loop.material.uniforms.opacity.value as number;
    const line = this.l2Line.geometry.getAttribute('position') as BufferAttribute;
    line.setXYZ(1, p[0], p[1], p[2]);
    line.needsUpdate = true;
    this.l2Line.computeLineDistances();
    (this.l2Line.material as LineDashedMaterial).opacity = a * 0.7;
    const mark = this.l2Mark.geometry.getAttribute('position') as BufferAttribute;
    mark.setXYZ(0, p[0], p[1], p[2]);
    mark.needsUpdate = true;
    (this.l2Mark.material as PointsMaterial).opacity = Math.min(1, a * 1.6);
  }

  private layoutLabels(selectedId: string | null, camDist: number) {
    // on a void, only what the observer at this zoom could see is named, as with the galaxies' brightness
    const reach = SEEN.reach.value * 3 * camDist;
    const place = (p: Vec) =>
      this.onVoid && Math.hypot(p[0] - this.camPos[0], p[1] - this.camPos[1], p[2] - this.camPos[2]) > reach
        ? null
        : this.screenOf(p);
    const entries: LabelEntry[] = [];
    const sun = this.projected.get('sun');
    for (const [id, pr] of this.projected) {
      const b = this.store.bodyById.get(id) as Body;
      const parent = this.projected.get(b.parent ?? 'sun');
      const important = id === selectedId || id === this.rig.focusId;
      // the camera follows what it is focused on, so only that one's label holds still
      const speed = this.labelSpeed.get(id) ?? 0;
      const fast = this.fastLabels.has(id) ? speed > LABEL_SLOW_AGAIN : speed > LABEL_TOO_FAST;
      if (fast) {
        this.fastLabels.add(id);
      } else {
        this.fastLabels.delete(id);
      }
      if (fast && id !== this.rig.focusId) {
        continue;
      }
      // with the Galaxy drawn bigger than it is the Sun's real place no longer lines up with it, and from the
      // Local Group its name would only crowd out the Galaxy's
      const lg = Math.hypot(...this.camPos) > LOCAL_GROUP_LABELS * AU_PER_LY;
      if (id === 'sun' && (this.galaxy.grow > 1.05 || lg) && !important) {
        continue;
      }
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
      const at = this.deepSky.find((o) => o.id === `region:${reg.id}`);
      // a cluster is labelled by how far the camera is from it, a shell around the Sun by the zoom
      const d = at
        ? Math.hypot(at.pos[0] - this.camPos[0], at.pos[1] - this.camPos[1], at.pos[2] - this.camPos[2])
        : camDist;
      // galaxies stand alone in empty space, so their names can stay on much further out
      const far =
        reg.at?.type === 'galaxy'
          ? reg.at.home || M31_SYSTEM.has(reg.id)
            ? Number.POSITIVE_INFINITY
            : reg.view * 20
          : reg.at?.type === 'blackhole'
            ? 1e9
            : // a nebula on screen can be named from however far it is drawn
              reg.at?.type === 'nebula' && this.nebulae.shown.has(reg.id)
              ? Number.POSITIVE_INFINITY
              : // the label goes with the cloud's outer shell
                reg.id === 'oort-cloud'
                ? OORT_GONE
                : reg.view * 6;
      if (d < (reg.at?.type === 'blackhole' ? 0 : reg.view / 9) || d > far) {
        continue;
      }
      // out on a void the Galaxy is a speck; what lies inside it is not labelled
      if (this.onVoid && reg.at?.type !== 'galaxy' && reg.at?.type !== 'void') {
        continue;
      }
      // nor while zoomed in on something small, as the galaxies themselves fade then
      if (reg.at?.type === 'galaxy' && !reg.at.home && Galaxy.presence(camDist) < 0.3) {
        continue;
      }
      if (at) {
        const s = place(at.pos);
        if (s) {
          entries.push({
            id: `region:${reg.id}`,
            text: reg.name,
            x: s.x,
            y: s.y,
            priority: 90,
            color: '#c9b8ff',
            className: 'region dso',
            offset: 10,
          });
        }
        continue;
      }
      const inner = reg.inner ?? 0;
      const outer = reg.outer ?? 0;
      const mid = reg.id === 'oort-cloud' ? outer * 0.8 : (inner + outer) / 2;
      const ang = MathUtils.degToRad(reg.id === 'oort-cloud' ? 40 : 205);
      const s = place([Math.cos(ang) * mid, Math.sin(ang) * mid, reg.id === 'oort-cloud' ? mid * 0.35 : 0]);
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

    if (this.l2Pos) {
      const s = place(this.l2Pos);
      if (s) {
        entries.push({
          id: 'l2',
          text: t.l2,
          x: s.x,
          // above the ring, centred, as JWST's own name sits to the right and it is usually close by
          y: s.y - 16,
          priority: 70,
          color: '#c4de54',
          className: 'region',
          offset: -(t.l2.length * 6.6 + 8) / 2,
        });
      }
    }
    const galaxy = Galaxy.presence(Math.hypot(...this.camPos));
    if (this.sgr?.close) {
      for (const [k, name] of this.sgr.stars.entries()) {
        const s = place(this.sgr.positionOf(k));
        if (s) {
          entries.push({
            id: `sstar:${name}`,
            text: name,
            x: s.x,
            y: s.y,
            priority: 40,
            color: '#cfe0ff',
            className: 'region',
            offset: 8,
          });
        }
      }
    }
    if (galaxy > 0.5 && !this.onVoid) {
      for (const arm of ARMS) {
        const r = ARM_LABEL_R[arm.id];
        const s = place(this.galaxy.place(galactic(r, armBeta(arm, r), 0)));
        if (s) {
          const text = t.arms.get(arm.id) ?? arm.id;
          entries.push({
            id: `arm:${arm.id}`,
            text,
            x: s.x,
            y: s.y,
            priority: 30,
            color: '#a598f0',
            className: 'region',
            offset: -((text.length * 6.6) / 2),
          });
        }
      }
    }
    // the brighter dwarf galaxies, once out at the scale of the Local Group
    const sunLy = Math.hypot(...this.camPos) / AU_PER_LY;
    if (sunLy > LOCAL_GROUP_LABELS && sunLy < 3e7 && Galaxy.presence(camDist) > 0.3) {
      for (const d of this.localGroup.named) {
        const s = place(this.localGroup.placeOf(d));
        if (s) {
          entries.push({
            id: `lg:${d.name}`,
            text: d.name,
            x: s.x,
            y: s.y,
            priority: 25 - d.mag,
            color: '#b9c6e6',
            className: 'region',
            offset: 7,
          });
        }
      }
    }
    for (const c of this.cosmicflows.clusters) {
      if (!Cosmicflows.labelled(Math.hypot(...this.camPos))) {
        continue;
      }
      const s = place(this.cosmicflows.placeOf(c.at));
      if (s) {
        entries.push({
          id: `cf:${c.id}`,
          text: t.clusters[c.id as keyof typeof t.clusters],
          x: s.x,
          y: s.y,
          priority: 60,
          color: '#e8d9b8',
          className: 'region',
          offset: -((t.clusters[c.id as keyof typeof t.clusters].length * 6.6) / 2),
        });
      }
    }
    // the brightest galaxies past the Local Group, once out among them
    if (
      LocalVolume.labelled(Math.hypot(...this.camPos)) &&
      Galaxy.presence(camDist) > 0.3 &&
      Math.hypot(...this.camPos) < 1.2e8 * AU_PER_LY
    ) {
      for (const d of this.localVolume.named) {
        const s = place(this.localVolume.placeOf(d.at));
        if (s) {
          entries.push({
            id: `lv:${d.name}`,
            text: d.name,
            x: s.x,
            y: s.y,
            priority: 20 - d.mag,
            color: '#b9c6e6',
            className: 'region',
            offset: 7,
          });
        }
      }
    }
    if (Stars3D.presence(camDist) > 0.3 && galaxy < 0.5 && !this.onVoid) {
      const exposure = Stars3D.exposure(Math.hypot(...this.camPos));
      const bright: { i: number; name: string; mag: number; x: number; y: number }[] = [];
      for (const [i, name] of this.stars.labels) {
        const sp = this.stars3d.position(i);
        const d = Math.hypot(sp[0] - this.camPos[0], sp[1] - this.camPos[1], sp[2] - this.camPos[2]);
        // label the ones that look brightest from here
        const mag = this.stars3d.absmag(i) + 5 * Math.log10(d / 206264.806) - 5 - exposure;
        const p = mag < 3 ? place(sp) : null;
        if (p) {
          bright.push({ i, name, mag, x: p.x, y: p.y });
        }
      }
      bright.sort((a, b) => a.mag - b.mag);
      for (const s of bright.slice(0, STAR_LABELS)) {
        entries.push({
          id: `star:${s.i}`,
          text: t.starNames.get(s.name) ?? s.name,
          x: s.x,
          y: s.y,
          priority: 60 - s.mag * 4,
          color: '#ffe9c4',
          className: 'star',
          offset: 8,
        });
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
