import { KM_PER_AU, LIGHT_MIN_PER_AU } from './astro/ephemeris';
import { t } from './i18n';

const AU_PER_LY = 63241.077;

/** Distance in the unit that reads best at its size: km near planets, AU in the system, light years beyond. */
export function fmtDistance(au: number) {
  if (au < 0.02) {
    const km = au * KM_PER_AU;
    if (km < 10) {
      return t.m(Math.round(km * 1000));
    }
    return t.km(km < 1000 ? Math.round(km) : Math.round(km / 100) * 100);
  }
  if (au >= 20000) {
    const ly = au / AU_PER_LY;
    return t.ly(ly, ly < 10 ? 2 : 1);
  }
  return t.au(au, au < 1 ? 3 : au < 100 ? 2 : 0);
}

/** How long light takes to cross `au`. */
export function fmtLightTime(au: number) {
  const min = au * LIGHT_MIN_PER_AU;
  if (min < 1) {
    return t.seconds(min * 60);
  }
  if (min < 120) {
    return t.minutes(min);
  }
  if (min < 60 * 48) {
    return t.lightHours(min / 60);
  }
  if (min < 60 * 24 * 365.25 * 2) {
    return t.lightDays(min / 60 / 24);
  }
  return t.lightYears(min / 60 / 24 / 365.25);
}

export function fmtPeriod(days: number) {
  return days > 400 ? t.years(days / 365.25) : t.days(days);
}

export function fmtMass(kg: number) {
  const exp = Math.floor(Math.log10(kg));
  return t.kg((kg / 10 ** exp).toFixed(3).replace(/\.?0+$/, ''), exp);
}

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
