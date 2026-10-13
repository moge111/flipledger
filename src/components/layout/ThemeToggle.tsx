'use client';

// ◐ flips light/dark and remembers the choice (the pre-paint script in layout.tsx reads it back).
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const toggle = () => {
    const root = document.documentElement;
    root.dataset.mode = root.dataset.mode === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('fl-theme', root.dataset.mode); } catch {}
  };
  return (
    <button
      type="button"
      onClick={toggle}
      title="Switch light / dark"
      aria-label="Switch light or dark theme"
      className={`inline-flex items-center justify-center h-[30px] min-w-[30px] px-2 rounded-md border-[1.5px] border-top-fg/40 text-top-fg text-[13px] font-semibold hover:border-top-fg transition-colors ${className}`}
    >
      ◐
    </button>
  );
}
