export interface LabelEntry {
  id: string;
  text: string;
  x: number;
  y: number;
  priority: number;
  color: string;
  className: string;
  /** px to the right of the point where the text starts */
  offset: number;
}

const HEIGHT = 16;

/** DOM labels placed in screen space, highest priority first, skipping any that would overlap. */
export class Labels {
  private readonly els = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    onClick: (id: string) => void,
  ) {
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (el?.dataset.id) {
        onClick(el.dataset.id);
      }
    });
  }

  render(entries: LabelEntry[]) {
    entries.sort((a, b) => b.priority - a.priority);
    const placed: [number, number, number, number][] = [];
    const shown = new Set<string>();
    for (const e of entries) {
      const w = e.text.length * 6.6 + 8;
      const x0 = e.x + e.offset;
      const y0 = e.y - HEIGHT / 2;
      const box: [number, number, number, number] = [x0 - 2, y0 - 1, x0 + w + 2, y0 + HEIGHT + 1];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) {
        continue;
      }
      placed.push(box);
      shown.add(e.id);
      let el = this.els.get(e.id);
      if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.dataset.id = e.id;
        this.root.append(el);
        this.els.set(e.id, el);
      }
      if (el.textContent !== e.text) {
        el.textContent = e.text;
      }
      el.className = `label ${e.className}`;
      el.style.setProperty('--c', e.color);
      el.style.transform = `translate(${Math.round(x0)}px, ${Math.round(y0)}px)`;
      el.hidden = false;
    }
    for (const [id, el] of this.els) {
      if (!shown.has(id)) {
        el.hidden = true;
      }
    }
  }
}
