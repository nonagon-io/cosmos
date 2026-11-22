// Pages live at /<id>/ in Thai and /en/<id>/ in English; the build writes one of each for every body, region
// and event so search engines and link previews get its own title and text.
export type Lang = 'th' | 'en';

export function parseRoute(pathname: string): { lang: Lang | null; id: string | null } {
  const parts = pathname.split('/').filter(Boolean);
  const lang = parts[0] === 'en' ? 'en' : parts[0] === 'th' ? 'th' : null;
  if (lang) {
    parts.shift();
  }
  return { lang, id: parts[0] ?? null };
}

export const routeUrl = (lang: Lang, id?: string | null) =>
  `${lang === 'en' ? '/en/' : '/'}${id ? `${id}/` : ''}`;
