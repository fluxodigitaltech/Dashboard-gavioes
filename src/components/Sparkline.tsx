/**
 * Mini-gráfico de tendência (SVG puro, sem libs) pra embutir nos StatsCards.
 * Mantido propositalmente leve: 9 cards × 1 sparkline cada não justifica montar
 * 9 instâncias do Recharts. Desenha área + linha + ponto final.
 */
interface Props {
  values: number[];
  color?: string;
  /** Altura em px (largura é fluida via viewBox). */
  height?: number;
  className?: string;
}

const VBW = 100; // largura lógica do viewBox

export function Sparkline({ values, color = '#141414', height = 30, className }: Props) {
  if (!values || values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;
  const stepX = VBW / (n - 1);
  // pequena margem vertical pra linha não encostar nas bordas
  const pad = 2;
  const usableH = height - pad * 2;

  const xy = values.map((v, i) => {
    const x = i * stepX;
    const y = pad + usableH - ((v - min) / range) * usableH;
    return [x, y] as const;
  });

  const linePath = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${VBW},${height} L0,${height} Z`;
  const [lastX, lastY] = xy[xy.length - 1];
  const gid = `sl-${color.replace('#', '')}-${n}`;

  return (
    <svg
      viewBox={`0 0 ${VBW} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gid})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lastX} cy={lastY} r={2.2} fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
