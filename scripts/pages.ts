// Writes a copy of the built index.html for every body, region and event, in Thai at /<id>/ and English at
// /en/<id>/, each with its own title, description, link preview and card text, plus the sitemap and a 404 page.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { localize, type Translations } from '../src/data/localize.ts';
import { buildDataset, type Dataset } from '../src/data/schema.ts';
import { en } from '../src/i18n/en.ts';
import { th } from '../src/i18n/th.ts';
import { type Lang, routeUrl } from '../src/route.ts';

const SITE = 'https://cosmos.nonagon.info';
const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const dataDir = join(root, 'data');

const yamlIn = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );
const raw = yamlIn(dataDir);
const tr: Translations = Object.fromEntries(
  Object.entries(yamlIn(join(dataDir, 'i18n', 'en'))).map(([f, text]) => [
    f.replace('.yaml', ''),
    parse(text) ?? {},
  ]),
);
const data: Record<Lang, Dataset> = { th: buildDataset(raw), en: localize(buildDataset(raw), tr) };
const dict = { th, en };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// cut at a space so a Thai phrase or an English word isn't split
const clip = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  const cut = flat.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:·]+$/, '')}…`;
};

interface Page {
  id: string | null;
  name?: string;
  desc: string;
  image?: string;
}

function pages(lang: Lang): Page[] {
  const d = data[lang];
  const photo = (r: Dataset['regions'][number]) =>
    (r.photos?.find((p) => p.kind === 'visible') ?? r.photos?.[0])?.file;
  return [
    { id: null, desc: dict[lang].metaDesc },
    ...d.bodies.map((b) => ({ id: b.id, name: b.name, desc: b.desc ?? '' })),
    ...d.regions.map((r) => ({ id: r.id, name: r.name, desc: r.desc ?? '', image: photo(r) })),
    ...d.events.map((e) => ({ id: e.id, name: e.title, desc: e.desc ?? '' })),
  ];
}

// an id named like one of the site's own folders would overwrite or shadow it
const taken = new Set(readdirSync(dist).concat('en'));
for (const p of pages('th')) {
  if (p.id && taken.has(p.id)) {
    throw new Error(`id "${p.id}" clashes with dist/${p.id}`);
  }
}

const template = readFileSync(join(dist, 'index.html'), 'utf8');

function render(lang: Lang, p: Page, all: Page[], extraHead = '') {
  const t = dict[lang];
  const title = p.name ? `${p.name} · ${t.title}` : t.metaTitle;
  const desc = clip(p.desc || t.metaDesc);
  const url = SITE + routeUrl(lang, p.id);
  const image = p.image ? `${SITE}/photos/${p.image}` : `${SITE}/og.png`;
  const head = [
    `<meta name="description" content="${esc(desc)}">`,
    `<link rel="canonical" href="${url}">`,
    `<link rel="alternate" hreflang="th" href="${SITE}${routeUrl('th', p.id)}">`,
    `<link rel="alternate" hreflang="en" href="${SITE}${routeUrl('en', p.id)}">`,
    `<link rel="alternate" hreflang="x-default" href="${SITE}${routeUrl('th', p.id)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(t.title)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'th_TH'}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    p.id
      ? ''
      : `<script type="application/ld+json">${JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebApplication',
          name: t.title,
          url,
          description: t.metaDesc,
          applicationCategory: 'EducationalApplication',
          inLanguage: ['th', 'en'],
          isAccessibleForFree: true,
          creator: { '@type': 'Organization', name: 'Nonagon Co., Ltd.', url: 'https://nonagon.info' },
        })}</script>`,
    extraHead,
  ]
    .filter(Boolean)
    .join('\n  ');
  // the home page links every object so crawlers find them without running the app
  const links = p.id
    ? ''
    : `<ul>${all
        .filter((x) => x.id)
        .map((x) => `<li><a href="${routeUrl(lang, x.id)}">${esc(x.name ?? '')}</a></li>`)
        .join('')}</ul>`;
  const about = `<div id="about" class="sr-only"><h2>${esc(p.name ?? t.metaTitle)}</h2><p>${esc(p.desc || t.metaDesc)}</p>${links}</div>`;
  return template
    .replace('<html lang="th"', `<html lang="${lang}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace('</head>', `  ${head}\n</head>`)
    .replace(/<body>/, `<body>\n  ${about}`);
}

const write = (path: string, html: string) => {
  const dir = join(dist, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
};

const urls: string[] = [];
for (const lang of ['th', 'en'] as const) {
  const all = pages(lang);
  for (const p of all) {
    write(routeUrl(lang, p.id), render(lang, p, all));
    if (lang === 'th') {
      urls.push(
        ['th', 'en']
          .map(
            (l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${SITE}${routeUrl(l as Lang, p.id)}"/>`,
          )
          .join(''),
      );
    }
  }
}
// GitHub Pages serves this for any path it has no file for; the app then falls back to the home page
writeFileSync(
  join(dist, '404.html'),
  render('th', pages('th')[0], [], '<meta name="robots" content="noindex">').replace(
    /<link rel="canonical"[^>]*>\n\s*/,
    '',
  ),
);

const ids = pages('th').map((p) => p.id);
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${ids
  .flatMap((id, i) =>
    (['th', 'en'] as const).map((l) => `  <url><loc>${SITE}${routeUrl(l, id)}</loc>${urls[i]}</url>`),
  )
  .join('\n')}
</urlset>
`;
writeFileSync(join(dist, 'sitemap.xml'), sitemap);
console.log(`pages: ${ids.length * 2}, sitemap and 404 written`);
