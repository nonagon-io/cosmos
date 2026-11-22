import { galaxyLook } from './scene/galaxy';
import './styles.css';
import { Ephemeris, type OrbitData } from './astro/ephemeris';
import type { Vec } from './astro/kepler';
import { setupBrowse } from './browse';
import { loadLocalized } from './data/load';
import { type Body, DataError, type Region, type SpaceEvent, type View } from './data/schema';
import { dropdown } from './dropdown';
import { setupHoleClock } from './holeclock';
import { applyStatic, LOCALES, type Locale, locale, routeId, switchLocale, t, takeResume } from './i18n';
import { routeUrl } from './route';
import { type LocalGroupRow, M31_SYSTEM } from './scene/localgroup';
import type { LocalVolumeRow } from './scene/localvolume';
import type { ElementSets } from './scene/particles';
import { AU_PER_LY, eclipticDir, type StarData, type StarField } from './scene/stars';
import type { SurveyManifest, SurveyName } from './scene/survey';
import { World } from './scene/world';
import { type Hit, setupSearch } from './search';
import { COSMIC_RANGE, DEEP_RANGE, type Selection, Store } from './store';
import { setupTimeline } from './timeline';
import { setupUI } from './ui';

const BASE = import.meta.env.BASE_URL;
const reveal = () => document.documentElement.classList.remove('booting');

interface Resume {
  day: number;
  focus: string;
  distance: number;
  yaw: number;
  pitch: number;
  sel?: { kind: string; id: string };
}

function showError(title: string, problems: string[], hint = '') {
  reveal();
  const el = document.getElementById('data-error') as HTMLElement;
  el.hidden = false;
  el.innerHTML = `<h2></h2><p></p><ul>${problems.map(() => '<li></li>').join('')}</ul>`;
  (el.querySelector('h2') as HTMLElement).textContent = title;
  (el.querySelector('p') as HTMLElement).textContent = hint;
  for (const [i, li] of [...el.querySelectorAll('li')].entries()) {
    li.textContent = problems[i];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The survey galaxies come last and in pieces: a survey's first file once the page is up, the rest only when
 * the camera heads out past `restFrom` light years with the survey's layer on, and not at all when the browser
 * asks to save data.
 */
async function streamSurvey(world: World, store: Store, name: SurveyName, restFrom: number) {
  let manifest: SurveyManifest;
  try {
    manifest = await json<SurveyManifest>(`${name}.json`);
  } catch {
    return;
  }
  const layer = world.addSurvey(name, manifest);
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  for (let k = 0; k < manifest.files; k++) {
    if (k === 1) {
      if (saveData) {
        return;
      }
      while (!world.outPast(restFrom) || !store.layers[name]) {
        await sleep(500);
      }
    }
    const res = await fetch(`${BASE}data/${name}-${k}.bin`);
    if (!res.ok) {
      return;
    }
    layer.add(new Uint16Array(await res.arrayBuffer()));
  }
}

async function bin(name: string) {
  const r = await fetch(`${BASE}data/${name}`);
  if (!r.ok) {
    throw new Error(`${name}: ${r.status}`);
  }
  return r.arrayBuffer();
}

async function json<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}data/${name}`);
  if (!res.ok) {
    throw new Error(`${name}: ${res.status}`);
  }
  return (await res.json()) as T;
}

const selId = (s: Selection) =>
  s ? (s.kind === 'body' ? s.body.id : s.kind === 'region' ? s.region.id : s.event.id) : null;
const selName = (s: Selection) =>
  s ? (s.kind === 'body' ? s.body.name : s.kind === 'region' ? s.region.name : s.event.title) : null;

async function start() {
  applyStatic();
  // the build's text for crawlers and screen readers without JS; the card says the same once it opens
  document.getElementById('about')?.remove();
  let store: Store;
  try {
    store = new Store(await loadLocalized(locale));
  } catch (e) {
    if (e instanceof DataError) {
      showError(t.dataError(e.problems.length), e.problems, t.dataErrorHint);
      return;
    }
    throw e;
  }

  let orbitData: OrbitData;
  let sets: ElementSets;
  let stars: StarData;
  let field: StarField;
  let localGroup: LocalGroupRow[];
  let localVolume: LocalVolumeRow[];
  let cosmicflows: Uint16Array;
  try {
    const [
      moons,
      named,
      craft,
      planets,
      small,
      starData,
      lgData,
      lvData,
      fieldData,
      cfData,
      zData,
      sixdfData,
    ] = await Promise.all([
      json<OrbitData['moons']>('moons.json'),
      json<OrbitData['named']>('named.json'),
      json<OrbitData['craft']>('spacecraft.json'),
      json<OrbitData['planets']>('planets.json'),
      json<ElementSets>('small-bodies.json'),
      json<StarData>('stars.json'),
      json<LocalGroupRow[]>('localgroup.json'),
      json<LocalVolumeRow[]>('localvolume.json'),
      bin('field.bin'),
      bin('cosmicflows.bin'),
      bin('redshifts.bin'),
      bin('sixdf.bin'),
    ]);
    orbitData = { moons, named, craft, planets };
    sets = small;
    stars = starData;
    localGroup = lgData;
    localVolume = lvData;
    // galaxies with measured distances, then those placed by redshift: drawn alike
    cosmicflows = new Uint16Array([cfData, zData, sixdfData].flatMap((b) => [...new Uint16Array(b)]));
    field = new Float32Array(fieldData);
  } catch (e) {
    showError(t.loadError, [(e as Error).message]);
    return;
  }

  const resume = takeResume<Resume>();
  if (resume) {
    store.setDay(resume.day);
  }
  const eph = new Ephemeris(store.data.bodies, orbitData);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const world = new World(
    canvas,
    document.getElementById('labels') as HTMLElement,
    store,
    eph,
    orbitData,
    sets,
    stars,
    field,
    localGroup,
    localVolume,
    cosmicflows,
    (id) => pickLabel(id),
  );
  const rig = world.rig;
  void sleep(1500).then(() => {
    void streamSurvey(world, store, 'sdss', 1e8);
    void streamSurvey(world, store, 'desi', 1e9);
    void streamSurvey(world, store, 'quaia', 1e9);
  });
  // a moon's heading is the one around its planet, not the planet's own around the Sun
  rig.velocityOf = (id) => {
    const v = eph.velocity(id, store.day);
    const b = store.bodyById.get(id);
    const pv = v && b?.kind === 'moon' && b.parent ? eph.velocity(b.parent, store.day) : null;
    return v && pv ? [v[0] - pv[0], v[1] - pv[1], v[2] - pv[2]] : v;
  };
  if (resume) {
    rig.jumpTo(resume.focus, resume.distance);
    rig.yaw = resume.yaw;
    rig.pitch = resume.pitch;
  }
  if (import.meta.env.DEV) {
    Object.assign(window, { __world: world, __store: store, __eph: eph });
  }

  // a camera distance that frames a body with room for its moons
  const viewDistance = (b: Body) => {
    const r = world.minDistance(b.id);
    if (b.kind === 'spacecraft') {
      return b.model ? r * 5 : 0.02;
    }
    return Math.max(r * 6, b.kind === 'planet' ? r * 9 : r * 6);
  };

  // around a black hole, look the way we see it from Earth, so the S-star orbits look like the published ones;
  // Andromeda, Triangulum and the nebulae too, so they look as photographed
  const lineOfSight = (id: string, distance = Number.POSITIVE_INFINITY): [Vec | undefined, number] => {
    const at = store.regionById.get(id)?.at;
    // close in on the hole itself, and on arriving there, the disk is shown nearly edge on instead, turned the
    // way the film pictures show it; the S-star views further out keep our line of sight
    if (at?.type === 'blackhole' && (distance < 100 || distance === store.regionById.get(id)?.view)) {
      const h = world.holeLook();
      if (h) {
        return [h.look, h.roll];
      }
    }
    // a void is seen from well off our line of sight: zooming out straight back along it would fly the camera
    // through the Milky Way, where the galaxy catalogues give way to our own neighbourhood
    if (at?.type === 'void') {
      const d = eclipticDir(at.ra, at.dec);
      const side: Vec = [d[1], -d[0], 0];
      const sl = Math.hypot(...side) || 1;
      const a = (35 * Math.PI) / 180;
      return [[0, 1, 2].map((c) => Math.cos(a) * d[c] + (Math.sin(a) * side[c]) / sl) as Vec, 0];
    }
    return [
      at && (at.type === 'blackhole' || at.type === 'nebula' || M31_SYSTEM.has(id))
        ? eclipticDir(at.ra, at.dec)
        : undefined,
      0,
    ];
  };
  // a craft seen three quarters on, from the Earth side and a little above, so the dish shows as a dish
  const craftLook = (id: string): Vec | undefined => {
    const p = world.positions.get(id);
    const e = world.positions.get('earth');
    if (!p || !e) {
      return undefined;
    }
    const d = [e[0] - p[0], e[1] - p[1], e[2] - p[2]];
    const l = Math.hypot(...d);
    const u = d.map((x) => x / l);
    // across the line to Earth, in the ecliptic plane
    const s = [u[1], -u[0], 0];
    const sl = Math.hypot(...s) || 1;
    const v = [0, 1, 2].map((c) => -0.55 * u[c] + (0.75 * s[c]) / sl + (c === 2 ? -0.35 : 0));
    const vl = Math.hypot(...v);
    return [v[0] / vl, v[1] / vl, v[2] / vl];
  };
  const actions = {
    goToBody(b: Body) {
      store.select({ kind: 'body', body: b });
      // a craft not launched yet: jump to just after launch so there is something to fly to
      if (!eph.exists(b.id, store.day)) {
        store.setDay(eph.firstDay(b.id) + 2);
      }
      rig.flyTo(b.id, viewDistance(b), undefined, b.model ? craftLook(b.id) : undefined);
    },
    centerOn(b: Body) {
      if (!eph.exists(b.id, store.day)) {
        store.setDay(eph.firstDay(b.id) + 2);
      }
      rig.turnTo(b.id);
    },
    centerOnRegion(r: Region) {
      rig.turnTo(r.at ? `region:${r.id}` : 'sun');
    },
    /** Centres on whatever an event is about, keeping the date. */
    centerOnEvent(e: SpaceEvent) {
      const b = store.bodyById.get(e.focus);
      const r = store.regionById.get(e.focus);
      if (b) {
        actions.centerOn(b);
      } else if (r) {
        actions.centerOnRegion(r);
      }
    },
    goToRegion(r: Region) {
      store.select({ kind: 'region', region: r });
      // edge on, the whole disk piles up in one line of sight; look at the Galaxy and its centre from above
      rig.flyTo(
        r.at ? `region:${r.id}` : 'sun',
        r.view,
        undefined,
        ...(r.at?.home ? ([galaxyLook(55), 0] as [Vec, number]) : lineOfSight(r.id, r.view)),
      );
    },
    goToEvent(e: SpaceEvent) {
      store.setPlaying(false);
      store.setDay(store.eventDay(e));
      store.select({ kind: 'event', event: e });
      rig.flyTo(
        store.regionById.has(e.focus) ? `region:${e.focus}` : e.focus,
        e.distance,
        undefined,
        ...lineOfSight(e.focus, e.distance),
      );
    },
    resolveView(v: View): View {
      if (!v.relative) {
        return v;
      }
      if (v.relative === 'region') {
        const r = store.regionById.get(rig.focusId.slice(7)) ?? store.regionById.get(v.focus);
        return r?.at ? { ...v, focus: r.id, name: r.name, distance: r.at.radius * AU_PER_LY * 3.5 } : v;
      }
      // the body the camera is on, unless that is the Sun, whose family is the rest of the ladder
      const f = rig.focusId;
      const id = store.bodyById.has(f) && f !== 'sun' ? f : v.focus;
      const r = world.minDistance(id);
      if (v.relative === 'body') {
        return { ...v, focus: id, distance: r * 5 };
      }
      const p = world.positions.get(id);
      let far = 0;
      for (const b of store.data.bodies) {
        const q = b.parent === id ? world.positions.get(b.id) : undefined;
        if (p && q) {
          far = Math.max(far, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
        }
      }
      return { ...v, focus: id, distance: far > 0 ? far * 4.7 : r * 40 };
    },
    /**
     * The stops for wherever the camera is: a region with stops of its own gets those, any other region one
     * stop framing it, and everything else the Solar System's. The shared stops from the Galaxy out follow,
     * those above the last of the region's kept on the region.
     */
    ladder(): View[] {
      const f = rig.focusId;
      const rid = f.startsWith('region:') && f !== 'region:milky-way' ? f.slice(7) : '';
      const all = store.data.views;
      const craft = store.bodyById.get(f);
      if (craft?.kind === 'spacecraft') {
        return [...this.craftStops(craft), ...all.filter((v) => !v.ladder)];
      }
      const kind = !rid ? 'solar' : all.some((v) => v.ladder === rid) ? rid : 'region';
      const own = all.filter((v) => v.ladder === kind).map((v) => this.resolveView(v));
      if (kind === 'solar') {
        return [...own, ...all.filter((v) => !v.ladder)];
      }
      const top = Math.max(...own.map((v) => v.distance)) * 1.5;
      const shared = all.filter(
        (v) =>
          !v.ladder &&
          v.distance > top &&
          // a pair framed together only when the region is one of them, or inside the Galaxy
          (!v.also || kind !== 'region' || v.focus === rid || v.also === rid),
      );
      return [...own, ...shared.map((v) => (v.also ? v : { ...v, focus: rid }))];
    },
    /**
     * A craft is metres across and AU from anything: the whole craft, then the world it is passing if one is
     * close, then the craft with the Sun, then the Solar System's stops wider than that, all kept on the craft.
     */
    craftStops(b: Body): View[] {
      const p = world.positions.get(b.id);
      const base = { focus: b.id, ladder: 'craft' };
      const stops: View[] = [
        { ...base, id: 'craft', name: t.craftWhole, distance: world.minDistance(b.id) * 5 },
      ];
      if (!p) {
        return stops;
      }
      const sun = Math.hypot(...p);
      let near: Body | null = null;
      let nearD = Number.POSITIVE_INFINITY;
      // one that circles a planet is framed with it, even when the Moon happens to be nearer
      const candidates = b.parent ? [store.bodyById.get(b.parent) as Body] : store.data.bodies;
      for (const o of candidates) {
        const q = o.kind === 'spacecraft' || o.id === 'sun' ? undefined : world.positions.get(o.id);
        const d = q ? Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) : nearD;
        if (d < nearD) {
          near = o;
          nearD = d;
        }
      }
      // a world counts as close within a fifth of the way to the Sun, and as long as it would show as more
      // than a dot from there
      if (near && nearD < sun * 0.2 && world.minDistance(near.id) * 400 > nearD) {
        stops.push({ ...base, id: 'craft-near', name: t.craftWith(near.name), distance: nearD * 2.6 });
      }
      const wide = sun * 2.4;
      stops.push({ ...base, id: 'craft-sun', name: t.craftSun, distance: wide });
      return [
        ...stops,
        ...store.data.views.filter((v) => v.ladder === 'solar' && !v.relative && v.distance > wide * 1.5),
      ];
    },
    goToView(view: View) {
      const v = this.resolveView(view);
      // the Solar System stops only set how far out: centred on a planet, a comet or anything else, stay on it
      const here = rig.focusId;
      if (v.focus === 'sun' && here !== 'sun' && store.bodyById.has(here)) {
        rig.flyTo(here, v.distance);
        return;
      }
      if (v.id === 'craft') {
        rig.flyTo(v.focus, v.distance, undefined, craftLook(v.focus));
        return;
      }
      const id = v.also ? `view:${v.id}` : store.regionById.has(v.focus) ? `region:${v.focus}` : v.focus;
      rig.flyTo(
        id,
        v.distance,
        undefined,
        ...(v.tilt === undefined
          ? lineOfSight(v.focus, v.distance)
          : ([galaxyLook(v.tilt), 0] as [Vec, number])),
      );
    },
    positionOf: (id: string) => world.positions.get(id) ?? null,
    velocityOf: (id: string) => eph.velocity(id, store.day),
    camera: () => ({ focus: rig.focusId, distance: rig.distance }),
    infrared: (id: string, on?: boolean) => world.infrared(id, on),
    infraredFromPhoto: (id: string) => world.infraredFromPhoto(id),
    canChase: () => store.bodyById.has(rig.focusId) && rig.focusId !== 'sun',
    chase(on?: boolean) {
      if (on !== undefined) {
        rig.setChase(on);
      }
      return rig.chase;
    },
    named(id: string) {
      const n = orbitData.named[id];
      if (!n) {
        return null;
      }
      return {
        e: n.elements.e,
        q: n.elements.q,
        pathStart: n.path[0]?.[0] ?? Number.POSITIVE_INFINITY,
        pathEnd: n.path[n.path.length - 1]?.[0] ?? Number.NEGATIVE_INFINITY,
      };
    },
    craftCoastFrom: (id: string) => orbitData.craft[id]?.coastFrom ?? null,
  };

  function pickLabel(id: string) {
    if (id.startsWith('region:')) {
      const r = store.regionById.get(id.slice(7));
      if (r) {
        store.select({ kind: 'region', region: r });
      }
      return;
    }
    if (id.startsWith('star:')) {
      return;
    }
    const b = store.bodyById.get(id);
    if (b) {
      store.select({ kind: 'body', body: b });
    }
  }

  const ui = setupUI(store, actions);
  const timeline = setupTimeline(store, (e) => actions.goToEvent(e));
  setupHoleClock(store);
  const go = (h: Hit) => {
    if (h.kind === 'body') {
      actions.goToBody(h.item);
    } else if (h.kind === 'region') {
      actions.goToRegion(h.item);
    } else {
      actions.goToEvent(h.item);
    }
  };
  setupSearch(store, go);
  setupBrowse(store, go);

  rig.onClick = (x, y) => {
    const id = world.pick(x, y);
    const b = id ? store.bodyById.get(id) : undefined;
    store.select(b ? { kind: 'body', body: b } : null);
  };
  rig.onDoubleClick = (x, y) => {
    const id = world.pick(x, y);
    const b = id ? store.bodyById.get(id) : undefined;
    if (b) {
      actions.goToBody(b);
    }
  };

  addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || e.metaKey || e.ctrlKey) {
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      if (store.hole.shown) {
        store.setHole({ playing: !store.hole.playing });
      } else if (store.timeline) {
        store.setPlaying(!store.playing);
      }
    } else if (e.key === '+' || e.key === '=') {
      rig.zoomBy(0.6);
    } else if (e.key === '-' || e.key === '_') {
      rig.zoomBy(1 / 0.6);
    } else if (e.key === 'ArrowLeft') {
      rig.rotateBy(0.12, 0);
    } else if (e.key === 'ArrowRight') {
      rig.rotateBy(-0.12, 0);
    } else if (e.key === 'ArrowUp') {
      rig.rotateBy(0, 0.1);
    } else if (e.key === 'ArrowDown') {
      rig.rotateBy(0, -0.1);
    } else if (e.key === 'Escape') {
      store.select(null);
    } else if (e.key === '[') {
      timeline.step(-1);
    } else if (e.key === ']') {
      timeline.step(1);
    } else if (e.key === 'f' && store.selection?.kind === 'body') {
      actions.goToBody(store.selection.body);
    } else if (e.key === 'c' && store.selection) {
      const s = store.selection;
      if (s.kind === 'body') {
        actions.centerOn(s.body);
      } else if (s.kind === 'region') {
        actions.centerOnRegion(s.region);
      } else {
        actions.centerOnEvent(s.event);
      }
    } else if (e.key === 'v') {
      ui.toggleChase();
    }
  });

  // each language in its own script, so a reader who can't read the current one still finds theirs
  const LangNames: Record<Locale, string> = { th: 'ไทย', en: 'English' };
  const langMenu = document.getElementById('lang-menu') as HTMLElement;
  (document.getElementById('lang-now') as HTMLElement).textContent = LOCALES[locale];
  langMenu.innerHTML = Object.entries(LangNames)
    .map(
      ([k, name]) =>
        `<label class="chk"><input type="radio" name="lang" value="${k}"${k === locale ? ' checked' : ''}> <span>${name}</span></label>`,
    )
    .join('');
  dropdown(document.getElementById('lang-btn') as HTMLElement, langMenu);
  langMenu.addEventListener('change', (e) => {
    const next = (e.target as HTMLInputElement).value as Locale;
    const s = store.selection;
    const sel = s
      ? { kind: s.kind, id: s.kind === 'body' ? s.body.id : s.kind === 'region' ? s.region.id : s.event.id }
      : undefined;
    switchLocale(next, selId(store.selection), {
      day: store.day,
      focus: rig.focusId,
      distance: rig.distance,
      yaw: rig.yaw,
      pitch: rig.pitch,
      sel,
    } satisfies Resume);
  });

  const resize = () => world.resize(innerWidth, innerHeight);
  addEventListener('resize', resize);
  resize();

  let last = 0;
  const loop = (now: number) => {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (store.cosmic) {
      if (store.playing) {
        // play from an end runs the whole history from the other end
        const v = store.cosmicSpeed;
        if (store.gyr === 0 && v > 0) {
          store.setGyr(-COSMIC_RANGE);
        } else if (store.gyr === -COSMIC_RANGE && v < 0) {
          store.setGyr(0);
        }
        store.setGyr(store.gyr + v * dt);
        if (store.gyr === 0 || store.gyr === -COSMIC_RANGE) {
          store.setPlaying(false);
        }
      }
    } else if (store.gyr !== 0) {
      // back in from the far universe: let it grow back to today's size
      const g = store.gyr * Math.exp(-dt * 2.5);
      store.setGyr(Math.abs(g) < 0.005 ? 0 : g);
    }
    if (store.deep && !store.cosmic) {
      if (store.playing) {
        store.setMyr(store.myr + store.deepSpeed * dt);
        if (Math.abs(store.myr) === DEEP_RANGE) {
          store.setPlaying(false);
        }
      }
    } else if (store.myr !== 0 && !store.deep) {
      // back in from the Galaxy: turn it back to the present, where the Solar System's date belongs
      const m = store.myr * Math.exp(-dt * 2.5);
      store.setMyr(Math.abs(m) < 0.05 ? 0 : m);
    }
    if (store.playing && !store.deep) {
      const prev = store.day;
      const next = Math.min(store.end, Math.max(store.start, prev + store.speed * dt));
      // the day we start from never counts, in either direction, or playback resumed from a stop would stop
      // on the same event again
      const crossed = store.data.events.filter((e) => {
        const d = store.eventDay(e);
        return next > prev ? d > prev && d <= next : d < prev && d >= next;
      });
      if (next < prev) {
        crossed.reverse();
      }
      const stopAt = store.stopAtEvents ? crossed.find((e) => e.importance === 3) : undefined;
      if (stopAt) {
        actions.goToEvent(stopAt);
      } else {
        store.setDay(next);
        const big = crossed.filter((e) => e.importance >= 2).pop();
        if (big) {
          ui.showToast(big);
        }
        if (next === store.end || next === store.start) {
          store.setPlaying(false);
        }
      }
    }
    world.frame(dt);
    ui.tick(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // the object a /<id>/ link names, if there is one
  const linked: Selection = routeId
    ? store.bodyById.has(routeId)
      ? { kind: 'body', body: store.bodyById.get(routeId) as Body }
      : store.regionById.has(routeId)
        ? { kind: 'region', region: store.regionById.get(routeId) as Region }
        : (() => {
            const e = store.data.events.find((x) => x.id === routeId);
            return e ? { kind: 'event', event: e } : null;
          })()
    : null;
  if (resume?.sel) {
    const { kind, id } = resume.sel;
    const b = kind === 'body' ? store.bodyById.get(id) : undefined;
    const r = kind === 'region' ? store.regionById.get(id) : undefined;
    const e = kind === 'event' ? store.data.events.find((x) => x.id === id) : undefined;
    store.select(
      b
        ? { kind: 'body', body: b }
        : r
          ? { kind: 'region', region: r }
          : e
            ? { kind: 'event', event: e }
            : null,
    );
  } else if (linked) {
    if (linked.kind === 'body') {
      actions.goToBody(linked.body);
    } else if (linked.kind === 'region') {
      actions.goToRegion(linked.region);
    } else {
      actions.goToEvent(linked.event);
    }
  } else if (!matchMedia('(max-width: 680px), (max-height: 520px)').matches) {
    store.select({ kind: 'body', body: store.bodyById.get('earth') as Body });
  }
  // Earth opened on its own above stays at the home address; anything picked after that gets its own
  const follow = (s: Selection) => {
    const url = routeUrl(locale, selId(s));
    if (location.pathname !== url) {
      history.replaceState(null, '', url);
    }
    const name = selName(s);
    document.title = name ? `${name} · ${t.title}` : t.metaTitle;
  };
  if (linked || resume?.sel) {
    follow(store.selection);
  } else if (routeId) {
    history.replaceState(null, '', routeUrl(locale, null));
  }
  store.on('select', follow);

  await document.fonts.ready;
  reveal();
}

void start();
