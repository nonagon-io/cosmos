import { dateOf, dayOf } from './astro/ephemeris';
import { t } from './i18n';
import { HOLE_SPEEDS, type Store } from './store';

const PLAY = '<path d="M2 1l9 5-9 5z" fill="currentColor"/>';
const PAUSE = '<path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor"/>';

/** The play control for the Galaxy's centre, which runs the S-stars and the disk on a clock of their own. */
export function setupHoleClock(store: Store) {
  const panel = document.getElementById('hole-clock') as HTMLElement;
  const play = panel.querySelector<HTMLButtonElement>('.btn') as HTMLButtonElement;
  const speeds = panel.querySelector<HTMLElement>('.seg') as HTMLElement;
  const main = panel.querySelector<HTMLElement>('strong') as HTMLElement;
  const alt = panel.querySelector<HTMLElement>('.date span') as HTMLElement;

  speeds.innerHTML = t.holeSpeeds.map((s, i) => `<button type="button" data-s="${i}">${s}</button>`).join('');
  speeds.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) {
      store.setHole({ speedIndex: Number(b.dataset.s), playing: true });
    }
  });
  play.addEventListener('click', () => store.setHole({ playing: !store.hole.playing }));
  panel
    .querySelector('.ghost-btn')
    ?.addEventListener('click', () => store.setHole({ day: dayOf(new Date()) }));

  let last = '';
  const render = () => {
    const h = store.hole;
    panel.hidden = !h.shown;
    if (!h.shown) {
      return;
    }
    const d = dateOf(h.day);
    const speed = HOLE_SPEEDS[h.speedIndex];
    // a year a second or faster the day and month only flicker past; the year is all that can be read
    const date = speed >= 365 ? t.yearOnly(d.getUTCFullYear()) : t.date(d);
    const slow = !h.playing || speed <= 1;
    const text = `${h.playing}${h.speedIndex}${date}${slow ? t.clock(d) : ''}`;
    if (text === last) {
      return;
    }
    last = text;
    play.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true">${h.playing ? PAUSE : PLAY}</svg><span>${h.playing ? t.pause : t.play}</span>`;
    for (const b of speeds.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.s) === h.speedIndex));
    }
    main.textContent = date;
    alt.textContent = slow ? t.clock(d) : '';
  };
  store.on('hole', render);
  render();
}
