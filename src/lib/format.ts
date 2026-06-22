/**
 * Number & currency formatting helpers — pt-BR locale.
 *
 * Used across the dashboard to keep KPI cards compact and scannable.
 * Compact notation:
 *   1.234        → "1,2 mil"
 *   546.300      → "546 mil"
 *   1.546.300    → "1,5 mi"
 *   1_546_300_00 → "154,6 mi"
 */

const BR = new Intl.NumberFormat('pt-BR');
// Formatter monetário COM centavos (2 casas) — usado pra exibir valor exato.
const BRL2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Standard thousands-separator number, e.g. 1234 → "1.234". */
export function formatNumber(n: number): string {
  return BR.format(Math.round(n));
}

/**
 * Compact number for KPI cards. Returns up to 4 visible characters of value
 * plus a unit suffix. Designed so cards never overflow at any width.
 *
 *   999       → "999"
 *   1.234     → "1,2 mil"
 *   546.300   → "546 mil"
 *   1.546.300 → "1,5 mi"
 */
export function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return BR.format(Math.round(n));
  if (abs < 1_000_000) {
    const v = n / 1_000;
    // 1 decimal if needed, no decimal for round numbers
    return `${formatDecimal(v)} mil`;
  }
  if (abs < 1_000_000_000) {
    const v = n / 1_000_000;
    return `${formatDecimal(v)} mi`;
  }
  const v = n / 1_000_000_000;
  return `${formatDecimal(v)} bi`;
}

/**
 * (Antes abreviava — "R$ 1,5 mi".) Por decisão do produto, NÃO arredonda/abrevia
 * mais: mostra o valor EXATO com centavos, idêntico a {@link formatBRL}. Mantido
 * como alias pra não precisar trocar os ~15 call sites. Os gráficos têm
 * formatadores próprios e compactos pros eixos (não usam esta função).
 */
export function formatCompactBRL(n: number): string {
  return formatBRL(n);
}

/** BRL completo COM centavos, ex: 1546387.5 → "R$ 1.546.387,50". */
export function formatBRL(n: number): string {
  return `R$ ${BRL2.format(n)}`;
}

/** 1 decimal if not integer, no decimal otherwise. Comma as decimal separator. */
function formatDecimal(n: number): string {
  if (Number.isInteger(n)) return BR.format(n);
  return n.toFixed(1).replace('.', ',');
}

/** Percent display (2 casas decimais), with sign for trend arrows. */
export function formatPercent(n: number, withSign = false): string {
  const v = n.toFixed(2).replace('.', ',');
  if (withSign && n > 0) return `+${v}%`;
  return `${v}%`;
}

/**
 * Compute a trend string with sign for StatsCard's badge.
 *   trendVs(681, 656) → "+4%"
 *   trendVs(15, 20)   → "-25%"
 *   trendVs(15, 0)    → null (sem comparação)
 *   trendVs(15, 15)   → null (sem mudança significativa)
 */
export function trendVs(current: number, previous: number): string | null {
  if (!previous || previous === 0) return null;
  const delta = current - previous;
  const pct = (delta / previous) * 100;
  if (Math.abs(pct) < 0.005) return null; // < 0,005% → arredonda pra 0,00, não vale mostrar
  const v = Math.abs(pct).toFixed(2).replace('.', ',');
  return pct > 0 ? `+${v}%` : `-${v}%`;
}

/**
 * Padroniza comparação com o mês anterior para o footer/comparison dos cards.
 * Sempre mostra o número ABSOLUTO do mês passado + delta com sinal.
 *
 *   compareToPrev(681, 650)      → "Mês passado: 650 · +31"
 *   compareToPrev(656, 660)      → "Mês passado: 660 · −4"
 *   compareToPrev(681, 681)      → "Mês passado: 681 · sem mudança"
 *   compareToPrev(681, 0)        → "" (primeira leitura, sem histórico)
 *
 * Para valores monetários use moneyFormatter para formatar tanto o prev quanto o delta.
 */
export function compareToPrev(
  current: number,
  prev: number,
  moneyFormatter?: (n: number) => string,
): string {
  if (!prev || prev === 0) return '';
  const delta = current - prev;
  const fmt = moneyFormatter ?? formatNumber;
  if (delta === 0) return `Mês passado: ${fmt(prev)} · sem mudança`;
  const sign = delta > 0 ? '+' : '−';
  return `Mês passado: ${fmt(prev)} · ${sign}${fmt(Math.abs(delta))}`;
}

/**
 * Formata 1 comparativo "↑ X% comparado ao <período>" — usado nos cards
 * de Painel/Financeiro como sub-comparison padronizado.
 *
 * Retorna string vazia ('') quando:
 *   - hasData = false (sem snapshot histórico daquele período)
 *   - before <= 0 e unitPP = false (denominador zero faz a % explodir)
 *
 * unitPP = true: o cálculo é em pontos percentuais (delta absoluto entre
 * duas %). Use pra valores que JÁ são porcentagens (ex: % Inadimplência).
 *
 * Exemplos:
 *   fmtCmp(105, 100, true,  'mês anterior')      → '↑ 5,0% comparado ao mês anterior'
 *   fmtCmp(95,  100, true,  'ano anterior')      → '↓ 5,0% comparado ao ano anterior'
 *   fmtCmp(3.8, 6.5, true,  'ano anterior', true)→ '↓ 2,70pp comparado ao ano anterior'
 *   fmtCmp(100, 0,   true,  'ano anterior')      → '' (sem base)
 *   fmtCmp(100, 100, false, 'ano anterior')      → '' (hasData=false)
 */
export function fmtCmp(
  now: number,
  before: number,
  hasData: boolean,
  periodLabel: string,
  unitPP = false,
): string {
  if (!hasData) return '';
  if (unitPP) {
    const delta = now - before;
    const arrow = delta > 0 ? '↑' : (delta < 0 ? '↓' : '=');
    const sign = delta > 0 ? '+' : (delta < 0 ? '-' : '');
    return `${arrow} ${sign}${Math.abs(delta).toFixed(2).replace('.', ',')}pp comparado ao ${periodLabel}`;
  }
  if (before <= 0) return '';
  const pct = ((now - before) / before) * 100;
  const arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '=');
  const sign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
  return `${arrow} ${sign}${Math.abs(pct).toFixed(2).replace('.', ',')}% comparado ao ${periodLabel}`;
}

/**
 * Internal: builds 1 comparison "fragment" (just the arrow+number, sem prefix).
 *   "↑ +5,0%"  /  "↓ -2,70pp"
 * Empty string se hasData=false ou base zero (não unitPP).
 */
function _buildPart(now: number, before: number, hasData: boolean, unitPP: boolean): string {
  if (!hasData) return '';
  if (unitPP) {
    const delta = now - before;
    const arrow = delta > 0 ? '↑' : (delta < 0 ? '↓' : '=');
    const sign = delta > 0 ? '+' : (delta < 0 ? '-' : '');
    return `${arrow} ${sign}${Math.abs(delta).toFixed(2).replace('.', ',')}pp`;
  }
  if (before <= 0) return '';
  const pct = ((now - before) / before) * 100;
  const arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '=');
  const sign = pct > 0 ? '+' : (pct < 0 ? '-' : '');
  return `${arrow} ${sign}${Math.abs(pct).toFixed(2).replace('.', ',')}%`;
}

/**
 * Combina 2 comparativos (mês + ano) numa única linha pra subComparison
 * dos cards. Se um dos dois falta, mostra só o que tem. Se nenhum,
 * retorna undefined (StatsCard oculta a linha).
 *
 * Use {@link fmtComparativosLines} se quiser as duas linhas separadas
 * (formato preferido — uma embaixo da outra fica mais legível).
 *
 * Output:
 *   ambos   → "Mês passado: ↑ 5,0% · Ano passado: ↑ 12,3%"
 *   só mês  → "Mês passado: ↑ 5,0%"
 *   só ano  → "Ano passado: ↑ 12,3%"
 *   nenhum  → undefined
 */
export function fmtComparativos(
  now: number,
  prev: number,
  yearAgo: number,
  hasPrevData: boolean,
  hasYearData: boolean,
  unitPP = false,
): string | undefined {
  const mesPart = _buildPart(now, prev, hasPrevData, unitPP);
  const anoPart = _buildPart(now, yearAgo, hasYearData, unitPP);
  if (mesPart && anoPart) return `Mês passado: ${mesPart} · Ano passado: ${anoPart}`;
  if (mesPart) return `Mês passado: ${mesPart}`;
  if (anoPart) return `Ano passado: ${anoPart}`;
  return undefined;
}

/**
 * Versão "duas linhas" de {@link fmtComparativos}. Devolve { mes, ano }
 * pra os cards renderizarem cada um numa linha separada (formato pedido
 * pelo cliente, igual ao Faturamento Estimado: cada info embaixo da outra).
 *
 * Output:
 *   { mes: 'Mês passado: ↑ 5,0%', ano: 'Ano passado: ↑ 12,3%' }
 *   ou undefined em qualquer um se falta dado.
 */
export function fmtComparativosLines(
  now: number,
  prev: number,
  yearAgo: number,
  hasPrevData: boolean,
  hasYearData: boolean,
  unitPP = false,
): { mes?: string; ano?: string } {
  const mesPart = _buildPart(now, prev, hasPrevData, unitPP);
  const anoPart = _buildPart(now, yearAgo, hasYearData, unitPP);
  return {
    mes: mesPart ? `Mês passado: ${mesPart}` : undefined,
    ano: anoPart ? `Ano passado: ${anoPart}` : undefined,
  };
}

/**
 * Human-friendly relative time in pt-BR.
 *   < 60s   -> "agora há pouco"
 *   < 60min -> "há 5 minutos"
 *   < 24h   -> "há 3 horas"
 *   else    -> "há 2 dias"
 */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'agora há pouco';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `há ${diffMin} ${diffMin === 1 ? 'minuto' : 'minutos'}`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `há ${diffHr} ${diffHr === 1 ? 'hora' : 'horas'}`;
  const diffDay = Math.floor(diffHr / 24);
  return `há ${diffDay} ${diffDay === 1 ? 'dia' : 'dias'}`;
}
