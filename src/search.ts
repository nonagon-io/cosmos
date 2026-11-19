import { dateOf } from './astro/ephemeris';
import type { Body, Region, SpaceEvent } from './data/schema';
import { esc } from './format';
import { t } from './i18n';
import type { Store } from './store';

type Hit =
  | { kind: 'body'; item: Body }
  | { kind: 'region'; item: Region }
  | { kind: 'event'; item: SpaceEvent };

interface Entry {
  hit: Hit;
  keys: string[];
}

const MAX = 8;
// Latin accents only: Thai vowels and tone marks are combining marks too and must stay
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[-_ʻ'’]/g, ' ')
    .trim();

function score(keys: string[], q: string) {
  let best = 0;
  for (const k of keys) {
    if (k === q) {
      return 4;
    }
    if (k.startsWith(q)) {
      best = Math.max(best, 3);
    } else if (k.includes(` ${q}`)) {
      best = Math.max(best, 2);
    } else if (k.includes(q)) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

/** Search with autocomplete. Cmd/Ctrl+F jumps to it instead of the browser's find. */
export function setupSearch(store: Store, choose: (h: Hit) => void) {
  const input = document.getElementById('search') as HTMLInputElement;
  const list = document.getElementById('search-list') as HTMLUListElement;
  input.placeholder = t.searchHint;
  input.setAttribute('aria-label', t.search);
  (document.getElementById('search-kbd') as HTMLElement).textContent = /Mac|iPhone|iPad/.test(
    navigator.platform,
  )
    ? '⌘F'
    : 'Ctrl F';

  const entries: Entry[] = [
    ...store.data.bodies.map((b) => ({
      hit: { kind: 'body', item: b } as Hit,
      keys: [b.name, b.en, b.id].map(norm),
    })),
    ...store.data.regions.map((r) => ({
      hit: { kind: 'region', item: r } as Hit,
      keys: [r.name, r.en, r.id].map(norm),
    })),
    ...store.data.events.map((e) => ({
      hit: { kind: 'event', item: e } as Hit,
      keys: [e.title, e.id].map(norm),
    })),
  ];
  let hits: Hit[] = [];
  let active = -1;

  const describe = (h: Hit) => {
    if (h.kind === 'body') {
      const b = h.item;
      const en = b.en !== b.name ? ` · ${esc(b.en)}` : '';
      return { name: esc(b.name), detail: `${t.kinds[b.kind]}${en}`, color: b.color };
    }
    if (h.kind === 'region') {
      return { name: esc(h.item.name), detail: t.region, color: '#8ea4c8' };
    }
    return {
      name: esc(h.item.title),
      detail: `${t.event} · ${t.dateShort(dateOf(store.eventDay(h.item)))}`,
      color: '#f0b35e',
    };
  };

  const render = () => {
    const q = input.value.trim();
    list.hidden = !q;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (!hits.length) {
      list.innerHTML = q ? `<li class="none">${t.searchNone}</li>` : '';
      return;
    }
    list.innerHTML = hits
      .map((h, i) => {
        const d = describe(h);
        return `<li role="option" data-i="${i}" aria-selected="${i === active}"><i style="background:${d.color}"></i><span class="nm">${d.name}</span><span class="dt">${d.detail}</span></li>`;
      })
      .join('');
  };

  const update = () => {
    const q = norm(input.value);
    hits = q
      ? entries
          .map((e) => ({ e, s: score(e.keys, q) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, MAX)
          .map((x) => x.e.hit)
      : [];
    active = hits.length ? 0 : -1;
    render();
  };

  const pick = (i: number) => {
    const h = hits[i];
    if (!h) {
      return;
    }
    input.value = '';
    hits = [];
    render();
    input.blur();
    choose(h);
  };

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) {
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length;
        render();
      }
    } else if (e.key === 'Enter') {
      pick(active);
    } else if (e.key === 'Escape') {
      input.value = '';
      update();
      input.blur();
    }
  });
  list.addEventListener('pointerdown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (li) {
      e.preventDefault();
      pick(Number(li.dataset.i));
    }
  });
  input.addEventListener('blur', () => {
    list.hidden = true;
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) {
      render();
    }
  });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

export type { Hit };
