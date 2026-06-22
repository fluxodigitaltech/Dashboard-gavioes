import { useState } from 'react';

interface AvatarProps {
  seed: string;
  alt?: string;
  className?: string;
}

function initialsOf(seed: string): string {
  const cleaned = seed.split('@')[0].replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Avatar com fallback local — se DiceBear cair, mostra iniciais derivadas do seed.
 */
export function Avatar({ seed, alt = 'User', className = '' }: AvatarProps) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex items-center justify-center bg-primary/10 text-primary text-[12px] font-black uppercase select-none ${className}`}
      >
        {initialsOf(seed)}
      </div>
    );
  }

  return (
    <img
      src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(seed)}`}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setErrored(true)}
      className={`object-cover ${className}`}
    />
  );
}
