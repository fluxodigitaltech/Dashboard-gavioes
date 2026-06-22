import { motion } from 'framer-motion';

/**
 * Termômetro de um plano: altura da "coluna de mercúrio" ∝ tamanho da base ativa
 * do plano (escalado pelo maior plano visível), e a coluna é segmentada em
 * ANTIGO (base, verde) + NOVO (topo, lima). Dá leitura instantânea de tamanho
 * E composição (renovação) do plano de uma só vez.
 */
export interface PlanThermometerProps {
  plano: string;
  total: number;
  novo: number;
  antigo: number;
  valor: number;       // R$ somado dos contratos ativos do plano
  maxTotal: number;    // maior `total` entre os planos visíveis (escala da altura)
  baseTotal: number;   // soma de todos os ativos (pra % da base)
  animationDelay?: number;
}

const COR_ANTIGO = '#141414'; // primary (verde escuro) — base consolidada
const COR_NOVO   = '#fc3000'; // accent (lima) — entradas do mês

// Geometria do SVG do termômetro
const VB_W = 64;
const VB_H = 200;
const TUBE_X = 22;
const TUBE_W = 20;
const TUBE_TOP = 12;
const TUBE_BOTTOM = 150;
const TUBE_H = TUBE_BOTTOM - TUBE_TOP; // 138
const BULB_CY = 172;
const BULB_R = 19;

function fmtMoneyCompact(v: number): string {
  if (v >= 1000) return `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;
}

export function PlanThermometer({
  plano, total, novo, antigo, valor, maxTotal, baseTotal, animationDelay = 0,
}: PlanThermometerProps) {
  const fillFrac  = maxTotal > 0 ? Math.min(total / maxTotal, 1) : 0;
  const fillH     = fillFrac * TUBE_H;
  const antigoFrac = total > 0 ? antigo / total : 0;
  const antigoH   = fillH * antigoFrac;
  const novoH     = fillH - antigoH;

  const antigoY   = TUBE_BOTTOM - antigoH;       // antigo encosta no fundo
  const novoY     = antigoY - novoH;             // novo empilha por cima
  const novoPct   = total > 0 ? (novo / total) * 100 : 0;
  const sharePct  = baseTotal > 0 ? (total / baseTotal) * 100 : 0;

  return (
    <motion.div
      initial={{ y: 16, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.4, delay: animationDelay }}
      className="card-base p-5 flex gap-4 items-stretch min-w-0 hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)] transition-shadow"
    >
      {/* ── Termômetro SVG ── */}
      <div className="shrink-0 self-center">
        <svg width={VB_W} height={VB_H} viewBox={`0 0 ${VB_W} ${VB_H}`} aria-hidden="true">
          <defs>
            <clipPath id={`tube-${plano.replace(/\W/g, '')}`}>
              <rect x={TUBE_X} y={TUBE_TOP} width={TUBE_W} height={TUBE_H + 30} rx={TUBE_W / 2} />
              <circle cx={TUBE_X + TUBE_W / 2} cy={BULB_CY} r={BULB_R} />
            </clipPath>
          </defs>

          {/* Trilho (track) — tubo vazio */}
          <rect x={TUBE_X} y={TUBE_TOP} width={TUBE_W} height={TUBE_H} rx={TUBE_W / 2} fill="#eef2f6" />
          <circle cx={TUBE_X + TUBE_W / 2} cy={BULB_CY} r={BULB_R} fill="#eef2f6" />

          {/* Mercúrio (clipado pela forma tubo+bulbo) */}
          <g clipPath={`url(#tube-${plano.replace(/\W/g, '')})`}>
            {/* Bulbo sempre cheio (verde = base) */}
            <circle cx={TUBE_X + TUBE_W / 2} cy={BULB_CY} r={BULB_R} fill={COR_ANTIGO} />
            <rect x={TUBE_X} y={TUBE_BOTTOM - 6} width={TUBE_W} height={28} fill={COR_ANTIGO} />
            {/* Segmento ANTIGO (base) */}
            <motion.rect
              x={TUBE_X} width={TUBE_W} fill={COR_ANTIGO}
              initial={{ height: 0, y: TUBE_BOTTOM }}
              animate={{ height: antigoH, y: antigoY }}
              transition={{ duration: 0.8, delay: animationDelay, ease: [0.22, 1, 0.36, 1] }}
            />
            {/* Segmento NOVO (topo) */}
            <motion.rect
              x={TUBE_X} width={TUBE_W} fill={COR_NOVO}
              initial={{ height: 0, y: TUBE_BOTTOM }}
              animate={{ height: novoH, y: novoY }}
              transition={{ duration: 0.8, delay: animationDelay + 0.1, ease: [0.22, 1, 0.36, 1] }}
            />
          </g>

          {/* Marcas de escala (estética de termômetro) */}
          {[0.25, 0.5, 0.75].map(t => {
            const y = TUBE_BOTTOM - t * TUBE_H;
            return <line key={t} x1={TUBE_X + TUBE_W + 3} y1={y} x2={TUBE_X + TUBE_W + 9} y2={y} stroke="#cbd5e1" strokeWidth={1.5} />;
          })}

          {/* Contorno sutil do tubo */}
          <rect x={TUBE_X} y={TUBE_TOP} width={TUBE_W} height={TUBE_H} rx={TUBE_W / 2} fill="none" stroke="#e2e8f0" strokeWidth={1} />
          <circle cx={TUBE_X + TUBE_W / 2} cy={BULB_CY} r={BULB_R} fill="none" stroke="#e2e8f0" strokeWidth={1} />
        </svg>
      </div>

      {/* ── Dados ── */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <p className="text-[12px] font-black text-slate-700 leading-tight line-clamp-2 mb-1" title={plano}>
          {plano}
        </p>
        <div className="flex items-baseline gap-1.5 mb-3">
          <span className="text-[2rem] font-black text-[#0F172A] leading-none tabular-nums">{total.toLocaleString('pt-BR')}</span>
          <span className="text-[11px] font-bold text-slate-400">ativos · {sharePct.toFixed(2).replace('.', ',')}% da base</span>
        </div>

        {/* Legenda novo/antigo */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: COR_NOVO }} /> Novos no mês
            </span>
            <span className="text-[12px] font-black tabular-nums text-slate-800">{novo.toLocaleString('pt-BR')}<span className="text-slate-400 font-bold"> · {novoPct.toFixed(2).replace('.', ',')}%</span></span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: COR_ANTIGO }} /> Base antiga
            </span>
            <span className="text-[12px] font-black tabular-nums text-slate-800">{antigo.toLocaleString('pt-BR')}</span>
          </div>
        </div>

        {valor > 0 && (
          <p className="text-[11px] font-bold text-slate-400 mt-3 pt-2.5 border-t border-slate-100 tabular-nums">
            {fmtMoneyCompact(valor)} <span className="text-slate-300">em contratos</span>
          </p>
        )}
      </div>
    </motion.div>
  );
}
