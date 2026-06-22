// PDF Report Generator — Gaviões 24h Dashboard
// Layout profissional A4 portrait, dados reais (não usa mais ticket fictício).

import { jsPDF } from 'jspdf';
import { GAVIOES_LOGO_BASE64 } from './logoBase64';
import type { DashboardData } from '../App';
import { formatNumber, type ReceivablesData } from './evoApi';
import type { MonthlyAggregate } from './nocodbApi';
import { analyzeTrend, buildInsights, formatMonthShort, type MonthPoint, type MetricMeta } from '../lib/trends';

// ─── Paleta restrita Gaviões ──────────────────────────────────────────────────
// 4 cores semânticas + escala de cinza. Decisão design: cada cor tem 1 função,
// nunca rosa pra "info" ou âmbar pra "neutro" — evita ruído visual.
//   PRIMARY  = brand / totais / headers      ROSE    = inadimplência / evasão / risco
//   ACCENT   = lime de destaque sutil        AMBER   = warning / atraso / atenção
//   EMERALD  = saúde / em dia / sucesso      Grays   = body/labels/divisores
const PRIMARY    = [15, 60, 35]    as const; // #141414 verde escuro
const ACCENT     = [177, 209, 53]  as const; // #fc3000 lime
const TEXT_DARK  = [15, 23, 42]    as const; // #0F172A
const SLATE_700  = [51, 65, 85]    as const;
const SLATE_500  = [100, 116, 139] as const; // labels mais legíveis que GRAY puro
const GRAY       = [148, 163, 184] as const;
const GRAY_LIGHT = [226, 232, 240] as const;
const WHITE      = [255, 255, 255] as const;
const LIGHT_BG   = [248, 250, 251] as const;
const ROSE       = [244, 63, 94]   as const;
const AMBER      = [217, 119, 6]   as const;
const EMERALD    = [16, 185, 129]  as const;

type RGB = readonly [number, number, number];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setColor(doc: jsPDF, rgb: RGB) { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
function setFillColor(doc: jsPDF, rgb: RGB) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
function setDrawColor(doc: jsPDF, rgb: RGB) { doc.setDrawColor(rgb[0], rgb[1], rgb[2]); }

function drawRect(doc: jsPDF, x: number, y: number, w: number, h: number, rgb: RGB, radius = 0) {
  setFillColor(doc, rgb);
  if (radius > 0) doc.roundedRect(x, y, w, h, radius, radius, 'F');
  else            doc.rect(x, y, w, h, 'F');
}

// Valor monetário EXATO com centavos — usado em KPIs, tabelas e textos do relatório.
function fmtMoneyFull(v: number): string {
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// Alias: tudo que antes exibia "fmtMoney" (compacto/abreviado) agora mostra o valor exato.
const fmtMoney = fmtMoneyFull;

// Versão COMPACTA (abreviada) — reservada SÓ pros eixos dos gráficos, onde o valor
// cheio com centavos fica ilegível. Não usar em KPIs/tabelas/textos.
function fmtMoneyAxis(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `R$ ${(v / 1_000_000).toFixed(2).replace('.', ',')}M`;
  if (Math.abs(v) >= 10_000)    return `R$ ${(v / 1_000).toFixed(0)}k`;
  if (Math.abs(v) >= 1_000)     return `R$ ${(v / 1_000).toFixed(1).replace('.', ',')}k`;
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
}

// Porcentagem com 2 casas decimais (ex: 12.345 → "12,35%").
function fmtPct(n: number): string {
  return `${n.toFixed(2).replace('.', ',')}%`;
}

function getCurrentPeriod(): string {
  const d = new Date();
  return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

// ─── Header padrão (top bar + logo + título da página) ───────────────────────
function drawPageHeader(doc: jsPDF, sectionTitle: string, sectionSubtitle: string) {
  const pw = doc.internal.pageSize.getWidth();
  // Top accent bars
  drawRect(doc, 0, 0, pw, 4, PRIMARY);
  drawRect(doc, pw * 0.65, 0, pw * 0.35, 4, ACCENT);

  // Header section title
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  setColor(doc, PRIMARY);
  doc.text(sectionTitle, 20, 20);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  setColor(doc, GRAY);
  doc.text(sectionSubtitle, 20, 26);

  // Linha separadora
  setDrawColor(doc, GRAY_LIGHT);
  doc.setLineWidth(0.3);
  doc.line(20, 30, pw - 20, 30);
}

// ─── Footer (rodapé com logo, contador, data) ────────────────────────────────
function drawFooter(doc: jsPDF, pageNum: number, totalPages: number, dateStr: string) {
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  setDrawColor(doc, GRAY_LIGHT);
  doc.setLineWidth(0.3);
  doc.line(20, ph - 18, pw - 20, ph - 18);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  setColor(doc, GRAY);
  doc.text(`Gaviões 24h Dashboard · Relatório gerado em ${dateStr}`, 20, ph - 12);
  doc.text(`Página ${pageNum} de ${totalPages}`, pw - 20, ph - 12, { align: 'right' });
}

// ─── KPI box clean (sem ícone fake nem faixa colorida que brigam visualmente) ─
// Padrão: card branco, hairline cinza-claro, label uppercase pequeno em slate,
// valor GRANDE na cor de status. Mantém 1 cor por card (só o número),
// nunca 2-3 elementos coloridos competindo.
// Param `subtle` opcional: label menor, valor menor — pra grid 4-col denso.
function kpiBox(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  label: string, value: string,
  accentColor: RGB,
  subtle = false,
) {
  // Card base
  drawRect(doc, x, y, w, h, WHITE, 2);
  setDrawColor(doc, GRAY_LIGHT);
  doc.setLineWidth(0.3);
  doc.roundedRect(x, y, w, h, 2, 2, 'S');

  // Label (uppercase tracked) — slate-500 pra ter contraste sem competir
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(subtle ? 6.5 : 7);
  setColor(doc, SLATE_500);
  doc.text(label.toUpperCase(), x + 5, y + (subtle ? 8 : 9));

  // Valor GRANDE — única coisa colorida no card. Auto-ajuste de fonte: com
  // valores exatos (R$ x.xxx.xxx,xx) o texto pode ser largo, então reduzimos
  // o corpo até caber na largura do box (piso de 7pt pra continuar legível).
  doc.setFont('helvetica', 'bold');
  let vfs = subtle ? 14 : 17;
  doc.setFontSize(vfs);
  const maxValW = w - 8;
  while (doc.getTextWidth(value) > maxValW && vfs > 7) { vfs -= 0.5; doc.setFontSize(vfs); }
  setColor(doc, accentColor);
  doc.text(value, x + 5, y + h - 5);
}

// ─── Fileira de KPI boxes distribuída uniformemente (margens 20mm, gap 5mm) ───
// Aceita lista dinâmica → quando um box é omitido (ex: Faturamento Estimado
// desligado pro usuário), o grid reflowa sozinho sem buracos.
function kpiRow(
  doc: jsPDF,
  y: number, h: number, pw: number,
  boxes: { label: string; value: string; color: RGB }[],
) {
  const n = Math.max(boxes.length, 1);
  const w = (pw - 40 - (n - 1) * 5) / n;
  boxes.forEach((b, i) => kpiBox(doc, 20 + (w + 5) * i, y, w, h, b.label, b.value, b.color));
}

// ─── Section heading (eyebrow tag + title pair, igual padrão do dashboard web) ─
// Eyebrow microscópico uppercase tracked → respiro → title bold maior.
// Retorna y depois do bloco pra encadear seções com rítmica consistente.
function sectionHeading(doc: jsPDF, x: number, y: number, eyebrow: string, title: string): number {
  // Eyebrow tag — 6.5pt uppercase, tracked, slate
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  setColor(doc, SLATE_500);
  // Simula tracking via espaços extras (jsPDF não tem letterSpacing nativo)
  doc.text(eyebrow.toUpperCase().split('').join(' '), x, y);

  // Title — 11pt bold primary
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  setColor(doc, PRIMARY);
  doc.text(title, x, y + 6);

  return y + 12; // y depois do heading (caller decide o gap pro próximo bloco)
}

// ─── Tabela ──────────────────────────────────────────────────────────────────
type TableCol = { header: string; width: number; align?: 'left' | 'right' | 'center' };
function drawTable(
  doc: jsPDF,
  startY: number,
  cols: TableCol[],
  rows: string[][],
  startX = 20,
): number {
  const rowH = 8;
  const totalW = cols.reduce((a, c) => a + c.width, 0);
  let y = startY;

  // Cabeçalho
  drawRect(doc, startX, y, totalW, rowH + 2, PRIMARY, 1);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  setColor(doc, WHITE);
  let cx = startX;
  for (const col of cols) {
    const align = col.align ?? 'left';
    const tx = align === 'right' ? cx + col.width - 4 : align === 'center' ? cx + col.width / 2 : cx + 4;
    doc.text(col.header, tx, y + 7, { align });
    cx += col.width;
  }
  y += rowH + 2;

  // Linhas
  doc.setFont('helvetica', 'normal');
  for (let r = 0; r < rows.length; r++) {
    if (r % 2 === 0) drawRect(doc, startX, y, totalW, rowH, LIGHT_BG, 0);

    doc.setFontSize(7.5);
    setColor(doc, TEXT_DARK);
    cx = startX;
    for (let i = 0; i < rows[r].length; i++) {
      const col = cols[i];
      const align = col.align ?? 'left';
      const tx = align === 'right' ? cx + col.width - 4 : align === 'center' ? cx + col.width / 2 : cx + 4;
      doc.text(rows[r][i], tx, y + 5.5, { align });
      cx += col.width;
    }
    y += rowH;

    if (y > doc.internal.pageSize.getHeight() - 30) {
      doc.addPage();
      y = 35;
    }
  }
  return y;
}

// ─── Gráficos vetoriais nativos (nítidos, sem rasterização) ──────────────────

/** Clareia uma cor em direção ao branco (t=0 mantém, t=1 vira branco). */
function lighten(rgb: RGB, t: number): RGB {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * t),
    Math.round(rgb[1] + (255 - rgb[1]) * t),
    Math.round(rgb[2] + (255 - rgb[2]) * t),
  ];
}

interface ChartOpts {
  fmt: (n: number) => string;
  trendline?: number[];
  projection?: number | null;
  projConfident?: boolean;
  bestIdx?: number | null;
  worstIdx?: number | null;
}

/**
 * Gráfico de linha+área dentro do retângulo (x,y,w,h). Desenha:
 *   grade horizontal + rótulos do eixo Y (min/meio/máx),
 *   área preenchida suave, linha do valor real, pontos,
 *   linha de tendência tracejada, segmento projetado tracejado + ponto vazado,
 *   marcadores de pico (emerald) e vale (rose), rótulos do eixo X.
 *
 * `labels` são os rótulos do eixo X (mesmo length de `values`); a projeção
 * vira uma coluna extra à direita rotulada "~próx".
 */
function drawLineAreaChart(
  doc: jsPDF,
  x: number, y: number, w: number, h: number,
  values: number[], labels: string[], color: RGB,
  opts: ChartOpts,
) {
  const n = values.length;
  if (n < 2) return;
  const hasProj = opts.projection != null;
  const gutterL = 16;          // espaço pros rótulos do eixo Y
  const padBottom = 7;         // espaço pros rótulos do eixo X
  const plotX = x + gutterL;
  const plotY = y;
  const plotW = w - gutterL;
  const plotH = h - padBottom;
  const cols = n + (hasProj ? 1 : 0);

  // Domínio Y: inclui valores, tendência e projeção; margem de 8%.
  const pool = [...values];
  if (opts.trendline) pool.push(...opts.trendline);
  if (hasProj) pool.push(opts.projection as number);
  let minV = Math.min(...pool);
  let maxV = Math.max(...pool);
  if (minV === maxV) { maxV = minV + 1; minV = Math.max(0, minV - 1); }
  const span = maxV - minV;
  minV = Math.max(0, minV - span * 0.08);
  maxV = maxV + span * 0.08;

  const xAt = (i: number) => plotX + (cols === 1 ? 0 : (i / (cols - 1)) * plotW);
  const yAt = (v: number) => plotY + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // Grade + rótulos Y (3 linhas)
  doc.setLineWidth(0.2);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  for (let g = 0; g <= 2; g++) {
    const v = minV + (span === 0 ? 0 : ((maxV - minV) * g) / 2);
    const gy = yAt(v);
    setDrawColor(doc, GRAY_LIGHT);
    doc.line(plotX, gy, plotX + plotW, gy);
    setColor(doc, GRAY);
    doc.text(opts.fmt(v), x + gutterL - 2, gy + 1.5, { align: 'right' });
  }

  // Área preenchida (polígono suave via doc.lines com fill)
  const tint = lighten(color, 0.82);
  const baseY = plotY + plotH;
  const deltas: [number, number][] = [];
  const x0 = xAt(0), y0 = yAt(values[0]);
  deltas.push([x0 - plotX, y0 - baseY]); // sobe do canto inferior-esq ao 1º ponto
  for (let i = 1; i < n; i++) deltas.push([xAt(i) - xAt(i - 1), yAt(values[i]) - yAt(values[i - 1])]);
  deltas.push([0, baseY - yAt(values[n - 1])]); // desce ao eixo
  setFillColor(doc, tint);
  doc.lines(deltas, plotX, baseY, [1, 1], 'F', true);

  // Linha do valor real
  setDrawColor(doc, color);
  doc.setLineWidth(0.8);
  for (let i = 1; i < n; i++) doc.line(xAt(i - 1), yAt(values[i - 1]), xAt(i), yAt(values[i]));

  // Linha de tendência (tracejada, fina)
  if (opts.trendline && opts.trendline.length === n) {
    doc.setLineDashPattern([1.4, 1.2], 0);
    doc.setLineWidth(0.5);
    setDrawColor(doc, lighten(color, 0.35));
    doc.line(xAt(0), yAt(opts.trendline[0]), xAt(n - 1), yAt(opts.trendline[n - 1]));
    doc.setLineDashPattern([], 0);
  }

  // Pontos do valor real
  setFillColor(doc, color);
  for (let i = 0; i < n; i++) doc.circle(xAt(i), yAt(values[i]), 0.8, 'F');

  // Marcadores pico / vale
  if (opts.bestIdx != null && opts.bestIdx >= 0) {
    setFillColor(doc, EMERALD);
    doc.circle(xAt(opts.bestIdx), yAt(values[opts.bestIdx]), 1.4, 'F');
  }
  if (opts.worstIdx != null && opts.worstIdx >= 0 && opts.worstIdx !== opts.bestIdx) {
    setFillColor(doc, ROSE);
    doc.circle(xAt(opts.worstIdx), yAt(values[opts.worstIdx]), 1.4, 'F');
  }

  // Segmento projetado (tracejado) + ponto vazado
  if (hasProj) {
    const pv = opts.projection as number;
    doc.setLineDashPattern([1, 1.2], 0);
    doc.setLineWidth(0.8);
    setDrawColor(doc, color);
    doc.line(xAt(n - 1), yAt(values[n - 1]), xAt(n), yAt(pv));
    doc.setLineDashPattern([], 0);
    setFillColor(doc, WHITE);
    setDrawColor(doc, color);
    doc.setLineWidth(0.6);
    doc.circle(xAt(n), yAt(pv), 1.4, 'FD');
  }

  // Rótulos do eixo X — subset pra não amontoar (≈6 marcas)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  setColor(doc, GRAY);
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    doc.text(labels[i], xAt(i), baseY + 4.5, { align: 'center' });
  }
  if (hasProj) {
    setColor(doc, lighten(color, 0.2));
    doc.text('~próx', xAt(n), baseY + 4.5, { align: 'center' });
  }
}

/** Ranking horizontal de barras (já ordenado pelo caller, maior primeiro). */
function drawHBarRanking(
  doc: jsPDF,
  x: number, y: number, w: number,
  items: { label: string; value: number }[],
  color: RGB,
  fmt: (n: number) => string,
): number {
  if (items.length === 0) return y;
  const max = Math.max(...items.map(i => i.value), 1);
  const rowH = 7;
  const labelW = 34;
  const valueW = 22;
  const barX = x + labelW;
  const barMaxW = w - labelW - valueW;
  let cy = y;
  doc.setFontSize(7);
  for (const it of items) {
    // Rótulo (unidade)
    doc.setFont('helvetica', 'normal');
    setColor(doc, SLATE_700);
    doc.text(it.label.length > 18 ? it.label.slice(0, 17) + '…' : it.label, x, cy + rowH / 2 + 1.5);
    // Trilho + barra
    const bw = Math.max(1.5, (it.value / max) * barMaxW);
    drawRect(doc, barX, cy + 1.5, barMaxW, rowH - 3, GRAY_LIGHT, 1);
    drawRect(doc, barX, cy + 1.5, bw, rowH - 3, color, 1);
    // Valor
    doc.setFont('helvetica', 'bold');
    setColor(doc, TEXT_DARK);
    doc.text(fmt(it.value), x + w, cy + rowH / 2 + 1.5, { align: 'right' });
    cy += rowH;
  }
  return cy;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export async function generateReport(
  data: DashboardData,
  receivables?: ReceivablesData | null,
  options?: { hideFatEstimado?: boolean; history?: MonthlyAggregate[] },
): Promise<void> {
  const hideFat = options?.hideFatEstimado ?? false;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = doc.internal.pageSize.getWidth(); // 210
  const now = new Date();
  const dateStr  = now.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const dateLong = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const period   = getCurrentPeriod();

  // ─── Cálculos de dados REAIS (não usa mais ticket fictício) ──────────────
  const totalAtivos        = data.totalActiveMembers ?? 0;
  const totalAdimplentes   = data.totalAdimplentesMembers ?? data.units.reduce((s, u) => s + (u.adimplentesMembers ?? 0), 0);
  const totalInadimplentes = data.totalInadimplentesMembers ?? data.units.reduce((s, u) => s + (u.inadimplentesMembers ?? 0), 0);
  const totalCancelamentos = data.totalCancelamentosMes ?? data.units.reduce((s, u) => s + (u.cancelamentosMes ?? 0), 0);
  const totalFatEstimado   = data.totalFaturamentoAdimplentes ?? data.units.reduce((s, u) => s + (u.faturamentoAdimplentes ?? 0), 0);
  const totalRiscoReceita  = data.units.reduce((s, u) => s + (u.faturamentoInadimplentes ?? 0), 0);
  const totalVendasValor   = data.totalVendasMesValor ?? 0;
  const totalVendasQtd     = data.totalVendasMesQtd ?? 0;
  const ticketAdimp        = totalAdimplentes > 0 ? totalFatEstimado / totalAdimplentes : 0;
  const fatRealMes         = receivables?.totalAmount ?? 0;

  // % Já Pagaram (cruzamento member×receivable)
  const idsAtivos = new Set<number>([
    ...data.units.flatMap(u => u.idsAdimplentes ?? []),
    ...data.units.flatMap(u => u.idsInadimplentes ?? []),
  ]);
  const idsLancados = new Set<number>(receivables?.idsLancados ?? []);
  let pagaram = 0;
  idsAtivos.forEach(id => { if (idsLancados.has(id)) pagaram++; });
  const pctPagos = idsAtivos.size > 0 ? (pagaram / idsAtivos.size) * 100 : 0;

  // Evasão real (cancelados do mês / ativos) — usa cancelamentosMes real da W12
  const evasaoPct = totalAtivos > 0 ? (totalCancelamentos / totalAtivos) * 100 : 0;
  // % Inadimplência (separada da Evasão — não confundir)
  const inadPct   = totalAtivos > 0 ? (totalInadimplentes / totalAtivos) * 100 : 0;

  // ─── Série temporal pra página de Evolução & Tendência ───────────────────
  // Histórico (meses fechados) + mês corrente ao vivo anexado no fim.
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const trendMonths: MonthlyAggregate[] = [...(options?.history ?? [])];
  if (!trendMonths.some(m => m.month === currentMonthKey)) {
    trendMonths.push({
      month: currentMonthKey,
      active_members: totalAtivos,
      adimplentes: totalAdimplentes,
      inadimplentes: totalInadimplentes,
      faturamento_adimplentes: totalFatEstimado,
      vendas_qtd: totalVendasQtd,
      vendas_valor: totalVendasValor,
    });
  }
  const showTrend = trendMonths.length >= 2;

  // ─── Numeração de páginas dinâmica (a pág. de tendência é condicional) ────
  const totalPages = (receivables ? 4 : 3) + (showTrend ? 1 : 0);
  let pageNum = 0;
  const footer = () => { pageNum++; drawFooter(doc, pageNum, totalPages, dateStr); };

  // ═════════════════════════════════════════════════════════════════════════
  // PÁGINA 1 — CAPA / VISÃO GERAL
  // ═════════════════════════════════════════════════════════════════════════

  // Top accent bars (faixa horizontal dividida primary→accent)
  drawRect(doc, 0, 0, pw, 3, PRIMARY);
  drawRect(doc, pw * 0.65, 0, pw * 0.35, 3, ACCENT);

  // Logo
  try { doc.addImage(GAVIOES_LOGO_BASE64, 'PNG', 20, 16, 24, 24); } catch { /* logo opcional */ }

  // Eyebrow tag (microscópico tracked) acima do título — padrão dashboard web
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  setColor(doc, SLATE_500);
  doc.text('R E L A T Ó R I O   G E R E N C I A L', 50, 22);

  // Título grande — agora 28pt, mais respiro
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  setColor(doc, PRIMARY);
  doc.text(period.charAt(0).toUpperCase() + period.slice(1), 50, 32);

  // Sub-info data/geração — slate em vez de gray puro pra contraste melhor
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  setColor(doc, SLATE_500);
  doc.text(`Gerado em ${dateLong} · ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, 50, 38);

  // Linha separadora — mais discreta
  setDrawColor(doc, GRAY_LIGHT);
  doc.setLineWidth(0.2);
  doc.line(20, 48, pw - 20, 48);

  // ── Helper inline pra section label compacto (single-line) ────────────────
  // Página 1 é densa → usa 1 linha (eyebrow só) em vez do sectionHeading
  // (que ocupa 12mm com eyebrow+title). Mantém o visual clean (uppercase tracked
  // slate) sem comer espaço vertical. SectionHeading fica reservado pra pgs 3/4.
  const compactLabel = (text: string, y: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    setColor(doc, SLATE_500);
    doc.text(text.toUpperCase().split('').join(' '), 20, y);
  };

  // ── Grid de KPIs: 4 cards × bw width × bh height — base de membros ───────
  const bw = (pw - 50) / 4; // 4 cards × gap-5mm
  const bh = 22;            // compacto: 22mm pra caber tudo + tabela em pg 1

  compactLabel('Base de Membros', 55);
  const kpiY = 58;
  kpiBox(doc, 20,                kpiY, bw, bh, 'Ativos',         formatNumber(totalAtivos),         PRIMARY);
  kpiBox(doc, 20 + (bw + 5) * 1, kpiY, bw, bh, 'Adimplentes',    formatNumber(totalAdimplentes),    EMERALD);
  kpiBox(doc, 20 + (bw + 5) * 2, kpiY, bw, bh, 'Inadimplência',  fmtPct(inadPct),                   ROSE);
  kpiBox(doc, 20 + (bw + 5) * 3, kpiY, bw, bh, 'Evasão Mês',     fmtPct(evasaoPct),                 ROSE);

  // Section: Financeiro do mês
  compactLabel('Financeiro do Mês', kpiY + bh + 5);
  let finY = kpiY + bh + 8;
  const fatEstimBox = { label: 'Faturam. Estim.', value: fmtMoney(totalFatEstimado), color: PRIMARY };
  if (receivables) {
    kpiRow(doc, finY, bh, pw, [
      { label: 'Faturam. Real', value: fmtMoney(fatRealMes), color: PRIMARY },
      ...(hideFat ? [] : [fatEstimBox]),
      { label: 'Receita Risco', value: fmtMoney(totalRiscoReceita), color: AMBER },
      { label: 'Já Pagaram', value: `${pagaram} (${fmtPct(pctPagos)})`,
        color: pctPagos >= 80 ? EMERALD : pctPagos >= 50 ? AMBER : ROSE },
    ]);
  } else {
    kpiRow(doc, finY, bh, pw, [
      ...(hideFat ? [] : [fatEstimBox]),
      { label: 'Receita Risco', value: fmtMoney(totalRiscoReceita), color: AMBER },
      { label: 'Vendas (R$)',   value: fmtMoney(totalVendasValor),  color: PRIMARY },
      { label: 'Vendas (Qtd)',  value: formatNumber(totalVendasQtd), color: PRIMARY },
    ]);
  }
  finY += bh;

  // Section: Matrículas novas (só se temos receivables — senão já mostrou acima)
  let vendasY = finY;
  if (receivables) {
    compactLabel('Matrículas Novas', finY + 5);
    vendasY = finY + 8;
    const vw = (pw - 45) / 2;
    kpiBox(doc, 20,            vendasY, vw, bh, 'Vendas (Qtd)',     formatNumber(totalVendasQtd),  PRIMARY);
    kpiBox(doc, 20 + vw + 5,   vendasY, vw, bh, 'Vendas (R$)',      fmtMoney(totalVendasValor),    PRIMARY);
    vendasY += bh;
  }

  // Caixa de resumo — barra horizontal escura com sumário
  const summaryY = vendasY + 6;
  drawRect(doc, 20, summaryY, pw - 40, 18, PRIMARY, 2);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.5);
  setColor(doc, ACCENT);
  doc.text('R E S U M O   O P E R A C I O N A L', pw / 2, summaryY + 7, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  setColor(doc, WHITE);
  doc.text(
    `${data.units.length} unidades · ${formatNumber(totalAtivos)} ativos · Ticket ${fmtMoneyFull(ticketAdimp)} · ${data.hasAnyError ? 'Atenção: erros detectados' : 'Todas operacionais'}`,
    pw / 2, summaryY + 13.5, { align: 'center' }
  );

  // Tabela rápida de unidades
  compactLabel('Unidades — Visão Rápida', summaryY + 27);
  const tableTitleY = summaryY + 30;

  const sortedByAtivos = [...data.units].sort((a, b) => b.activeMembers - a.activeMembers);
  const unitRows = sortedByAtivos.map(u => {
    const evasao = u.activeMembers > 0 ? ((u.cancelamentosMes ?? 0) / u.activeMembers) * 100 : 0;
    return [
      u.name,
      u.activeMembers.toLocaleString('pt-BR'),
      u.adimplentesMembers.toLocaleString('pt-BR'),
      u.inadimplentesMembers.toLocaleString('pt-BR'),
      fmtPct(evasao),
      u.hasError ? 'Erro' : 'OK',
    ];
  });

  drawTable(doc, tableTitleY + 4, [
    { header: 'Unidade',         width: 50, align: 'left' },
    { header: 'Ativos',          width: 25, align: 'right' },
    { header: 'Adimp.',          width: 25, align: 'right' },
    { header: 'Inadimp.',        width: 25, align: 'right' },
    { header: 'Evasão',          width: 25, align: 'right' },
    { header: 'Status',          width: 20, align: 'center' },
  ], unitRows);

  footer();

  // ═════════════════════════════════════════════════════════════════════════
  // PÁGINA 2 — EVOLUÇÃO & TENDÊNCIA (condicional: só com histórico ≥ 2 meses)
  // ═════════════════════════════════════════════════════════════════════════

  if (showTrend) {
    doc.addPage();
    drawPageHeader(doc, 'Evolução & Tendência', 'Série mensal da rede · tracejado = tendência · ponto vazado = projeção do próximo mês');

    const labels = trendMonths.map(m => formatMonthShort(m.month));
    const chartW = pw - 40;

    // Helper: renderiza um bloco (heading + gráfico) e devolve o y final.
    const renderChart = (
      startY: number, eyebrow: string, title: string,
      values: number[], color: RGB, meta: MetricMeta,
    ): number => {
      const points: MonthPoint[] = trendMonths.map((m, i) => ({ month: m.month, value: values[i] }));
      const a = analyzeTrend(points);
      const bestIdx = a.best ? points.findIndex(p => p.month === a.best!.month) : -1;
      const worstIdx = a.worst ? points.findIndex(p => p.month === a.worst!.month) : -1;
      const cy = sectionHeading(doc, 20, startY, eyebrow, title);
      drawLineAreaChart(doc, 20, cy + 2, chartW, 40, values, labels, color, {
        fmt: meta.fmt,
        trendline: a.trendline,
        projection: a.projection,
        projConfident: a.projConfident,
        bestIdx, worstIdx,
      });
      return cy + 2 + 40;
    };

    // Bloco de insights em 2 colunas (esquerda = membros, direita = financeiro).
    const renderInsights = (
      startY: number,
      leftTitle: string, leftPts: MonthPoint[], leftMeta: MetricMeta,
      rightTitle: string, rightPts: MonthPoint[], rightMeta: MetricMeta,
    ): number => {
      const colW = (chartW - 8) / 2;
      const cols: { x: number; title: string; ins: ReturnType<typeof buildInsights> }[] = [
        { x: 20, title: leftTitle, ins: buildInsights(leftPts, leftMeta).slice(0, 3) },
        { x: 20 + colW + 8, title: rightTitle, ins: buildInsights(rightPts, rightMeta).slice(0, 3) },
      ];
      let maxY = startY;
      for (const c of cols) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        setColor(doc, SLATE_500);
        doc.text(c.title.toUpperCase().split('').join(' '), c.x, startY);
        let by = startY + 6;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        for (const ins of c.ins) {
          const bullet: RGB = ins.tone === 'good' ? EMERALD : ins.tone === 'bad' ? ROSE : GRAY;
          setFillColor(doc, bullet);
          doc.circle(c.x + 1, by - 1, 1, 'F');
          setColor(doc, TEXT_DARK);
          const lines = doc.splitTextToSize(ins.text, colW - 6);
          doc.text(lines, c.x + 4, by);
          by += 4.5 + (lines.length - 1) * 3.5;
        }
        maxY = Math.max(maxY, by);
      }
      return maxY;
    };

    const ativosVals = trendMonths.map(m => m.active_members);
    const fatVals = trendMonths.map(m => m.faturamento_adimplentes);
    const ativosPts: MonthPoint[] = trendMonths.map(m => ({ month: m.month, value: m.active_members }));
    const fatPts: MonthPoint[] = trendMonths.map(m => ({ month: m.month, value: m.faturamento_adimplentes }));
    const fmtNumMeta: MetricMeta = { label: 'Ativos', fmt: formatNumber };
    const fmtMoneyMeta: MetricMeta = { label: 'Faturamento', fmt: fmtMoneyAxis };

    let ty = renderChart(40, 'Base de Membros', 'Membros Ativos na Rede', ativosVals, PRIMARY, fmtNumMeta);
    ty = renderChart(ty + 8, 'Financeiro', 'Faturamento Estimado', fatVals, EMERALD, fmtMoneyMeta);

    // Insights automáticos
    ty = sectionHeading(doc, 20, ty + 8, 'Leitura Automática', 'Crescimento, ritmo e projeção');
    ty = renderInsights(ty, 'Membros', ativosPts, fmtNumMeta, 'Faturamento', fatPts, fmtMoneyMeta) + 4;

    // Ranking de unidades por ativos (barras horizontais) — se couber na página.
    if (ty < 235) {
      ty = sectionHeading(doc, 20, ty + 4, 'Ranking de Unidades', 'Membros ativos por unidade (mês corrente)');
      const ranked = [...data.units]
        .sort((a, b) => b.activeMembers - a.activeMembers)
        .slice(0, 7)
        .map(u => ({ label: u.name, value: u.activeMembers }));
      drawHBarRanking(doc, 20, ty, chartW, ranked, PRIMARY, formatNumber);
    }

    footer();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PÁGINA 3 — DETALHAMENTO POR UNIDADE
  // ═════════════════════════════════════════════════════════════════════════

  doc.addPage();
  drawPageHeader(doc, 'Performance por Unidade', 'Detalhamento individual com membros, faturamento e vendas');

  let y = 38;
  for (const u of sortedByAtivos) {
    const cardH = 30;
    const unitCancel = u.cancelamentosMes ?? 0;
    const unitEvasao = u.activeMembers > 0 ? (unitCancel / u.activeMembers) * 100 : 0;

    // Card — fundo claro, hairline em vez de faixa colorida (mais clean)
    drawRect(doc, 20, y, pw - 40, cardH, LIGHT_BG, 2);
    setDrawColor(doc, GRAY_LIGHT);
    doc.setLineWidth(0.3);
    doc.roundedRect(20, y, pw - 40, cardH, 2, 2, 'S');

    // Nome + localização
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    setColor(doc, PRIMARY);
    doc.text(u.name, 26, y + 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setColor(doc, SLATE_500);
    doc.text(u.location, 26, y + 13);

    // Stats em 4 colunas — x positions COMPUTADAS via largura útil (não hardcoded)
    // Área de stats começa em x=78 (após nome+location), termina em pw-26
    const statsLeft  = 78;
    const statsRight = pw - 26;
    const statsW     = statsRight - statsLeft;
    const colW       = statsW / 4;
    const colsX      = [0, 1, 2, 3].map(i => statsLeft + i * colW);
    const labels = ['ATIVOS', 'ADIMP.', 'INADIMP.', 'EVASÃO'];
    const values = [
      formatNumber(u.activeMembers),
      formatNumber(u.adimplentesMembers),
      formatNumber(u.inadimplentesMembers),
      fmtPct(unitEvasao),
    ];
    // Cores semânticas: primary p/ ativos, emerald p/ adimp, rose p/ inad e evasão.
    const valColors: RGB[] = [PRIMARY, EMERALD, ROSE, ROSE];
    for (let i = 0; i < 4; i++) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      setColor(doc, SLATE_500);
      doc.text(labels[i], colsX[i], y + 8);
      doc.setFontSize(11);
      setColor(doc, valColors[i]);
      doc.text(values[i], colsX[i], y + 16);
    }

    // Linha 2 do card: faturamento + vendas (Evasão já aparece na coluna de stats acima).
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setColor(doc, SLATE_700);
    const fatReal = receivables?.perUnit.find(p => p.unitName === u.name)?.amount ?? 0;
    let line2 = hideFat ? '' : `Fat. Estim.: ${fmtMoneyFull(u.faturamentoAdimplentes ?? 0)}`;
    if (receivables) line2 += `${line2 ? '  ·  ' : ''}Fat. Real: ${fmtMoneyFull(fatReal)}`;
    line2 += `${line2 ? '  ·  ' : ''}Vendas: ${u.vendasMesQtd ?? 0} (${fmtMoneyFull(u.vendasMesValor ?? 0)})`;
    doc.text(line2, 26, y + 25);

    if (u.hasError) {
      setColor(doc, ROSE);
      doc.text(' ⚠ Falha na conexão', pw - 50, y + 25);
    }

    y += cardH + 4;

    if (y > 260) {
      doc.addPage();
      drawPageHeader(doc, 'Performance por Unidade (continuação)', '');
      y = 38;
    }
  }

  footer();

  // ═════════════════════════════════════════════════════════════════════════
  // PÁGINA 3 — ANÁLISE FINANCEIRA
  // ═════════════════════════════════════════════════════════════════════════

  doc.addPage();
  const pg3Subtitle = receivables
    ? (hideFat ? `Faturamento real (receivable) — ${period}` : `Faturamento estimado (member) e real (receivable) — ${period}`)
    : (hideFat ? `Base de membros e vendas — ${period}` : `Faturamento estimado (member) — ${period}`);
  drawPageHeader(doc, 'Análise Financeira', pg3Subtitle);

  // KPIs financeiros — paleta restrita (sem INDIGO)
  let finKpiY = 38;
  if (receivables) {
    kpiRow(doc, finKpiY, 24, pw, [
      { label: 'Faturam. Real', value: fmtMoney(fatRealMes), color: PRIMARY },
      ...(hideFat ? [] : [{ label: 'Faturam. Estim.', value: fmtMoney(totalFatEstimado), color: PRIMARY }]),
      { label: 'Multa Cancel.', value: fmtMoney(receivables.totalMultaCancelamento), color: ROSE },
      { label: 'Avulso',        value: fmtMoney(receivables.totalAvulso), color: PRIMARY },
    ]);
    finKpiY += 30;
  }
  kpiRow(doc, finKpiY, 24, pw, [
    { label: 'Receita Risco', value: fmtMoney(totalRiscoReceita), color: AMBER },
    { label: 'Ticket Médio',  value: fmtMoneyFull(ticketAdimp), color: PRIMARY },
    { label: 'Vendas (R$)',   value: fmtMoney(totalVendasValor),  color: EMERALD },
    { label: 'Vendas (Qtd)',  value: formatNumber(totalVendasQtd), color: EMERALD },
  ]);

  // Tabela: Faturamento por unidade
  const fatTitleY = sectionHeading(doc, 20, finKpiY + 32,
    receivables ? 'Faturamento por Unidade' : (hideFat ? 'Base por Unidade' : 'Faturamento Estimado'),
    receivables ? 'Receivable W12 — mês corrente' : (hideFat ? 'Membros ativos e adimplentes por unidade' : 'Soma ValorContrato dos adimplentes'),
  );

  if (receivables) {
    const fatRows = receivables.perUnit.map(pu => {
      const u = data.units.find(x => x.name === pu.unitName);
      const idsAtivosUnit = new Set<number>([...(u?.idsAdimplentes ?? []), ...(u?.idsInadimplentes ?? [])]);
      const idsLancUnit   = new Set<number>(receivables.idsLancadosPorUnidade?.[pu.unitName] ?? []);
      let pag = 0;
      idsAtivosUnit.forEach(id => { if (idsLancUnit.has(id)) pag++; });
      const pct = idsAtivosUnit.size > 0 ? (pag / idsAtivosUnit.size) * 100 : 0;
      return [
        pu.unitName,
        formatNumber(u?.activeMembers ?? 0),
        fmtMoneyFull(pu.amount),
        String(pu.rows),
        `${pag}/${idsAtivosUnit.size}`,
        fmtPct(pct),
      ];
    });
    // Total
    fatRows.push([
      'TOTAL',
      formatNumber(totalAtivos),
      fmtMoneyFull(fatRealMes),
      String(receivables.total),
      `${pagaram}/${idsAtivos.size}`,
      fmtPct(pctPagos),
    ]);
    drawTable(doc, fatTitleY + 4, [
      { header: 'Unidade',     width: 45, align: 'left' },
      { header: 'Ativos',      width: 22, align: 'right' },
      { header: 'Faturamento', width: 35, align: 'right' },
      { header: 'Lançam.',     width: 22, align: 'right' },
      { header: 'Pagaram',     width: 25, align: 'right' },
      { header: '%',           width: 21, align: 'right' },
    ], fatRows);
  } else if (hideFat) {
    // Sem faturamento estimado: tabela vira base de membros por unidade.
    const baseRows = sortedByAtivos.map(u => [
      u.name,
      formatNumber(u.activeMembers),
      formatNumber(u.adimplentesMembers),
      formatNumber(u.inadimplentesMembers),
    ]);
    baseRows.push([ 'TOTAL', formatNumber(totalAtivos), formatNumber(totalAdimplentes), formatNumber(totalInadimplentes) ]);
    drawTable(doc, fatTitleY + 4, [
      { header: 'Unidade',  width: 60, align: 'left' },
      { header: 'Ativos',   width: 37, align: 'right' },
      { header: 'Adimp.',   width: 37, align: 'right' },
      { header: 'Inadimp.', width: 36, align: 'right' },
    ], baseRows);
  } else {
    const fatRows = sortedByAtivos.map(u => [
      u.name,
      formatNumber(u.activeMembers),
      formatNumber(u.adimplentesMembers),
      fmtMoneyFull(u.faturamentoAdimplentes ?? 0),
    ]);
    fatRows.push([ 'TOTAL', formatNumber(totalAtivos), formatNumber(totalAdimplentes), fmtMoneyFull(totalFatEstimado) ]);
    drawTable(doc, fatTitleY + 4, [
      { header: 'Unidade',          width: 60, align: 'left' },
      { header: 'Ativos',           width: 30, align: 'right' },
      { header: 'Adimp.',           width: 30, align: 'right' },
      { header: 'Faturam. Estim.',  width: 50, align: 'right' },
    ], fatRows);
  }

  footer();

  // ═════════════════════════════════════════════════════════════════════════
  // PÁGINA 4 — RESUMO EXECUTIVO (só se tem receivables)
  // ═════════════════════════════════════════════════════════════════════════

  if (receivables) {
    doc.addPage();
    drawPageHeader(doc, 'Resumo Executivo', 'Principais indicadores e observações estratégicas');

    let yy = 40;

    // Big hero card — número do faturamento em destaque máximo
    drawRect(doc, 20, yy, pw - 40, 56, PRIMARY, 3);

    // Eyebrow tag dentro do hero — accent lime, tracked
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    setColor(doc, ACCENT);
    doc.text(`R E D E   G O O D B E   ·   ${period.toUpperCase()}`, pw / 2, yy + 11, { align: 'center' });

    // Faturamento real — número HERO 32pt
    doc.setFontSize(32);
    setColor(doc, WHITE);
    doc.text(fmtMoneyFull(fatRealMes), pw / 2, yy + 27, { align: 'center' });

    // Descrição do número
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    setColor(doc, GRAY_LIGHT);
    doc.text('Faturamento Real do Mês · Planilha de Recebíveis W12', pw / 2, yy + 33, { align: 'center' });

    // Sub-stats — x positions COMPUTADAS via divisão pela largura útil
    // (não mais hardcoded 40/90/145/175 que estouravam em alguns casos).
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    setColor(doc, WHITE);
    const subY = yy + 46;
    const subStats = [
      `${formatNumber(totalAtivos)} ativos`,
      `${pagaram} pagaram (${fmtPct(pctPagos)})`,
      `${data.units.length} unidades`,
      `Ticket ${fmtMoneyFull(ticketAdimp)}`,
    ];
    const subUseW = pw - 60; // 30mm padding cada lado dentro do card
    const subColW = subUseW / subStats.length;
    subStats.forEach((s, i) => {
      doc.text(s, 30 + subColW * (i + 0.5), subY, { align: 'center' });
    });

    yy += 66;

    // Section: Pontos de Atenção
    yy = sectionHeading(doc, 20, yy, 'Pontos de Atenção', 'Indicadores fora do range saudável');
    yy += 2;

    const observacoes: { text: string; severity: 'high' | 'med' | 'low' }[] = [];
    const inadimplenciaPct = totalAtivos > 0 ? (totalInadimplentes / totalAtivos) * 100 : 0;
    const evasaoPctLocal   = totalAtivos > 0 ? (totalCancelamentos / totalAtivos) * 100 : 0;
    if (inadimplenciaPct >= 10) observacoes.push({ severity: 'high', text: `Inadimplência em ${fmtPct(inadimplenciaPct)} — acima do saudável (≤10%). Receita em risco: ${fmtMoneyFull(totalRiscoReceita)}` });
    if (evasaoPctLocal >= 5)    observacoes.push({ severity: 'high', text: `Evasão em ${fmtPct(evasaoPctLocal)} no mês (${formatNumber(totalCancelamentos)} cancelamentos) — acima do saudável (≤5%).` });
    if (pctPagos < 80 && idsAtivos.size > 0) observacoes.push({ severity: 'med', text: `Apenas ${fmtPct(pctPagos)} dos ativos têm lançamento no receivable do mês. Verifique cobrança.` });

    const worstEvasao = sortedByAtivos
      .map(u => ({ u, ev: u.activeMembers > 0 ? ((u.cancelamentosMes ?? 0) / u.activeMembers) * 100 : 0 }))
      .filter(x => x.ev > 5 && x.u.activeMembers > 50)
      .sort((a, b) => b.ev - a.ev);
    if (worstEvasao.length > 0) {
      const n = worstEvasao.slice(0, 3).map(x => `${x.u.name} (${fmtPct(x.ev)})`).join(', ');
      observacoes.push({ severity: 'med', text: `Unidades com evasão acima de 5%: ${n}` });
    }

    const semVendas = sortedByAtivos.filter(u => (u.vendasMesQtd ?? 0) === 0);
    if (semVendas.length > 0) observacoes.push({ severity: 'low', text: `${semVendas.length} unidade${semVendas.length > 1 ? 's' : ''} sem matrículas novas no mês: ${semVendas.map(u => u.name).join(', ')}` });

    if (observacoes.length === 0) observacoes.push({ severity: 'low', text: 'Indicadores saudáveis em todas as dimensões avaliadas neste relatório.' });

    // Cada observação: bullet colorido pela severidade + texto
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    for (const obs of observacoes) {
      const bulletColor: RGB = obs.severity === 'high' ? ROSE : obs.severity === 'med' ? AMBER : EMERALD;
      // Bullet dot circular (mais limpo que quadrado)
      setFillColor(doc, bulletColor);
      doc.circle(23, yy + 2.5, 1.2, 'F');
      setColor(doc, TEXT_DARK);
      const lines = doc.splitTextToSize(obs.text, pw - 52);
      doc.text(lines, 28, yy + 3);
      yy += 6 + (lines.length - 1) * 4;
    }

    yy += 8;

    // Disclaimer Fonte dos Dados — mais sutil (cinza claro em vez de âmbar berrante)
    drawRect(doc, 20, yy, pw - 40, 24, LIGHT_BG, 3);
    setDrawColor(doc, GRAY_LIGHT);
    doc.setLineWidth(0.3);
    doc.roundedRect(20, yy, pw - 40, 24, 3, 3, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    setColor(doc, SLATE_500);
    doc.text('F O N T E   D O S   D A D O S', 26, yy + 7);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setColor(doc, SLATE_700);
    doc.text('Member: /api/v1/members/summary-excel (StatusContrato + ValorContrato)', 26, yy + 13);
    doc.text('Receivable: /api/v1/receivables/summary-excel (mês corrente, todas unidades)', 26, yy + 18);
    doc.text('Cancelamentos: /api/v3/membermembership (cancelDateStart 1º do mês → hoje)', 26, yy + 22.5);

    footer();
  }

  // ─── Salvar ──────────────────────────────────────────────────────────────
  const filename = `gavioes_relatorio_${now.toISOString().split('T')[0]}.pdf`;
  doc.save(filename);
}
