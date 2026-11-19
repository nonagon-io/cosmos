import { en } from './en';
import { type Dict, th } from './th';

export const LOCALES = { th: 'ไทย', en: 'EN' } as const;
export type Locale = keyof typeof LOCALES;

const KEY = 'lang';
const valid = (x: string | null): Locale | null => (x && x in LOCALES ? (x as Locale) : null);
const stored = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

export const locale: Locale =
  valid(new URLSearchParams(location.search).get('lang')) ?? valid(stored()) ?? 'th';
export const t: Dict = locale === 'en' ? en : th;

/** Switching reloads the page, since the data is localized once at load. `resume` is saved for the next load. */
export function switchLocale(l: Locale, resume: unknown) {
  try {
    localStorage.setItem(KEY, l);
    sessionStorage.setItem('resume', JSON.stringify(resume));
  } catch {
    // private mode: the language still switches through the URL
  }
  const url = new URL(location.href);
  url.searchParams.set('lang', l);
  location.replace(url);
}

export function takeResume<T>(): T | null {
  try {
    const s = sessionStorage.getItem('resume');
    sessionStorage.removeItem('resume');
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

type TextKey = { [K in keyof Dict]: Dict[K] extends string ? K : never }[keyof Dict];

/** Fills the static page: data-t sets the text, data-t-label the aria-label, data-t-tip the title. */
export function applyStatic() {
  document.documentElement.lang = locale;
  document.title = t.title;
  const get = (k: string | undefined) => (k && typeof t[k as TextKey] === 'string' ? t[k as TextKey] : null);
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
    el.textContent = get(el.dataset.t) ?? el.textContent;
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-label]')) {
    el.setAttribute('aria-label', get(el.dataset.tLabel) ?? '');
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-tip]')) {
    el.title = get(el.dataset.tTip) ?? '';
  }
}
