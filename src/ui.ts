import { dateOf, KM_PER_AU } from './astro/ephemeris';
import { periodDays, type Vec } from './astro/kepler';
import type { Body, Region, SpaceEvent, View } from './data/schema';
import { esc, fmtDistance, fmtLightTime, fmtMass, fmtPeriod } from './format';
import { t } from './i18n';
import { M31_SYSTEM } from './scene/localgroup';
import { AU_PER_LY } from './scene/stars';
import type { Layers, Store } from './store';

export interface Actions {
  goToBody(b: Body): void;
  centerOn(b: Body): void;
  canChase(): boolean;
  chase(on?: boolean): boolean;
  goToRegion(r: Region): void;
  goToEvent(e: SpaceEvent): void;
  goToView(view: View): void;
  positionOf(id: string): Vec | null;
  velocityOf(id: string): Vec | null;
  camera(): { focus: string; distance: number };
  named(id: string): { e: number; q: number; pathEnd: number; pathStart: number } | null;
  craftCoastFrom(id: string): number | null;
}

// about 30 light years: past the nearest stars, where the catalogue's thinning starts to show
const FIELD_NOTE_AU = 2e6;
// past the measured stars, until the measured galaxies
const FIELD_NOTE_END_AU = 3e9;
const GALAXY_NOTE_AU = 2.2e12;
// near enough the microwave background's sphere to see it
const CMB_NOTE_AU = 2.4e15;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hypot = (a: Vec, b: Vec = [0, 0, 0]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function setupUI(store: Store, act: Actions) {
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-layer]')) {
    const k = input.dataset.layer as keyof Layers;
    input.checked = store.layers[k];
    input.addEventListener('change', () => store.setLayer(k, input.checked));
  }

  // scale ladder
  const views = $('views');
  views.innerHTML = store.data.views
    .map(
      (v, i) =>
        `<li><button type="button" data-v="${i}">${esc(v.name)}<b>${fmtDistance(v.distance)}</b></button></li>`,
    )
    .join('');
  views.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (b) {
      const v = store.data.views[Number(b.dataset.v)];
      act.goToView(v);
    }
  });
  const cam = $('cam');
  const chaseBtn = $<HTMLButtonElement>('chase');
  const fieldNote = $<HTMLButtonElement>('field-note');
  const fieldText = fieldNote.querySelector('span') as HTMLElement;
  let noteFor = 'star-field';
  fieldNote.addEventListener('click', () => {
    const r = store.regionById.get(noteFor);
    if (r) {
      store.select({ kind: 'region', region: r });
    }
  });
  const toggleChase = () => {
    if (act.canChase()) {
      act.chase(!act.chase());
      chaseBtn.setAttribute('aria-pressed', String(act.chase()));
    }
  };
  chaseBtn.addEventListener('click', toggleChase);
  let lastCam = '';
  const renderCamera = () => {
    const { focus, distance } = act.camera();
    const name =
      store.bodyById.get(focus)?.name ??
      (focus.startsWith('region:') ? store.regionById.get(focus.slice(7))?.name : undefined) ??
      (focus.startsWith('view:')
        ? store.data.views.find((v) => `view:${v.id}` === focus)?.name
        : undefined) ??
      '';
    const text = `${t.camera}<strong>${fmtDistance(distance)}</strong>${esc(t.from(name))}`;
    if (text !== lastCam) {
      cam.innerHTML = text;
      lastCam = text;
    }
    // out among the stars, and again among the galaxies, say up front that the catalogue thins with distance
    const galaxies = distance > GALAXY_NOTE_AU;
    fieldNote.hidden = !galaxies && (distance < FIELD_NOTE_AU || distance > FIELD_NOTE_END_AU);
    const note = distance > CMB_NOTE_AU ? 'cmb' : galaxies ? 'galaxy-field' : 'star-field';
    if (noteFor !== note) {
      noteFor = note;
      fieldText.textContent = note === 'cmb' ? t.cmbNote : galaxies ? t.galaxyNote : t.fieldNote;
    }
    const can = act.canChase();
    chaseBtn.hidden = !can;
    if (!can && act.chase()) {
      act.chase(false);
    }
    chaseBtn.setAttribute('aria-pressed', String(act.chase()));
    // the stop nearest in log distance is the one we are at
    let best = -1;
    let bestD = 0.35;
    for (const [i, v] of store.data.views.entries()) {
      const d = Math.abs(Math.log10(distance / v.distance));
      const at = v.also ? `view:${v.id}` : v.focus;
      if (d < bestD && (at === focus || `region:${at}` === focus || v.focus === 'sun')) {
        best = i;
        bestD = d;
      }
    }
    for (const b of views.querySelectorAll<HTMLElement>('[data-v]')) {
      const now = Number(b.dataset.v) === best;
      if (now && b.getAttribute('aria-current') !== 'true') {
        b.scrollIntoView({ block: 'nearest' });
      }
      b.setAttribute('aria-current', String(now));
    }
  };

  // info card
  const info = $('info');
  const body = $('info-body');
  $('info-x').addEventListener('click', () => store.select(null));
  body.addEventListener('click', (e) => {
    const s = store.selection;
    if (s?.kind === 'body' && (e.target as HTMLElement).closest('[data-center]')) {
      act.centerOn(s.body);
      return;
    }
    const go = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
    if (!go || !s) {
      return;
    }
    if (s.kind === 'body') {
      act.goToBody(s.body);
    } else if (s.kind === 'region') {
      act.goToRegion(s.region);
    } else {
      act.goToEvent(s.event);
    }
  });

  const live = { el: null as HTMLElement | null };

  const renderSelection = () => {
    const s = store.selection;
    info.hidden = !s;
    live.el = null;
    if (!s) {
      return;
    }
    if (s.kind === 'body') {
      body.innerHTML = bodyCard(s.body);
      live.el = body.querySelector('[data-live]');
      renderLive();
    } else if (s.kind === 'region') {
      body.innerHTML = regionCard(s.region);
    } else {
      body.innerHTML = eventCard(s.event);
    }
    info.scrollTop = 0;
  };

  const kindLine = (b: Body) => {
    const parent = b.parent ? store.bodyById.get(b.parent) : undefined;
    return parent && b.kind === 'moon' ? t.moonOf(parent.name) : t.kinds[b.kind];
  };

  const bodyCard = (b: Body) => {
    const rows: [string, string][] = [];
    if (b.shape) {
      const d = b.shape.axes.map((a) => a * 2);
      rows.push([t.size, d[0] >= 2 ? t.dimensionsKm(d) : t.dimensionsM(d.map((x) => x * 1000))]);
    } else if (b.radius) {
      rows.push([t.radius, t.km(b.radius)]);
    }
    if (b.mass) {
      rows.push([t.mass, fmtMass(b.mass)]);
    }
    const n = act.named(b.id);
    const period = b.period ?? (n && n.e < 1 ? periodDays(n.q / (1 - n.e)) : undefined);
    if (period) {
      rows.push([t.orbitPeriod, fmtPeriod(period)]);
    }
    if (b.rotation) {
      const days = Math.abs(b.rotation) / 24;
      const val = days < 2 ? t.hours(Math.abs(b.rotation)) : t.days(days);
      const note = b.shape?.tumble ? t.tumbling : b.rotation < 0 ? t.retrograde : '';
      rows.push([t.day, note ? `${val} <small>${note}</small>` : val]);
    }
    if (b.moons) {
      rows.push([t.moons, `${b.moons} <small>${t.moonsNote}</small>`]);
    }
    if (b.launch) {
      rows.push([t.launched, t.date(new Date(`${b.launch}T00:00:00Z`))]);
    }
    const notes: string[] = [];
    if (b.illustrated) {
      notes.push(t.illustrated);
    }
    if (b.shape) {
      notes.push(b.shape.guess ? t.guessShape : t.modelShape);
    }
    if (b.tail) {
      notes.push(t.tailModel);
    }
    if (b.unmapped) {
      notes.push(t.unmapped);
    }
    const sub = b.en !== b.name ? `<p class="sub">${esc(b.en)}</p>` : '<p class="sub"></p>';
    return `
      <p class="eyebrow kind"><i style="background:${b.color}"></i>${esc(kindLine(b))}</p>
      <h2>${esc(b.name)}</h2>${sub}
      <dl data-live></dl>
      <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${notes.map((x) => `<p class="note">${esc(x)}</p>`).join('')}
      ${(b.desc ?? '')
        .split('\n')
        .filter(Boolean)
        .map((x) => `<p>${esc(x)}</p>`)
        .join('')}
      <p class="note" data-note hidden></p>
      <div class="go-row"><button type="button" class="go" data-go>${t.goTo}</button><button type="button" class="go" data-center title="${esc(t.centerTip)}">${t.centerOn}</button></div>`;
  };

  const regionCard = (r: Region) => {
    const at = r.at;
    const rows = at
      ? `<dt>${at.home ? t.distCentre : t.distSun}</dt><dd>${fmtDistance(at.ly * AU_PER_LY)}</dd><dt>${t.size}</dt><dd>${fmtDistance(at.radius * 2 * AU_PER_LY)}</dd>`
      : `<dt>${t.span}</dt><dd>${fmtDistance(r.inner ?? 0)} – ${fmtDistance(r.outer ?? 0)}<small>${esc(t.lightTime(fmtLightTime(r.outer ?? 0)))}</small></dd>`;
    return `
      <p class="eyebrow">${at ? t.dsoKinds[at.type] : t.region}${r.model ? ` · ${t.model}` : ''}</p>
      <h2>${esc(r.name)}</h2><p class="sub"></p>
      <dl>${rows}</dl>
      ${r.stars ? `<p class="note">${esc(t.starField)}</p>` : ''}
      ${r.galaxies ? `<p class="note">${esc(t.galaxyField)}</p>` : ''}
      ${at?.home ? `<p class="note">${esc(t.galaxyModel)}</p>` : ''}
      ${at?.type === 'blackhole' ? `<p class="note">${esc(t.blackholeModel)}</p>` : ''}
      ${at?.type === 'void' ? `<p class="note">${esc(t.voidNote)}</p>` : ''}
      ${M31_SYSTEM.has(r.id) ? `<p class="note">${esc(t.spiralModel)}</p>` : ''}
      ${at?.glow ? `<p class="note">${esc(t.nebulaGlow)}</p>` : ''}
      ${r.catalog ? `<p class="note">${esc(t.catalogDensity)}</p><p class="note">${esc(t.catalogDrift)}</p>` : ''}
      ${r.id === 'oort-cloud' ? `<p class="note">${esc(t.oortDensity)}</p>` : ''}
      <p>${esc(r.desc)}</p>
      <div class="go-row"><button type="button" class="go" data-go>${t.goTo}</button></div>`;
  };

  const eventCard = (e: SpaceEvent) => {
    const target = store.bodyById.get(e.focus);
    return `
      <p class="eyebrow">${t.event} · ${t.date(dateOf(store.eventDay(e)))}</p>
      <h2>${esc(e.title)}</h2>
      <p class="sub">${target ? esc(target.name) : ''}</p>
      ${e.desc ? `<p>${esc(e.desc)}</p>` : ''}
      ${e.uncertain ? `<p class="note">${esc(e.uncertain)}</p>` : ''}
      <div class="go-row"><button type="button" class="go" data-go>${t.eventGo}</button></div>`;
  };

  // distances and speed change every frame; refresh them a few times a second
  const renderLive = () => {
    const s = store.selection;
    if (!live.el || s?.kind !== 'body') {
      return;
    }
    const b = s.body;
    const p = act.positionOf(b.id);
    const note = body.querySelector<HTMLElement>('[data-note]');
    if (!p) {
      live.el.innerHTML = b.launch ? `<dt>${t.launched}</dt><dd>${t.notLaunched}</dd>` : '';
      return;
    }
    const rows: string[] = [];
    if (b.id !== 'sun') {
      const r = hypot(p);
      rows.push(
        `<dt>${t.distSun}</dt><dd>${fmtDistance(r)}<small>${esc(t.lightTime(fmtLightTime(r)))}</small></dd>`,
      );
    }
    const earth = act.positionOf('earth');
    if (earth && b.id !== 'earth') {
      const r = hypot(p, earth);
      rows.push(
        `<dt>${t.distEarth}</dt><dd>${fmtDistance(r)}<small>${esc(t.lightTime(fmtLightTime(r)))}</small></dd>`,
      );
    }
    const v = b.id === 'sun' ? null : act.velocityOf(b.id);
    if (v) {
      rows.push(`<dt>${t.speedSun}</dt><dd>${t.kmps((hypot(v) * KM_PER_AU) / 86400)}</dd>`);
    }
    live.el.innerHTML = rows.join('');
    if (note) {
      const coast = act.craftCoastFrom(b.id);
      const n = act.named(b.id);
      const jd = store.day + 2451545;
      let text = '';
      if (coast !== null && jd > coast) {
        text = t.coasting;
      } else if (n && (jd < n.pathStart || jd > n.pathEnd)) {
        text = t.twoBody;
      }
      note.textContent = text;
      note.hidden = !text;
    }
  };

  store.on('select', renderSelection);
  renderSelection();

  // notices for events crossed during playback
  const toast = $<HTMLButtonElement>('toast');
  let toastEvent: SpaceEvent | null = null;
  let toastTimer = 0;
  toast.addEventListener('click', () => {
    if (toastEvent) {
      act.goToEvent(toastEvent);
    }
    toast.hidden = true;
  });
  const showToast = (e: SpaceEvent) => {
    toastEvent = e;
    toast.innerHTML = `<b>${t.dateShort(dateOf(store.eventDay(e)))}</b>${esc(e.title)}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 4500);
  };

  // panels above the timeline sit on its real height, which changes with wrapping
  const tl = document.querySelector<HTMLElement>('.timeline') as HTMLElement;
  new ResizeObserver(() =>
    document.documentElement.style.setProperty('--tl-h', `${tl.offsetHeight}px`),
  ).observe(tl);

  let acc = 0;
  return {
    showToast,
    toggleChase,
    tick(dt: number) {
      acc += dt;
      if (acc > 0.2) {
        acc = 0;
        renderLive();
        renderCamera();
      }
    },
  };
}
