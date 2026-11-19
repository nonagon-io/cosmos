// Compares the app's positions with JPL Horizons on a few dates. Run with `npm run check-ephemeris`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dayOf, Ephemeris, KM_PER_AU } from '../src/astro/ephemeris.ts';
import type { Body } from '../src/data/schema.ts';

const root = join(import.meta.dirname, '..');
const json = (f: string) => JSON.parse(readFileSync(join(root, 'public', 'data', f), 'utf8'));
const bodies = parse(readFileSync(join(root, 'data', 'bodies.yaml'), 'utf8')) as Body[];
const eph = new Ephemeris(bodies, {
  moons: json('moons.json'),
  named: json('named.json'),
  planets: json('planets.json'),
  craft: json('spacecraft.json'),
});

// Horizons ids; a trailing ; selects a small body
const HORIZONS: Record<string, string> = {
  earth: '399',
  moon: '301',
  mars: '499',
  neptune: '899',
  pluto: '999',
  io: '501',
  titan: '606',
  mimas: '601',
  phobos: '401',
  triton: '801',
  charon: '901',
  ceres: '1;',
  halley: '90000030',
  sedna: '90377;',
  'voyager-1': '-31',
  'voyager-2': '-32',
};

for (const date of ['1955-06-01', '1989-08-25', '2026-11-18', '2085-03-01']) {
  const day = dayOf(new Date(`${date}T00:00:00Z`));
  for (const [id, cmd] of Object.entries(HORIZONS)) {
    const p = eph.position(id, day);
    const q = new URLSearchParams({
      format: 'json',
      COMMAND: `'${cmd}'`,
      EPHEM_TYPE: 'VECTORS',
      CENTER: "'500@10'",
      START_TIME: `'${date}'`,
      STOP_TIME: `'${date} 00:01'`,
      STEP_SIZE: "'1'",
      VEC_TABLE: '1',
      REF_PLANE: 'ECLIPTIC',
      OUT_UNITS: "'KM-D'",
      CSV_FORMAT: 'YES',
      TIME_TYPE: 'UT',
    });
    const res = (await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${q}`)).json()) as {
      result: string;
    };
    const at = res.result.indexOf('$$SOE');
    if (at < 0 || !p) {
      console.log(`${date} ${id.padEnd(10)} -`);
      continue;
    }
    const f = res.result
      .slice(at + 5)
      .trim()
      .split('\n')[0]
      .split(',')
      .map(Number);
    const err = Math.hypot(p[0] * KM_PER_AU - f[2], p[1] * KM_PER_AU - f[3], p[2] * KM_PER_AU - f[4]);
    console.log(`${date} ${id.padEnd(10)} ${Math.round(err).toLocaleString('en-US').padStart(12)} km`);
  }
}
