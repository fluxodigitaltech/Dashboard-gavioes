/**
 * Camada de "inteligência" dos gráficos de tendência — módulo PURO (sem deps,
 * sem React, sem jsPDF). Compartilhado entre o Painel (Recharts) e o PDF (jsPDF)
 * pra a lógica analítica viver num lugar só.
 *
 * O que faz:
 *   - Regressão linear (mínimos quadrados) → slope, intercept, r²
 *   - Linha de tendência (valores ajustados pra cada ponto)
 *   - Projeção do próximo mês (extrapolação da regressão, com guarda de ruído)
 *   - Momentum (acelerando / desacelerando / estável)
 *   - Detecção de pico/vale (melhor/pior mês)
 *   - Geração de insights em texto pt-BR, com "tom" (bom/ruim/neutro)
 *
 * Convenção de série: array ordenado do mês mais ANTIGO ao mais RECENTE.
 */

export interface MonthPoint {
  /** 'YYYY-MM' */
  month: string;
  value: number;
}

export interface Regression {
  slope: number;      // variação média por mês
  intercept: number;  // valor em x=0
  r2: number;         // qualidade do ajuste 0..1 (1 = reta perfeita)
}

export type Momentum = 'accelerating' | 'decelerating' | 'steady' | 'flat';
export type Direction = 'up' | 'down' | 'flat';
export type Tone = 'good' | 'bad' | 'neutral';

export interface TrendInsight {
  reg: Regression;
  trendline: number[];          // valor ajustado pra cada índice da série
  projection: number | null;    // previsão do próximo mês (null se ruído alto demais)
  projConfident: boolean;       // r² alto o suficiente pra confiar na projeção
  growthPct: number | null;     // variação % do 1º ao último ponto
  momPct: number | null;        // variação % do penúltimo pro último (month-over-month)
  best: MonthPoint | null;
  worst: MonthPoint | null;
  direction: Direction;
  momentum: Momentum;
}

/** Configuração semântica de uma métrica pra gerar texto e tom corretos. */
export interface MetricMeta {
  label: string;
  /** Formata um valor pra exibição (ex: formatNumber, formatCompactBRL). */
  fmt: (n: number) => string;
  /** true = subir é RUIM (ex: % Inadimplência). Inverte o tom dos insights. */
  lowerIsBetter?: boolean;
  /** true = a métrica já é uma porcentagem (muda a redação de crescimento). */
  isPct?: boolean;
}

// ─── Núcleo estatístico ──────────────────────────────────────────────────────

/** Regressão linear por mínimos quadrados sobre x = 0,1,2,...,n-1. */
export function linearRegression(values: number[]): Regression {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: values[0], r2: 1 };

  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    const dy = values[i] - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = yMean - slope * xMean;

  // r² = (covariância)² / (var_x · var_y). syy=0 → série constante → ajuste perfeito.
  const r2 = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));

  return { slope, intercept, r2 };
}

/** Valores da linha de tendência (reta ajustada) pra cada índice. */
export function trendlineValues(values: number[]): number[] {
  const { slope, intercept } = linearRegression(values);
  return values.map((_, i) => intercept + slope * i);
}

// ─── Análise completa ────────────────────────────────────────────────────────

const PROJ_MIN_R2 = 0.25; // abaixo disso a série é ruidosa demais pra projetar com confiança

/**
 * Analisa uma série mensal e devolve tudo que os gráficos precisam.
 * Projeção é clampada em >= 0 (não existe "ativos negativos"). Quando o ajuste
 * é fraco (r² baixo), `projConfident=false` e usamos a última leitura como
 * estimativa conservadora em vez de extrapolar uma reta sem sentido.
 */
export function analyzeTrend(points: MonthPoint[]): TrendInsight {
  const values = points.map(p => p.value);
  const n = values.length;
  const reg = linearRegression(values);
  const trendline = values.map((_, i) => reg.intercept + reg.slope * i);

  let projection: number | null = null;
  let projConfident = false;
  if (n >= 3) {
    const raw = reg.intercept + reg.slope * n;
    projConfident = reg.r2 >= PROJ_MIN_R2;
    projection = Math.max(0, projConfident ? raw : values[n - 1]);
  }

  const first = values[0];
  const last = values[n - 1];
  const prev = n >= 2 ? values[n - 2] : 0;
  const growthPct = n >= 2 && first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
  const momPct = n >= 2 && prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null;

  let best: MonthPoint | null = null;
  let worst: MonthPoint | null = null;
  for (const p of points) {
    if (!best || p.value > best.value) best = p;
    if (!worst || p.value < worst.value) worst = p;
  }

  const mean = values.reduce((s, v) => s + v, 0) / Math.max(n, 1);
  const eps = Math.abs(mean) * 0.005; // 0,5% da média = "praticamente estável"
  const direction: Direction = Math.abs(reg.slope) < eps ? 'flat' : reg.slope > 0 ? 'up' : 'down';

  const momentum = computeMomentum(values, eps);

  return { reg, trendline, projection, projConfident, growthPct, momPct, best, worst, direction, momentum };
}

/** Compara a inclinação da 2ª metade vs 1ª metade pra detectar aceleração. */
function computeMomentum(values: number[], eps: number): Momentum {
  const n = values.length;
  if (n < 4) return 'steady';
  const mid = Math.floor(n / 2);
  const firstSlope = linearRegression(values.slice(0, mid + 1)).slope;
  const secondSlope = linearRegression(values.slice(mid)).slope;

  const overall = linearRegression(values).slope;
  if (Math.abs(overall) < eps) return 'flat';

  // Direções opostas entre as metades → o movimento perdeu força (desacelerando).
  if (Math.sign(firstSlope) !== Math.sign(secondSlope)) return 'decelerating';

  const a = Math.abs(firstSlope);
  const b = Math.abs(secondSlope);
  if (b > a * 1.15) return 'accelerating';
  if (b < a * 0.85) return 'decelerating';
  return 'steady';
}

// ─── Geração de insights em texto ────────────────────────────────────────────

export interface Insight {
  text: string;
  tone: Tone;
}

/** Rótulo curto do mês: '2025-03' → 'mar/25'. */
export function formatMonthShort(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${MESES[(m - 1) % 12]}/${String(y).slice(2)}`;
}

const fmtPct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2).replace('.', ',')}%`;

/**
 * Gera 3-4 insights em pt-BR a partir da análise. A ordem é por relevância:
 * crescimento → momentum → projeção → pico/vale. Cada insight tem um tom pra
 * colorir (verde=bom, rosa=ruim, neutro=cinza), já considerando `lowerIsBetter`.
 */
export function buildInsights(points: MonthPoint[], meta: MetricMeta): Insight[] {
  if (points.length < 2) return [];
  const t = analyzeTrend(points);
  const out: Insight[] = [];
  const lower = meta.lowerIsBetter ?? false;

  // Tom de uma variação: "subiu" é bom, salvo lowerIsBetter (aí subir é ruim).
  const toneFor = (delta: number): Tone => {
    if (delta === 0) return 'neutral';
    const positive = delta > 0;
    const isGood = lower ? !positive : positive;
    return isGood ? 'good' : 'bad';
  };

  // 1. Crescimento no período
  if (t.growthPct !== null && points.length >= 2) {
    const arrow = t.growthPct > 0 ? '↑' : t.growthPct < 0 ? '↓' : '→';
    const periodo = `${points.length} meses`;
    out.push({
      text: `${arrow} ${fmtPct(t.growthPct)} em ${periodo} (${meta.fmt(points[0].value)} → ${meta.fmt(points[points.length - 1].value)})`,
      tone: toneFor(t.growthPct),
    });
  }

  // 2. Momentum
  const MOM_TXT: Record<Momentum, { text: string; tone: Tone }> = {
    accelerating: { text: 'Ritmo acelerando nos últimos meses', tone: lower ? 'bad' : 'good' },
    decelerating: { text: 'Ritmo desacelerando / perdendo força', tone: lower ? 'good' : 'bad' },
    steady:       { text: 'Ritmo constante', tone: 'neutral' },
    flat:         { text: 'Estável, sem tendência clara', tone: 'neutral' },
  };
  // Só vale a pena falar de momentum quando há direção e dados suficientes.
  if (points.length >= 4 && t.direction !== 'flat') out.push(MOM_TXT[t.momentum]);

  // 3. Projeção
  if (t.projection !== null) {
    const last = points[points.length - 1].value;
    const delta = t.projection - last;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    const conf = t.projConfident ? '' : ' (baixa confiança)';
    out.push({
      text: `Projeção próximo mês: ~${meta.fmt(t.projection)} ${arrow}${conf}`,
      tone: t.projConfident ? toneFor(delta) : 'neutral',
    });
  }

  // 4. Pico / vale
  if (t.best && t.worst && t.best.month !== t.worst.month) {
    // Destaque é sempre o MAIOR valor: pra lowerIsBetter é o "pico ruim"
    // (rotulado "Maior"); pra higherIsBetter é o recorde (rotulado "Pico").
    const highlight = t.best;
    const label = lower ? 'Maior' : 'Pico';
    out.push({
      text: `${label}: ${meta.fmt(highlight.value)} em ${formatMonthShort(highlight.month)}`,
      tone: 'neutral',
    });
  }

  return out;
}
