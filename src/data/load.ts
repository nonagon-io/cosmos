import { parse } from 'yaml';
import type { Locale } from '../i18n';
import { buildDataset, type Dataset } from './schema';

const files = import.meta.glob(['../../data/*.yaml'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
// only the chosen language is fetched
const i18n = import.meta.glob('../../data/i18n/**/*.yaml', { query: '?raw', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

type Entries = Record<string, Record<string, string>>;

export function loadDataset(): Dataset {
  const raw: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    raw[path.replace('../../data/', '')] = text;
  }
  return buildDataset(raw);
}

async function loadTranslations(locale: Locale) {
  const prefix = `../../data/i18n/${locale}/`;
  const out: Record<string, Entries> = {};
  const jobs = Object.entries(i18n)
    .filter(([p]) => p.startsWith(prefix))
    .map(async ([p, load]) => {
      out[p.slice(prefix.length).replace('.yaml', '')] = (parse(await load()) ?? {}) as Entries;
    });
  await Promise.all(jobs);
  return out;
}

const FIELDS = {
  bodies: ['desc'],
  regions: ['desc'],
  views: ['name'],
  events: ['title', 'desc', 'uncertain'],
} as const;

/** The dataset with its Thai texts swapped for `locale`. Untranslated texts stay Thai; names come from `en`. */
export async function loadLocalized(locale: Locale): Promise<Dataset> {
  const d = loadDataset();
  if (locale === 'th') {
    return d;
  }
  const tr = await loadTranslations(locale);
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
