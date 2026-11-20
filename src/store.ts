import { dayOf } from './astro/ephemeris';
import type { Body, Dataset, Region, SpaceEvent } from './data/schema';

export type Selection =
  | { kind: 'body'; body: Body }
  | { kind: 'region'; region: Region }
  | { kind: 'event'; event: SpaceEvent }
  | null;

export interface Layers {
  orbits: boolean;
  labels: boolean;
  smallBodies: boolean;
  oort: boolean;
  spacecraft: boolean;
  trueSize: boolean;
  sdss: boolean;
  desi: boolean;
}

interface Events {
  day: number;
  speed: number;
  play: boolean;
  select: Selection;
  layers: Layers;
  deep: boolean;
  myr: number;
}

type Handler<T> = (v: T) => void;

/** Days per second of playback. */
export const SPEEDS = [1 / 86400, 15 / 1440, 30 / 1440, 1 / 24, 1, 7, 30.44, 365.25, 3652.5] as const;
/** Millions of years per second, on the Galaxy's own timeline. */
export const DEEP_SPEEDS = [0.1, 1, 10] as const;
/** That timeline runs this many million years either side of now, about one turn of the Sun round the Galaxy. */
export const DEEP_RANGE = 250;

export class Store {
  readonly bodyById = new Map<string, Body>();
  readonly regionById = new Map<string, Region>();
  readonly start: number;
  readonly end: number;
  day: number;
  speedIndex = SPEEDS.indexOf(7);
  reverse = false;
  playing = false;
  /** Zoomed out to the Galaxy, where the timeline counts millions of years instead of days. */
  deep = false;
  /** Millions of years from now on that timeline. The Solar System keeps its own date meanwhile. */
  myr = 0;
  deepSpeedIndex = 1;
  stopAtEvents = false;
  selection: Selection = null;
  layers: Layers = {
    orbits: true,
    labels: true,
    smallBodies: true,
    oort: true,
    spacecraft: true,
    trueSize: false,
    sdss: true,
    desi: true,
  };
  private readonly handlers: { [K in keyof Events]?: Handler<Events[K]>[] } = {};

  constructor(readonly data: Dataset) {
    for (const b of data.bodies) {
      this.bodyById.set(b.id, b);
    }
    for (const r of data.regions) {
      this.regionById.set(r.id, r);
    }
    this.start = dayOf(new Date(`${data.timeline.start}T00:00:00Z`));
    this.end = dayOf(new Date(`${data.timeline.end}T23:59:59Z`));
    this.day = Math.min(this.end, Math.max(this.start, dayOf(new Date())));
  }

  on<K extends keyof Events>(k: K, fn: Handler<Events[K]>) {
    const list = (this.handlers[k] ?? []) as Handler<Events[K]>[];
    list.push(fn);
    this.handlers[k] = list as (typeof this.handlers)[K];
  }

  private emit<K extends keyof Events>(k: K, v: Events[K]) {
    for (const fn of (this.handlers[k] ?? []) as Handler<Events[K]>[]) {
      fn(v);
    }
  }

  get speed() {
    return SPEEDS[this.speedIndex] * (this.reverse ? -1 : 1);
  }

  get deepSpeed() {
    return DEEP_SPEEDS[this.deepSpeedIndex] * (this.reverse ? -1 : 1);
  }

  /** The chosen speed's index in whichever list the timeline shows. */
  get modeSpeedIndex() {
    return this.deep ? this.deepSpeedIndex : this.speedIndex;
  }

  setDeep(on: boolean) {
    this.deep = on;
    this.emit('deep', on);
    this.emit('speed', on ? this.deepSpeed : this.speed);
  }

  setMyr(v: number) {
    const m = Math.min(DEEP_RANGE, Math.max(-DEEP_RANGE, v));
    if (m === this.myr) {
      return;
    }
    this.myr = m;
    this.emit('myr', m);
  }

  setDay(d: number) {
    const v = Math.min(this.end, Math.max(this.start, d));
    if (v === this.day) {
      return;
    }
    this.day = v;
    this.emit('day', v);
  }

  /** `index` is into the list the timeline shows now: SPEEDS, or DEEP_SPEEDS while zoomed out to the Galaxy. */
  setSpeed(index: number, reverse = this.reverse) {
    if (this.deep) {
      this.deepSpeedIndex = Math.max(0, Math.min(DEEP_SPEEDS.length - 1, index));
    } else {
      this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
    }
    this.reverse = reverse;
    this.emit('speed', this.deep ? this.deepSpeed : this.speed);
  }

  setPlaying(p: boolean) {
    this.playing = p;
    this.emit('play', p);
  }

  select(s: Selection) {
    this.selection = s;
    this.emit('select', s);
  }

  setLayer(k: keyof Layers, on: boolean) {
    this.layers = { ...this.layers, [k]: on };
    this.emit('layers', this.layers);
  }

  eventDay(e: SpaceEvent) {
    return dayOf(new Date(`${e.date}T12:00:00Z`));
  }
}
