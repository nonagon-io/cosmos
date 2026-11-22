// a button that drops a panel down under itself; closes on a click outside or Escape
export function dropdown(btn: HTMLElement, panel: HTMLElement) {
  const show = (on: boolean) => {
    panel.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
  };
  btn.addEventListener('click', () => show(Boolean(panel.hidden)));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.hidden && !panel.parentElement?.contains(e.target as Node)) {
      show(false);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) {
      show(false);
      btn.focus();
    }
  });
  return show;
}
