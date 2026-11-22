import type { Dataset } from './schema';

export type Translations = Record<string, Record<string, Record<string, string>>>;

const FIELDS = {
  bodies: ['desc'],
  regions: ['desc'],
  views: ['name'],
  events: ['title', 'desc', 'uncertain'],
} as const;

/** Swaps the Thai texts for the translated ones, in place. Untranslated texts stay Thai; names come from `en`. */
export function localize(d: Dataset, tr: Translations): Dataset {
  for (const kind of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    for (const item of d[kind] as unknown as Record<string, unknown>[]) {
      const entry = tr[kind]?.[item.id as string];
      for (const f of FIELDS[kind]) {
        if (typeof entry?.[f] === 'string') {
          item[f] = entry[f];
        }
      }
      if (typeof item.en === 'string') {
        item.name = item.en;
      }
    }
  }
  return d;
}
