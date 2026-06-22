import React from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Sparkline } from './Sparkline';
import { InfoTooltip } from './ui/InfoTooltip';

interface CardProps {
  title: string;
  value: string;
  /** Optional: arrow + colored % shown next to the value (e.g. "+12%" / "-3%"). */
  trend?: string;
  /** Secondary muted line under the value (e.g. "Meta Ads · últimos 30 dias"). */
  comparison?: string;
  /** Optional: tertiary muted line below `comparison` (e.g. "Mês passado: ↑X%"). */
  subComparison?: string;
  /** Optional: quaternary muted line below `subComparison` (e.g. "Ano passado: ↑Y%"). */
  subComparison2?: string;
  icon: React.ElementType;
  color?: 'primary' | 'accent' | 'rose' | 'secondary' | 'amber' | 'blue';
  isLoading?: boolean;
  /** Optional: full/raw value shown on hover (useful when `value` is abbreviated). */
  fullValue?: string;
  /** Optional: texto de ajuda (ⓘ) ao lado do título — explica jargão (CAC, evasão…). */
  info?: string;
  /** Optional: tailwind color class for the big number (default text-slate-900). E.g. 'text-emerald-600'. */
  valueColorClass?: string;
  /** Optional: when defined, card vira clicável (cursor + hover ring). */
  onClick?: () => void;
  /** Optional: bloco de meta no rodapé (barra de progresso + falta). */
  metaInfo?: {
    label: string;       // ex: "Meta: 700"
    pct: number;         // 0-150+ (passa de 100 quando bate/excede)
    falta?: string;      // ex: "Faltam 42" ou "Atingida ✓"
    lowerIsBetter?: boolean;  // pra inverter cor (alto=ruim)
  };
  /** Optional: mini-tendência (sparkline) dos últimos meses, embaixo do valor. */
  sparkline?: {
    values: number[];
    color?: string;
  };
}

type TrendTone = 'up' | 'down';
function getTrendTone(trend: string): TrendTone | null {
  const t = trend.trim();
  if (t.startsWith('+')) return 'up';
  if (t.startsWith('-')) return 'down';
  return null;
}

const TREND_STYLES: Record<TrendTone, { text: string; Icon: React.ElementType }> = {
  up:   { text: 'text-emerald-700', Icon: ArrowUpRight },
  down: { text: 'text-rose-700',    Icon: ArrowDownRight },
};

const COLOR_MAP = {
  primary:   { bg: 'bg-primary/10',   text: 'text-primary' },
  accent:    { bg: 'bg-accent/15',    text: 'text-accent'  },
  rose:      { bg: 'bg-rose-50',      text: 'text-rose-600' },
  secondary: { bg: 'bg-indigo-50',    text: 'text-indigo-500' },
  amber:     { bg: 'bg-amber-50',     text: 'text-amber-600' },
  blue:      { bg: 'bg-blue-50',      text: 'text-blue-600' },
} as const;

export const StatsCard = React.memo(function StatsCard({
  title,
  value,
  trend,
  comparison,
  subComparison,
  subComparison2,
  icon: Icon,
  color = 'primary',
  isLoading,
  fullValue,
  info,
  valueColorClass = 'text-slate-900',
  onClick,
  metaInfo,
  sparkline,
}: CardProps) {
  const trendTone = trend ? getTrendTone(trend) : null;
  const trendStyle = trendTone ? TREND_STYLES[trendTone] : null;
  const TrendIcon = trendStyle?.Icon;
  const colorStyle = COLOR_MAP[color];

  const isInteractive = !!onClick;
  const MotionComp = isInteractive ? motion.button : motion.div;

  return (
    <MotionComp
      type={isInteractive ? 'button' : undefined}
      initial={{ y: 8, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      whileHover={isInteractive ? { y: -2 } : undefined}
      onClick={onClick}
      aria-label={isInteractive ? `${title}: ${fullValue ?? value}` : undefined}
      className={`card-base card-pad relative min-w-0 h-full flex flex-col group overflow-hidden text-left w-full ${isInteractive ? 'card-interactive cursor-pointer hover:ring-2 hover:ring-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2' : ''}`}
    >
      {/* Header: title (left) + icon (right) — items-center alinha 1-linha
          perfeito e em 2-linhas o ícone fica centralizado contra o bloco. */}
      <div className="flex items-center justify-between gap-3 mb-4 min-w-0">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <p className="card-eyebrow line-clamp-2 min-w-0">
            {title}
          </p>
          {info && <InfoTooltip text={info} label={`O que é: ${title}`} />}
        </div>
        <div className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${colorStyle.bg} ${colorStyle.text} transition-transform duration-300 group-hover:scale-110`}>
          <Icon size={18} strokeWidth={2.5} aria-hidden="true" />
        </div>
      </div>

      {/* Value: âncora no topo da área flex pra ficar logo abaixo do título.
          Tamanho via token --card-value-size; truncate cuida do overflow. */}
      <div className="min-w-0 flex-1 flex items-start overflow-hidden">
        {isLoading ? (
          <div className="h-9 w-28 bg-slate-100 animate-pulse rounded-lg" />
        ) : (
          <h3
            className={`card-value ${valueColorClass} whitespace-nowrap truncate w-full`}
            title={fullValue ?? value}
          >
            {value}
          </h3>
        )}
      </div>

      {/* Mini-tendência (sparkline) — só quando há série e não está carregando.
          Fica entre o valor e o rodapé, dando leitura instantânea da direção. */}
      {!isLoading && sparkline && sparkline.values.length >= 2 && (
        <div className="mt-3 -mb-1 opacity-80 group-hover:opacity-100 transition-opacity" aria-hidden="true">
          <Sparkline values={sparkline.values} color={sparkline.color} height={28} />
        </div>
      )}

      {/* Footer: trend (inline, sem pill) + comparison + sub-linhas + meta-info.
          space-y-1 dá ritmo consistente; card-meta-slot reserva altura mínima. */}
      <div className="mt-4 min-w-0 card-meta-slot flex flex-col space-y-1">
        <div className="flex items-baseline gap-1.5 min-w-0">
          {trend && trendStyle && TrendIcon && (
            <span className={`inline-flex items-center gap-0.5 shrink-0 font-bold tabular-nums ${trendStyle.text}`} style={{ fontSize: 'var(--card-meta-size)' }}>
              <TrendIcon size={11} strokeWidth={2.75} aria-hidden="true" className="translate-y-px" />
              {trend.replace(/^[+-]/, '')}
            </span>
          )}
          {comparison && (
            <p className="card-meta truncate min-w-0" title={comparison}>
              {comparison}
            </p>
          )}
        </div>
        {subComparison && (
          <p className="card-meta truncate min-w-0" title={subComparison}>
            {subComparison}
          </p>
        )}
        {subComparison2 && (
          <p className="card-meta truncate min-w-0" title={subComparison2}>
            {subComparison2}
          </p>
        )}
        {/* Slot reservado SEMPRE pro metaInfo (mesmo vazio) — garante que cards
            com e sem meta tenham a mesma altura interna. */}
        <div className="card-metainfo-slot pt-1">
          {metaInfo && (() => {
            // Cor por status: bate ou excede meta = verde; >=80% = âmbar; senão rosa.
            // Pra lowerIsBetter (ex: inadimplência), inverte: <=100% = verde; <=120% = âmbar; senão rosa.
            const pct = metaInfo.pct;
            const ok = metaInfo.lowerIsBetter ? pct <= 100 : pct >= 100;
            const close = metaInfo.lowerIsBetter ? pct <= 120 : pct >= 80;
            const tone = ok ? 'emerald' : close ? 'amber' : 'rose';
            const barColor = tone === 'emerald' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-rose-500';
            const txtColor = tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-rose-700';
            return (
              <div className="pt-2.5 border-t border-slate-100">
                <div className="flex items-center justify-between gap-2 mb-1.5 text-[11px] leading-tight">
                  <span className="text-slate-500 font-semibold truncate" title={metaInfo.label}>{metaInfo.label}</span>
                  <span className={`tabular-nums font-bold shrink-0 ${txtColor}`}>{pct}%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
                </div>
                {metaInfo.falta && (
                  <p className="text-[11px] font-medium text-slate-500 leading-tight mt-1.5 truncate" title={metaInfo.falta}>
                    {metaInfo.falta}
                  </p>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </MotionComp>
  );
});
