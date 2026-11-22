import { parse } from 'yaml';
import type { Locale } from '../i18n';
import { localize, type Translations } from './localize';
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

export function loadDataset(): Dataset {
  const raw: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    raw[path.replace('../../data/', '')] = text;
  }
  return buildDataset(raw);
}

async function loadTranslations(locale: Locale) {
  const prefix = `../../data/i18n/${locale}/`;
  const out: Translations = {};
  const jobs = Object.entries(i18n)
    .filter(([p]) => p.startsWith(prefix))
    .map(async ([p, load]) => {
      out[p.slice(prefix.length).replace('.yaml', '')] = (parse(await load()) ?? {}) as Translations[string];
    });
  await Promise.all(jobs);
  return out;
}

/** The dataset with its Thai texts swapped for `locale`. Untranslated texts stay Thai; names come from `en`. */
export async function loadLocalized(locale: Locale): Promise<Dataset> {
  const d = loadDataset();
  return locale === 'th' ? d : localize(d, await loadTranslations(locale));
}
