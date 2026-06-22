import React from 'react';

interface PillProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  /** Quando true, o pill é um indicador estático (vira <span>). */
  asStatic?: boolean;
}

/**
 * Pill segmentado usado em navs e filtros (nav superior, filtro de unidade).
 * Padroniza estados active/inactive + focus-visible.
 */
export function Pill({
  active = false,
  asStatic = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: PillProps) {
  const base = 'shrink-0 px-4 py-2 rounded-full text-[12px] font-black tracking-tight whitespace-nowrap transition-all border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
  const tone = active
    ? 'bg-primary text-white border-primary shadow-md shadow-primary/15'
    : 'bg-white text-slate-500 border-slate-200 hover:border-primary/30 hover:text-primary';
  const cls = `${base} ${tone} ${className}`;

  if (asStatic) {
    return <span className={cls}>{children}</span>;
  }

  return (
    <button
      type={type}
      aria-pressed={active}
      {...rest}
      className={cls}
    >
      {children}
    </button>
  );
}
