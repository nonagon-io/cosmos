import { dateOf } from './astro/ephemeris';
import { esc } from './format';
import { t } from './i18n';
import type { Hit } from './search';
import type { Store } from './store';

interface Category {
  key: keyof typeof t.browseCats;
  // items, under optional subheadings
  groups: { title?: string; hits: Hit[] }[];
}

/** A button by the search that opens everything there is to visit, by category. */
export function setupBrowse(store: Store, choose: (h: Hit) => void) {
  const { bodies, regions, events } = store.data;
  const body = (k: string[]) =>
    bodies.filter((b) => k.includes(b.kind)).map((b): Hit => ({ kind: 'body', item: b }));
  const region = (f: (r: (typeof regions)[number]) => boolean) =>
    regions.filter(f).map((r): Hit => ({ kind: 'region', item: r }));
  const parents = bodies.filter((b) => bodies.some((m) => m.kind === 'moon' && m.parent === b.id));

  const cats: Category[] = [
    { key: 'planets', groups: [{ hits: body(['star', 'planet']) }] },
    { key: 'dwarfs', groups: [{ hits: body(['dwarf']) }] },
    {
      key: 'moons',
      groups: parents.map((p) => ({
        title: t.moonOf(p.name),
        hits: bodies
          .filter((m) => m.kind === 'moon' && m.parent === p.id)
          .map((m): Hit => ({ kind: 'body', item: m })),
      })),
    },
    { key: 'small', groups: [{ hits: body(['asteroid', 'comet', 'interstellar']) }] },
    { key: 'craft', groups: [{ hits: body(['spacecraft']) }] },
    { key: 'zones', groups: [{ hits: region((r) => !r.at) }] },
    { key: 'clusters', groups: [{ hits: region((r) => r.at?.type === 'cluster') }] },
    { key: 'nebulae', groups: [{ hits: region((r) => r.at?.type === 'nebula') }] },
    {
      key: 'galaxies',
      groups: [{ hits: region((r) => !!r.at && ['galaxy', 'blackhole', 'void'].includes(r.at.type)) }],
    },
    {
      key: 'events',
      groups: [
        {
          hits: [...events]
            .sort((a, b) => store.eventDay(a) - store.eventDay(b))
            .map((e): Hit => ({ kind: 'event', item: e })),
        },
      ],
    },
  ].filter((c) => c.groups.some((g) => g.hits.length)) as Category[];

  const dialog = document.getElementById('browse') as HTMLDialogElement;
  const tabs = dialog.querySelector('.browse-tabs') as HTMLElement;
  const list = dialog.querySelector('.browse-list') as HTMLElement;
  let current = 0;
  let shown: Hit[] = [];

  const count = (c: Category) => c.groups.reduce((n, g) => n + g.hits.length, 0);
  const item = (h: Hit) => {
    const i = shown.push(h) - 1;
    if (h.kind === 'body') {
      const b = h.item;
      return `<button type="button" data-i="${i}"><i style="background:${b.color}"></i><span>${esc(b.name)}</span><small>${b.en !== b.name ? esc(b.en) : ''}</small></button>`;
    }
    if (h.kind === 'region') {
      const r = h.item;
      return `<button type="button" data-i="${i}"><i style="background:var(--label-region)"></i><span>${esc(r.name)}</span><small>${r.en !== r.name ? esc(r.en) : ''}</small></button>`;
    }
    const e = h.item;
    return `<button type="button" data-i="${i}"><i style="background:var(--accent)"></i><span>${esc(e.title)}</span><small>${t.dateShort(dateOf(store.eventDay(e)))}</small></button>`;
  };

  const render = () => {
    tabs.innerHTML = cats
      .map(
        (c, i) =>
          `<button type="button" role="tab" data-c="${i}" aria-selected="${i === current}">${t.browseCats[c.key]}<small>${count(c)}</small></button>`,
      )
      .join('');
    shown = [];
    list.innerHTML = cats[current].groups
      .map(
        (g) =>
          `${g.title ? `<h3>${esc(g.title)}</h3>` : ''}<div class="browse-items">${g.hits.map(item).join('')}</div>`,
      )
      .join('');
    list.scrollTop = 0;
  };

  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (b) {
      current = Number(b.dataset.c);
      render();
    }
  });
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    const h = b ? shown[Number(b.dataset.i)] : undefined;
    if (h) {
      dialog.close();
      choose(h);
    }
  });
  // a click on the backdrop lands on the dialog itself
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });
  dialog.querySelector('.close')?.addEventListener('click', () => dialog.close());
  document.getElementById('browse-btn')?.addEventListener('click', () => {
    render();
    dialog.showModal();
  });
}
