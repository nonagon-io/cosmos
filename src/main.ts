import { galaxyLook } from './scene/galaxy';
import './styles.css';
import { Ephemeris, type OrbitData } from './astro/ephemeris';
import { loadLocalized } from './data/load';
import { type Body, DataError, type Region, type SpaceEvent, type View } from './data/schema';
import { applyStatic, LOCALES, type Locale, locale, switchLocale, t, takeResume } from './i18n';
import { type LocalGroupRow, M31_SYSTEM } from './scene/localgroup';
import type { LocalVolumeRow } from './scene/localvolume';
import type { ElementSets } from './scene/particles';
import { eclipticDir, type StarData, type StarField } from './scene/stars';
import { World } from './scene/world';
import { setupSearch } from './search';
import { DEEP_RANGE, Store } from './store';
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

async function json<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}data/${name}`);
  if (!res.ok) {
    throw new Error(`${name}: ${res.status}`);
  }
  return (await res.json()) as T;
}

async function start() {
  applyStatic();
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
    const [moons, named, craft, planets, small, starData, lgData, lvData, fieldData, cfData] =
      await Promise.all([
        json<OrbitData['moons']>('moons.json'),
        json<OrbitData['named']>('named.json'),
        json<OrbitData['craft']>('spacecraft.json'),
        json<OrbitData['planets']>('planets.json'),
        json<ElementSets>('small-bodies.json'),
        json<StarData>('stars.json'),
        json<LocalGroupRow[]>('localgroup.json'),
        json<LocalVolumeRow[]>('localvolume.json'),
        fetch(`${BASE}data/field.bin`).then((r) => {
          if (!r.ok) {
            throw new Error(`field.bin: ${r.status}`);
          }
          return r.arrayBuffer();
        }),
        fetch(`${BASE}data/cosmicflows.bin`).then((r) => {
          if (!r.ok) {
            throw new Error(`cosmicflows.bin: ${r.status}`);
          }
          return r.arrayBuffer();
        }),
      ]);
    orbitData = { moons, named, craft, planets };
    sets = small;
    stars = starData;
    localGroup = lgData;
    localVolume = lvData;
    cosmicflows = new Uint16Array(cfData);
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
    if (b.kind === 'spacecraft') {
      return 0.02;
    }
    const r = world.minDistance(b.id);
    return Math.max(r * 6, b.kind === 'planet' ? r * 9 : r * 6);
  };

  // around a black hole, look the way we see it from Earth, so the S-star orbits look like the published ones;
  // Andromeda and Triangulum too, so they look as photographed
  const lineOfSight = (id: string) => {
    const at = store.regionById.get(id)?.at;
    return at && (at.type === 'blackhole' || M31_SYSTEM.has(id)) ? eclipticDir(at.ra, at.dec) : undefined;
  };
  const actions = {
    goToBody(b: Body) {
      store.select({ kind: 'body', body: b });
      // a craft not launched yet: jump to just after launch so there is something to fly to
      if (!eph.exists(b.id, store.day)) {
        store.setDay(eph.firstDay(b.id) + 2);
      }
      rig.flyTo(b.id, viewDistance(b));
    },
    centerOn(b: Body) {
      if (!eph.exists(b.id, store.day)) {
        store.setDay(eph.firstDay(b.id) + 2);
      }
      // keep the zoom level, just move the pivot
      rig.flyTo(b.id, rig.distance);
    },
    goToRegion(r: Region) {
      store.select({ kind: 'region', region: r });
      // edge on, the whole disk piles up in one line of sight; look at the Galaxy and its centre from above
      rig.flyTo(
        r.at ? `region:${r.id}` : 'sun',
        r.view,
        undefined,
        r.at?.home ? galaxyLook(55) : lineOfSight(r.id),
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
        lineOfSight(e.focus),
      );
    },
    goToView(v: View) {
      const id = v.also ? `view:${v.id}` : store.regionById.has(v.focus) ? `region:${v.focus}` : v.focus;
      rig.flyTo(id, v.distance, undefined, v.tilt === undefined ? lineOfSight(v.focus) : galaxyLook(v.tilt));
    },
    positionOf: (id: string) => world.positions.get(id) ?? null,
    velocityOf: (id: string) => eph.velocity(id, store.day),
    camera: () => ({ focus: rig.focusId, distance: rig.distance }),
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
  setupSearch(store, (h) => {
    if (h.kind === 'body') {
      actions.goToBody(h.item);
    } else if (h.kind === 'region') {
      actions.goToRegion(h.item);
    } else {
      actions.goToEvent(h.item);
    }
  });

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
      store.setPlaying(!store.playing);
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
    } else if (e.key === 'c' && store.selection?.kind === 'body') {
      actions.centerOn(store.selection.body);
    } else if (e.key === 'v') {
      ui.toggleChase();
    }
  });

  const langSel = document.getElementById('lang') as HTMLSelectElement;
  langSel.innerHTML = Object.entries(LOCALES)
    .map(([k, label]) => `<option value="${k}">${label}</option>`)
    .join('');
  langSel.value = locale;
  langSel.addEventListener('change', () => {
    const s = store.selection;
    const sel = s
      ? { kind: s.kind, id: s.kind === 'body' ? s.body.id : s.kind === 'region' ? s.region.id : s.event.id }
      : undefined;
    switchLocale(langSel.value as Locale, {
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
    if (store.deep) {
      if (store.playing) {
        store.setMyr(store.myr + store.deepSpeed * dt);
        if (Math.abs(store.myr) === DEEP_RANGE) {
          store.setPlaying(false);
        }
      }
    } else if (store.myr !== 0) {
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
  } else if (!matchMedia('(max-width: 680px), (max-height: 520px)').matches) {
    store.select({ kind: 'body', body: store.bodyById.get('earth') as Body });
  }

  await document.fonts.ready;
  reveal();
}

void start();
