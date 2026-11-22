import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { buildDataset, DataError } from '../src/data/schema.ts';

const dir = join(import.meta.dirname, '..', 'data');
const raw: Record<string, string> = {};
for (const f of readdirSync(dir)) {
  if (f.endsWith('.yaml')) {
    raw[f] = readFileSync(join(dir, f), 'utf8');
  }
}

// the translations are only read in the browser and by the page build, so a broken one would otherwise get
// through to the deploy
const i18n = join(dir, 'i18n');
for (const locale of readdirSync(i18n)) {
  for (const f of readdirSync(join(i18n, locale))) {
    try {
      parse(readFileSync(join(i18n, locale, f), 'utf8'));
    } catch (e) {
      console.error(`i18n/${locale}/${f}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
}

try {
  const d = buildDataset(raw);
  console.log(
    `ข้อมูลถูกต้อง: ${d.bodies.length} วัตถุ, ${d.regions.length} ภูมิภาค, ${d.views.length} ระยะซูม, ${d.events.length} เหตุการณ์`,
  );
} catch (e) {
  if (!(e instanceof DataError)) {
    throw e;
  }
  console.error(`พบปัญหา ${e.problems.length} จุด:\n${e.problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
