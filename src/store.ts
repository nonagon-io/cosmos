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
  quaia: boolean;
}

interface Events {
  day: number;
  speed: number;
  play: boolean;
  select: Selection;
  layers: Layers;
  deep: boolean;
  myr: number;
  cosmic: boolean;
  gyr: number;
}

type Handler<T> = (v: T) => void;

/** Days per second of playback. */
export const SPEEDS = [1 / 86400, 15 / 1440, 30 / 1440, 1 / 24, 1, 7, 30.44, 365.25, 3652.5] as const;
/** Millions of years per second, on the Galaxy's own timeline. */
export const DEEP_SPEEDS = [0.1, 1, 10] as const;
/** That timeline runs this many million years either side of now, about one turn of the Sun round the Galaxy. */
export const DEEP_RANGE = 250;
/** Billions of years per second, on the universe's own timeline. */
export const COSMIC_SPEEDS = [0.1, 0.5, 2] as const;
/** That timeline goes back this many billion years, to when the universe was about 400 million years old. */
export const COSMIC_RANGE = 13.4;

// flat ΛCDM with Planck's numbers, for the age of the universe and its size through time
const H0 = 67.7;
const OMEGA_M = 0.31;
const GYR_PER_HUBBLE = 977.8 / H0;
// lookback time in Gyr against scale factor, from a = 0.005 to 1
const EXPANSION = (() => {
  const n = 2000;
  const as: number[] = [];
  const ts: number[] = [];
  let t = 0;
  let prev = 0;
  for (let i = 0; i <= n; i++) {
    const a = 0.005 + (i / n) * 0.995;
    // dt = da / (a H), with H = H0 sqrt(Ωm / a³ + ΩΛ)
    const f = (x: number) => 1 / (x * Math.sqrt(OMEGA_M / x ** 3 + (1 - OMEGA_M)));
    if (i > 0) {
      t += ((f(prev) + f(a)) / 2) * (a - prev);
    }
    as.push(a);
    ts.push(t * GYR_PER_HUBBLE);
    prev = a;
  }
  // the few million years before a = 0.005 are near enough nothing here
  const t0 = ts[n];
  return { as, back: ts.map((x) => t0 - x), age: t0 };
})();

/** The universe's age now, in billions of years. */
export const COSMIC_AGE = EXPANSION.age;

/** How big the universe was `gyr` billion years from now (negative, in the past) against today. */
export function scaleFactor(gyr: number) {
  const back = -gyr;
  if (back <= 0) {
    return 1;
  }
  const { as, back: bs } = EXPANSION;
  for (let i = bs.length - 1; i > 0; i--) {
    if (bs[i - 1] >= back) {
      const f = (back - bs[i]) / (bs[i - 1] - bs[i]);
      return as[i] + f * (as[i - 1] - as[i]);
    }
  }
  return as[0];
}

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
  /** Zoomed out further, to billions of light years: the timeline counts billions of years of expansion. */
  cosmic = false;
  /** Billions of years from now on that timeline, never ahead of now. */
  gyr = 0;
  cosmicSpeedIndex = 1;
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
    quaia: true,
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

  get cosmicSpeed() {
    return COSMIC_SPEEDS[this.cosmicSpeedIndex] * (this.reverse ? -1 : 1);
  }

  /** The speed of whichever timeline shows, in its own units per second. */
  get modeSpeed() {
    return this.cosmic ? this.cosmicSpeed : this.deep ? this.deepSpeed : this.speed;
  }

  /** The chosen speed's index in whichever list the timeline shows. */
  get modeSpeedIndex() {
    return this.cosmic ? this.cosmicSpeedIndex : this.deep ? this.deepSpeedIndex : this.speedIndex;
  }

  setDeep(on: boolean) {
    this.deep = on;
    this.emit('deep', on);
    this.emit('speed', this.modeSpeed);
  }

  setCosmic(on: boolean) {
    this.cosmic = on;
    this.emit('cosmic', on);
    this.emit('speed', this.modeSpeed);
  }

  setGyr(v: number) {
    const g = Math.min(0, Math.max(-COSMIC_RANGE, v));
    if (g === this.gyr) {
      return;
    }
    this.gyr = g;
    this.emit('gyr', g);
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
    if (this.cosmic) {
      this.cosmicSpeedIndex = Math.max(0, Math.min(COSMIC_SPEEDS.length - 1, index));
    } else if (this.deep) {
      this.deepSpeedIndex = Math.max(0, Math.min(DEEP_SPEEDS.length - 1, index));
    } else {
      this.speedIndex = Math.max(0, Math.min(SPEEDS.length - 1, index));
    }
    this.reverse = reverse;
    this.emit('speed', this.modeSpeed);
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
