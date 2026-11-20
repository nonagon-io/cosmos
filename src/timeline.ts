import { dateOf, dayOf } from './astro/ephemeris';
import type { SpaceEvent } from './data/schema';
import { esc } from './format';
import { t } from './i18n';
import { SPEEDS, type Store } from './store';

const SLIDER_MAX = 10000;
const IMPORTANCE_COLOR = { 1: 'var(--event-1)', 2: 'var(--nebula)', 3: 'var(--accent)' } as const;
const IMPORTANCE_HEIGHT = { 1: 7, 2: 10, 3: 13 } as const;
const MARK_GAP = 12;
const LANE_STEP = 9;

/** Piecewise-linear mapping between days and slider position (0..1), stretched where the events are. */
export class DayScale {
  private readonly pts: [number, number][];

  constructor(points: [string, number][]) {
    this.pts = points.map(([d, v]) => [dayOf(new Date(`${d}T00:00:00Z`)), v]);
  }

  toPos(day: number) {
    const p = this.pts;
    if (day <= p[0][0]) {
      return p[0][1];
    }
    for (let i = 1; i < p.length; i++) {
      const [da, a] = p[i - 1];
      const [db, b] = p[i];
      if (day <= db) {
        return a + ((day - da) / (db - da)) * (b - a);
      }
    }
    return p[p.length - 1][1];
  }

  toDay(v: number) {
    const p = this.pts;
    if (v <= p[0][1]) {
      return p[0][0];
    }
    for (let i = 1; i < p.length; i++) {
      const [da, a] = p[i - 1];
      const [db, b] = p[i];
      if (v <= b) {
        return da + ((v - a) / (b - a)) * (db - da);
      }
    }
    return p[p.length - 1][0];
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupTimeline(store: Store, goToEvent: (e: SpaceEvent) => void) {
  const scale = new DayScale(store.data.timeline.scale);
  const slider = $<HTMLInputElement>('slider');
  const marks = $('ev-marks');
  const ticks = $('ticks');
  const tip = $('ev-tip');
  const dMain = $('d-main');
  const dAlt = $('d-alt');
  const playBtn = $<HTMLButtonElement>('play');
  const speeds = $('speeds');
  const reverse = $<HTMLButtonElement>('reverse');

  const pct = (day: number) => `${(scale.toPos(day) * 100).toFixed(3)}%`;

  // ticks, with the current year highlighted
  const nowYear = new Date().getUTCFullYear();
  ticks.innerHTML = store.data.timeline.ticks
    .map((y) => {
      const day = dayOf(new Date(Date.UTC(y, 0, 1)));
      return `<span style="left:${pct(day)}"${y === nowYear ? ' class="now"' : ''}>${t.year(y)}</span>`;
    })
    .join('');

  // events: the more important, the taller. Marks closer than MARK_GAP px step up into another lane, the more
  // important ones keeping the lowest lanes.
  marks.innerHTML = store.data.events
    .map((e, i) => {
      const cls = e.uncertain ? ' class="unc"' : '';
      const style = `left:${pct(store.eventDay(e))};--c:${IMPORTANCE_COLOR[e.importance]}`;
      return `<button type="button" data-i="${i}"${cls} style="${style}" aria-label="${esc(e.title)}"></button>`;
    })
    .join('');
  const layoutMarks = () => {
    const width = marks.clientWidth;
    const lanes: number[][] = [];
    const order = store.data.events.map((e, i) => ({ e, i })).sort((a, b) => b.e.importance - a.e.importance);
    const buttons = marks.querySelectorAll<HTMLElement>('[data-i]');
    for (const { e, i } of order) {
      const x = scale.toPos(store.eventDay(e)) * width;
      let lane = lanes.findIndex((xs) => xs.every((o) => Math.abs(o - x) >= MARK_GAP));
      if (lane < 0) {
        lane = lanes.push([]) - 1;
      }
      lanes[lane].push(x);
      buttons[i].style.setProperty('--h', `${IMPORTANCE_HEIGHT[e.importance] + lane * LANE_STEP}px`);
    }
  };
  // on a narrow track, drop year labels that would run into the one before
  const layoutTicks = () => {
    let right = -Infinity;
    for (const el of ticks.querySelectorAll<HTMLElement>('span')) {
      el.hidden = false;
      const r = el.getBoundingClientRect();
      el.hidden = r.left < right + 6;
      if (!el.hidden) {
        right = r.right;
      }
    }
  };
  new ResizeObserver(() => {
    layoutMarks();
    layoutTicks();
  }).observe(marks);
  const eventAt = (el: EventTarget | null) => {
    const b = (el as HTMLElement | null)?.closest<HTMLElement>('[data-i]');
    return b ? store.data.events[Number(b.dataset.i)] : null;
  };
  marks.addEventListener('click', (e) => {
    const ev = eventAt(e.target);
    if (ev) {
      goToEvent(ev);
    }
  });
  marks.addEventListener('pointerover', (e) => {
    const ev = eventAt(e.target);
    if (!ev) {
      return;
    }
    const r = (e.target as HTMLElement).getBoundingClientRect();
    tip.innerHTML = `<b>${t.dateShort(dateOf(store.eventDay(ev)))}</b>${esc(ev.title)}`;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
  });
  marks.addEventListener('pointerout', () => {
    tip.hidden = true;
  });

  slider.addEventListener('input', () => {
    store.setDay(scale.toDay(Number(slider.value) / SLIDER_MAX));
  });

  speeds.innerHTML = SPEEDS.map((_, i) => `<button type="button" data-s="${i}">${t.speeds[i]}</button>`).join(
    '',
  );
  speeds.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-s]');
    if (b) {
      store.setSpeed(Number(b.dataset.s));
      if (!store.playing) {
        store.setPlaying(true);
      }
    }
  });
  reverse.addEventListener('click', () => store.setSpeed(store.speedIndex, !store.reverse));
  const syncSpeed = () => {
    for (const b of speeds.querySelectorAll<HTMLElement>('[data-s]')) {
      const on = Number(b.dataset.s) === store.speedIndex;
      b.setAttribute('aria-pressed', String(on));
      // on phones the row scrolls; keep the chosen speed in sight
      if (on && speeds.scrollWidth > speeds.clientWidth) {
        speeds.scrollLeft = Math.max(0, b.offsetLeft - (speeds.clientWidth - b.offsetWidth) / 2);
      }
    }
    reverse.setAttribute('aria-pressed', String(store.reverse));
  };
  store.on('speed', syncSpeed);
  new ResizeObserver(syncSpeed).observe(speeds);

  playBtn.addEventListener('click', () => store.setPlaying(!store.playing));
  const syncPlay = () => {
    const icon = store.playing
      ? '<path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor"/>'
      : '<path d="M2 1l9 5-9 5z" fill="currentColor"/>';
    playBtn.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${icon}</svg><span>${store.playing ? t.pause : t.play}</span>`;
  };
  store.on('play', syncPlay);
  syncPlay();

  $('now').addEventListener('click', () => store.setDay(dayOf(new Date())));
  $<HTMLInputElement>('opt-stop').addEventListener('change', (e) => {
    store.stopAtEvents = (e.target as HTMLInputElement).checked;
  });

  const step = (dir: 1 | -1) => {
    const now = store.day;
    const list = store.data.events;
    const ev =
      dir > 0
        ? list.find((e) => store.eventDay(e) > now + 0.5)
        : list.findLast((e) => store.eventDay(e) < now - 0.5);
    if (ev) {
      goToEvent(ev);
    }
  };
  $('prev-ev').addEventListener('click', () => step(-1));
  $('next-ev').addEventListener('click', () => step(1));

  let shownMinute = -1;
  const render = () => {
    const day = store.day;
    const d = dateOf(day);
    const minute = Math.floor(day * 1440);
    if (minute === shownMinute) {
      return;
    }
    shownMinute = minute;
    dMain.textContent = t.date(d);
    // the clock only means something when time moves slowly enough to read it
    const slow = !store.playing || store.speedIndex <= 2;
    dAlt.textContent = [t.dateAlt(d), slow ? t.clock(d) : ''].filter(Boolean).join(' · ');
    if (document.activeElement !== slider) {
      slider.value = String(Math.round(scale.toPos(day) * SLIDER_MAX));
    }
    for (const b of marks.querySelectorAll<HTMLElement>('button')) {
      const e = store.data.events[Number(b.dataset.i)];
      b.classList.toggle('on', store.selection?.kind === 'event' && store.selection.event === e);
    }
  };
  store.on('day', render);
  store.on('select', () => {
    shownMinute = -1;
    render();
  });
  render();

  return { step };
}
