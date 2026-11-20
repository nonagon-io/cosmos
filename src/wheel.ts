import type { View } from './data/schema';

// the turn of the drum from one row to the next; the row height comes from the stylesheet's --row
const STEP = 17;
// rows past this angle are round the back of the drum
const EDGE = 84;
// wheel pixels per row, and how long a pause in scrolling ends it
const WHEEL_PX = 70;
const SETTLE_MS = 260;

/**
 * The scale ladder as a drum: the row at the front is the view the camera is at, the rest tilt away and fade.
 * It turns with the camera's zoom, by any fraction of a row, and turning it by wheel, drag or arrow keys
 * picks the view it settles on and flies there.
 */
export class ScaleWheel {
  private items: HTMLElement[];
  private pos = 0;
  private target = 0;
  // following the camera, being turned by hand, or holding on a picked view while the camera flies to it
  private mode: 'follow' | 'turn' | 'fly' = 'follow';
  private flyUntil = 0;
  private settle = 0;
  private drag: { y: number; from: number; moved: boolean } | null = null;
  private justDragged = false;
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)');
  private row = 40;
  private radius = 0;

  constructor(
    private readonly list: HTMLElement,
    /** The stops, with distances that can change as the camera moves between bodies. */
    public views: View[],
    private readonly go: (v: View) => void,
  ) {
    this.items = [...list.querySelectorAll<HTMLElement>('li')];
    const measure = () => {
      this.row = Number.parseFloat(getComputedStyle(list).getPropertyValue('--row')) || 40;
      this.radius = this.row / 2 / Math.tan(((STEP / 2) * Math.PI) / 180);
      this.draw();
    };
    new ResizeObserver(measure).observe(list);

    list.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.turnTo(this.target + px / WHEEL_PX);
        clearTimeout(this.settle);
        this.settle = window.setTimeout(() => this.pick(Math.round(this.target)), SETTLE_MS);
      },
      { passive: false },
    );

    list.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      this.drag = { y: e.clientY, from: this.target, moved: false };
    });
    list.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) {
        return;
      }
      const dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dy) > 4) {
        d.moved = true;
        list.setPointerCapture(e.pointerId);
      }
      if (d.moved) {
        this.turnTo(d.from - dy / this.row);
      }
    });
    const end = () => {
      if (this.drag?.moved) {
        this.justDragged = true;
        this.pick(Math.round(this.target));
      }
      this.drag = null;
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);

    // a click picks a row, unless it is the end of a drag
    list.addEventListener(
      'click',
      (e) => {
        if (this.justDragged) {
          this.justDragged = false;
          e.stopPropagation();
          return;
        }
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
        if (b) {
          e.stopPropagation();
          this.pick(Number(b.dataset.v));
        }
      },
      true,
    );

    // tabbing onto a row turns it to the front without flying there
    list.addEventListener('focusin', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-v]');
      if (b && this.mode !== 'fly') {
        this.turnTo(Number(b.dataset.v));
      }
    });
    list.addEventListener('focusout', () => {
      if (this.mode === 'turn' && !this.drag) {
        this.mode = 'follow';
      }
    });

    list.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        e.preventDefault();
        const i = this.pick(Math.round(this.target) + step);
        this.items[i].querySelector('button')?.focus({ preventScroll: true });
      }
    });

    measure();
  }

  /**
   * A different set of stops, rendered into the list already: the drum turns straight to where the camera is
   * among them rather than spinning across from the old row.
   */
  replace(views: View[], distance: number) {
    this.views = views;
    this.items = [...this.list.querySelectorAll<HTMLElement>('li')];
    clearTimeout(this.settle);
    this.mode = 'follow';
    this.target = this.rowOf(distance);
    this.pos = this.target;
    this.draw();
  }

  /** Where the camera's `distance` falls among the views, as a fractional row. */
  private rowOf(distance: number) {
    const v = this.views;
    if (distance <= v[0].distance) {
      return 0;
    }
    for (let i = 0; i < v.length - 1; i++) {
      if (distance <= v[i + 1].distance) {
        const a = Math.log(v[i].distance);
        return i + (Math.log(distance) - a) / (Math.log(v[i + 1].distance) - a);
      }
    }
    return v.length - 1;
  }

  private turnTo(row: number) {
    this.mode = 'turn';
    this.target = Math.max(0, Math.min(this.views.length - 1, row));
  }

  private pick(row: number) {
    const i = Math.max(0, Math.min(this.views.length - 1, row));
    clearTimeout(this.settle);
    this.target = i;
    this.mode = 'fly';
    this.flyUntil = performance.now() + 6000;
    this.go(this.views[i]);
    return i;
  }

  /** Each frame, with the camera's distance from what it looks at. */
  tick(dt: number, distance: number) {
    const at = this.rowOf(distance);
    if (this.mode === 'fly' && (Math.abs(at - this.target) < 0.02 || performance.now() > this.flyUntil)) {
      this.mode = 'follow';
    }
    if (this.mode === 'follow') {
      this.target = at;
    }
    const was = this.pos;
    this.pos = this.still.matches ? this.target : this.pos + (this.target - this.pos) * Math.min(1, dt * 14);
    if (Math.abs(this.pos - this.target) < 0.001) {
      this.pos = this.target;
    }
    if (this.pos !== was) {
      this.draw();
    }
  }

  private draw() {
    for (const [i, li] of this.items.entries()) {
      const a = (i - this.pos) * STEP;
      const far = Math.abs(a) > EDGE;
      const c = Math.cos((Math.min(Math.abs(a), 90) * Math.PI) / 180);
      li.style.transform = far
        ? 'none'
        : `translateZ(${-this.radius}px) rotateX(${-a}deg) translateZ(${this.radius}px) scale(${0.72 + 0.28 * c})`;
      // rows round the back stay in the page for screen readers, just unseen and out of the pointer's way
      li.style.opacity = far ? '0' : String(c ** 1.2);
      li.style.pointerEvents = c < 0.5 ? 'none' : '';
    }
  }
}
