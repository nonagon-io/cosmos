import { parse } from 'yaml';
import { z } from 'zod';

export const KINDS = [
  'star',
  'planet',
  'dwarf',
  'moon',
  'asteroid',
  'comet',
  'interstellar',
  'spacecraft',
] as const;
export const ORBITS = ['engine', 'jupiter', 'moon', 'named', 'craft', 'leo'] as const;

const id = z.string().regex(/^[a-z0-9-]+$/, 'id ใช้ได้เฉพาะ a-z, 0-9 และ -');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'สีต้องเป็นรูปแบบ "#rrggbb"');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'วันที่ต้องเป็นรูปแบบ "YYYY-MM-DD"');

const Body = z.object({
  id,
  name: z.string(),
  en: z.string(),
  kind: z.enum(KINDS),
  parent: id.optional(),
  orbit: z.enum(ORBITS),
  // for a spacecraft with a model, about how far it reaches from its middle, booms and all
  radius: z.number().positive().optional(),
  // a 3D model in public/models, dish along +z, in metres
  model: z.string().optional(),
  flattening: z.number().min(0).max(0.5).optional(),
  mass: z.number().positive().optional(),
  rotation: z.number().optional(),
  period: z.number().positive().optional(),
  texture: z.string().optional(),
  illustrated: z.boolean().optional(),
  // tail lengths in AU and coma radius in km near perihelion, roughly as observed; they shrink with distance from
  // the Sun and fade out beyond `onset` AU (default 4)
  tail: z
    .object({
      ion: z.number().min(0),
      dust: z.number().min(0),
      coma: z.number().positive().optional(),
      onset: z.number().positive().optional(),
    })
    .optional(),
  // longitude at the middle of the texture, when it is not 0
  textureCenter: z.number().optional(),
  // a map with areas never photographed (black in the file): painted this color, and the card says so
  unmapped: color.optional(),
  // a modelled shape for a body never resolved by a telescope: semi-axes in km (long, middle, short) and, if it
  // tumbles, the period in hours of its spin axis swinging around; the card marks it as a model
  shape: z
    .object({
      axes: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
      tumble: z.number().positive().optional(),
      // no light curve to model it from either: a generic comet nucleus at the middle of the size estimates
      guess: z.boolean().optional(),
    })
    .optional(),
  color,
  moons: z.number().int().optional(),
  rings: z
    .object({ inner: z.number().positive(), outer: z.number().positive(), texture: z.string() })
    .optional(),
  launch: date.optional(),
  // the last day it is shown: deorbited, or where the trajectory data runs out
  end: date.optional(),
  // a near-circular orbit round its parent (Earth) from one set of elements: mean altitude in km, inclination,
  // node and argument of latitude in degrees (equator of date) at `epoch`; drifted on by Earth's oblateness
  leo: z
    .object({
      alt: z.number().positive(),
      inc: z.number(),
      node: z.number(),
      u: z.number(),
      epoch: z.string(),
    })
    .optional(),
  desc: z.string().optional(),
});

const Region = z.object({
  id,
  name: z.string(),
  en: z.string(),
  // a shell around the Sun, `inner` to `outer` AU...
  inner: z.number().positive().optional(),
  outer: z.number().positive().optional(),
  // ...or a cluster or nebula out among the stars: RA/Dec in degrees, distance and radius in light years, and
  // for a nebula the color of the glow drawn for it
  at: z
    .object({
      type: z.enum(['cluster', 'nebula', 'galaxy', 'blackhole', 'void']),
      ra: z.number(),
      dec: z.number(),
      ly: z.number().positive(),
      radius: z.number().positive(),
      glow: color.optional(),
      // the Galaxy we are in: its RA/Dec and distance are those of its centre, and its shape is a model
      home: z.boolean().optional(),
    })
    .optional(),
  view: z.number().positive(),
  model: z.boolean().optional(),
  // the 3D star field: its card explains why it thins out with distance
  stars: z.boolean().optional(),
  // the Cosmicflows-4 galaxies: likewise
  galaxies: z.boolean().optional(),
  // drawn from the small-body catalogue, whose dots drift from their true places away from the present
  catalog: z.boolean().optional(),
  // real pictures of it, kept in public/photos, with the credit their licence asks for
  photos: z
    .array(
      z.object({
        file: z.string(),
        kind: z.enum(['visible', 'infrared']),
        by: z.string(),
        year: z.number().int(),
        credit: z.string(),
        url: z.string().url(),
        // when it shows only part of the nebula, or adds other light
        part: z.enum(['part', 'centre', 'core', 'ring', 'bar', 'cliffs', 'mexico', 'xray']).optional(),
      }),
    )
    .optional(),
  desc: z.string(),
});

const View = z.object({
  id,
  name: z.string(),
  focus: id,
  distance: z.number().positive(),
  // degrees above the galactic plane to look from, for views of the whole Galaxy
  tilt: z.number().optional(),
  // a second thing to frame along with focus; the camera centres halfway between them
  also: id.optional(),
  // a stop for whatever body the camera is on (focus is the fallback): filling the view, or with its moons
  // or framing whatever region the camera is on, under that region's own name
  relative: z.enum(['body', 'system', 'region']).optional(),
  ladder: z.string().optional(),
});

const Event = z.object({
  id,
  date,
  title: z.string(),
  desc: z.string().optional(),
  focus: id,
  distance: z.number().positive(),
  importance: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  uncertain: z.string().optional(),
});

const Timeline = z.object({
  start: date,
  end: date,
  scale: z.array(z.tuple([date, z.number().min(0).max(1)])).min(2),
  ticks: z.array(z.number().int()),
  initialView: z.object({ focus: id, distance: z.number().positive() }),
});

export type Body = z.infer<typeof Body>;
export type Kind = Body['kind'];
export type Region = z.infer<typeof Region>;
export type View = z.infer<typeof View>;
export type SpaceEvent = z.infer<typeof Event>;
export type Timeline = z.infer<typeof Timeline>;

export interface Dataset {
  bodies: Body[];
  regions: Region[];
  views: View[];
  events: SpaceEvent[];
  timeline: Timeline;
}

export class DataError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

const FILES = {
  bodies: z.array(Body),
  regions: z.array(Region),
  views: z.array(View),
  events: z.array(Event),
  timeline: Timeline,
} as const;

/** Parses and checks the YAML files, keyed by path relative to data/. Throws a DataError listing every problem. */
export function buildDataset(raw: Record<string, string>): Dataset {
  const problems: string[] = [];
  const out: Partial<Record<keyof typeof FILES, unknown>> = {};

  for (const [key, schema] of Object.entries(FILES) as [keyof typeof FILES, z.ZodType][]) {
    const file = `${key}.yaml`;
    const text = raw[file];
    if (text === undefined) {
      problems.push(`${file}: ไม่พบไฟล์`);
      continue;
    }
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (e) {
      problems.push(`${file}: YAML ผิดรูปแบบ: ${(e as Error).message}`);
      continue;
    }
    const res = schema.safeParse(doc);
    if (!res.success) {
      for (const issue of res.error.issues) {
        const at = describePath(doc, issue.path);
        problems.push(`${file}: ${at}: ${issue.message}`);
      }
      continue;
    }
    out[key] = res.data;
  }
  if (problems.length) {
    throw new DataError(problems);
  }

  const d = out as Dataset;
  const ids = new Set<string>();
  for (const b of d.bodies) {
    if (ids.has(b.id)) {
      problems.push(`bodies.yaml: id "${b.id}" ซ้ำ`);
    }
    ids.add(b.id);
  }
  for (const r of d.regions) {
    ids.add(r.id);
    if (!r.at && !(r.inner && r.outer)) {
      problems.push(`regions.yaml: ${r.id}: ต้องมี inner กับ outer หรือ at`);
    }
  }
  for (const b of d.bodies) {
    if (b.parent && !ids.has(b.parent)) {
      problems.push(`bodies.yaml: ${b.id}: ไม่มี parent "${b.parent}"`);
    }
    if (b.kind === 'moon' && !b.parent) {
      problems.push(`bodies.yaml: ${b.id}: ดวงจันทร์ต้องมี parent`);
    }
    if (b.orbit === 'leo' && (!b.leo || !b.launch || !b.parent)) {
      problems.push(`bodies.yaml: ${b.id}: วงโคจร leo ต้องมี leo, launch และ parent`);
    }
    if (b.orbit === 'craft' && !b.launch) {
      problems.push(`bodies.yaml: ${b.id}: ยานอวกาศต้องมี launch`);
    }
    if (
      (b.orbit === 'engine' || b.orbit === 'jupiter' || b.orbit === 'moon') &&
      b.id !== 'sun' &&
      !b.period
    ) {
      problems.push(`bodies.yaml: ${b.id}: ต้องมี period`);
    }
    if (b.kind !== 'spacecraft' && b.radius === undefined && !b.shape) {
      problems.push(`bodies.yaml: ${b.id}: ต้องมี radius หรือ shape`);
    }
  }
  for (const v of d.views) {
    if (!ids.has(v.focus)) {
      problems.push(`views.yaml: ${v.id}: ไม่มี focus "${v.focus}"`);
    }
    if (
      v.ladder &&
      v.ladder !== 'solar' &&
      v.ladder !== 'region' &&
      !d.regions.some((r) => r.id === v.ladder)
    ) {
      problems.push(`views.yaml: ${v.id}: ไม่มี ladder "${v.ladder}"`);
    }
  }
  const evIds = new Set<string>();
  for (const e of d.events) {
    if (evIds.has(e.id)) {
      problems.push(`events.yaml: id "${e.id}" ซ้ำ`);
    }
    evIds.add(e.id);
    if (!ids.has(e.focus)) {
      problems.push(`events.yaml: ${e.id}: ไม่มี focus "${e.focus}"`);
    }
  }
  if (problems.length) {
    throw new DataError(problems);
  }
  d.events.sort((a, b) => a.date.localeCompare(b.date));
  return d;
}

// "events.yaml: apollo-11 › date" reads better than a bare index path
function describePath(doc: unknown, path: PropertyKey[]) {
  const parts: string[] = [];
  let node = doc;
  for (const p of path) {
    const next = (node as Record<PropertyKey, unknown> | undefined)?.[p];
    if (typeof p === 'number' && next && typeof next === 'object' && 'id' in next) {
      parts.push(String((next as { id: unknown }).id));
    } else {
      parts.push(String(p));
    }
    node = next;
  }
  return parts.join(' › ') || '(ทั้งไฟล์)';
}
