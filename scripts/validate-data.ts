import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDataset, DataError } from '../src/data/schema.ts';

const dir = join(import.meta.dirname, '..', 'data');
const raw: Record<string, string> = {};
for (const f of readdirSync(dir)) {
  if (f.endsWith('.yaml')) {
    raw[f] = readFileSync(join(dir, f), 'utf8');
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
