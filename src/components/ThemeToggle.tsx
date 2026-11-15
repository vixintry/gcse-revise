'use client';
export function ThemeToggle() {
  const toggle = () => {
    const el = document.documentElement;
    const dark = el.dataset.theme ? el.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    el.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* private mode: theme just won't persist */ }
  };
  return <button className="btn sm" onClick={toggle} aria-label="Switch between light and dark theme">Theme</button>;
}
