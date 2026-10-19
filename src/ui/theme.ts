import { el } from './dom';

export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'hexhaust-theme';
const ORDER: ThemeMode[] = ['auto', 'light', 'dark'];

function load(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // storage unavailable: stay on "auto"
  }
  return 'auto';
}

function save(mode: ThemeMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    // not critical
  }
}

export function applyTheme(mode: ThemeMode): void {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export function createThemeToggle(): HTMLButtonElement {
  let mode = load();
  applyTheme(mode);
  const btn = el('button', 'btn btn-quiet theme-btn');
  btn.type = 'button';
  const paint = (): void => {
    btn.textContent = `Theme: ${mode}`;
    btn.title = 'Switch theme: auto → light → dark';
  };
  paint();
  btn.addEventListener('click', () => {
    mode = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length] ?? 'auto';
    applyTheme(mode);
    save(mode);
    paint();
  });
  return btn;
}
