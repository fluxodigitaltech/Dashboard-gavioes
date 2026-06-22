import React from 'react';

type Tone = 'neutral' | 'primary' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: React.ReactNode;
  label: string;
  tone?: Tone;
  size?: Size;
  badge?: React.ReactNode;
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'w-9 h-9',
  md: 'w-10 h-10',
  lg: 'w-10 h-10 lg:w-11 lg:h-11',
};

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'text-slate-500 hover:text-primary hover:border-primary/20 focus-visible:ring-primary/40',
  primary: 'text-primary hover:bg-slate-50 focus-visible:ring-primary/40',
  danger:  'text-slate-500 hover:text-rose-500 hover:border-rose-200 focus-visible:ring-rose-300',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tone = 'neutral', size = 'lg', badge, className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      {...rest}
      className={`${SIZE_CLASSES[size]} flex items-center justify-center rounded-2xl bg-white border border-slate-100 transition-all relative focus:outline-none focus-visible:ring-2 ${TONE_CLASSES[tone]} ${className}`}
    >
      {icon}
      {badge}
    </button>
  );
});
