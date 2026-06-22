// PDF do Relatório de LEADS — gerado pela aba Leads do dashboard.
// Mesmo padrão visual do pdfReport do Painel (A4 portrait, paleta Gaviões).
// Conteúdo: total de leads, leads por TIME, campanhas, status e conversão
// em alunos (atribuída ao mês da matrícula) — pronto pra apresentar.

import { jsPDF } from 'jspdf';
import { GAVIOES_LOGO_BASE64 } from './logoBase64';
import { monthLabelBR } from '../lib/date';

const PRIMARY: RGB = [15, 60, 35];
const ACCENT: RGB  = [177, 209, 53];
const INK: RGB     = [15, 23, 42];
const SLATE: RGB   = [100, 116, 139];
const LIGHT: RGB   = [248, 250, 251];
const BORDER: RGB  = [226, 232, 240];
const AMBER: RGB   = [217, 119, 6];
const EMERALD: RGB = [16, 185, 129];
const SKY: RGB     = [3, 105, 161];
const WHITE: RGB   = [255, 255, 255];

type RGB = readonly [number, number, number];
const tc = (d: jsPDF, c: RGB) => d.setTextColor(c[0], c[1], c[2]);
const fc = (d: jsPDF, c: RGB) => d.setFillColor(c[0], c[1], c[2]);
const dc = (d: jsPDF, c: RGB) => d.setDrawColor(c[0], c[1], c[2]);
const rect = (d: jsPDF, x: number, y: number, w: number, h: number, c: RGB, r = 0) => {
  fc(d, c);
  if (r > 0) d.roundedRect(x, y, w, h, r, r, 'F'); else d.rect(x, y, w, h, 'F');
};

export interface LeadsPdfInput {
  month: string;                         // 'YYYY-MM'
  geradoPor?: string;
  totals: { conversas: number; leadsAnuncio: number };
  /** Conversão removida da tela — campos opcionais mantidos por compat. */
  viraramNoMes?: number;
  jaEram?: number;
  porTime: { nome: string; n: number }[];        // leads de anúncio por time
  porCampanha: { nome: string; n: number }[];
  porStatus: { nome: string; n: number; cor: 'verde' | 'ambar' | 'azul' | 'cinza' }[];
  porMes?: { month: string; leadsAnuncio: number; conversas: number; viraram: number; taxa: number }[];
  truncated: boolean;
  amostra: number;                       // leads etiquetados na lista
}

const STATUS_COLOR: Record<string, RGB> = { verde: EMERALD, ambar: AMBER, azul: SKY, cinza: SLATE };

export function generateLeadsReport(input: LeadsPdfInput): void {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 14, CW = W - M * 2;
  let y = 0;

  // ── Cabeçalho ───────────────────────────────────────────────────────────
  rect(doc, 0, 0, W, 34, PRIMARY);
  try { doc.addImage(GAVIOES_LOGO_BASE64, 'PNG', M, 8, 18, 18); } catch { /* sem logo */ }
  tc(doc, WHITE);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(17);
  doc.text('Relatório de Leads — Anúncios Digitais', M + 22, 16);
  tc(doc, ACCENT);
  doc.setFontSize(10.5);
  doc.text(`${monthLabelBR(input.month)} · Fluxo (WhatsApp/Instagram) × EVO`, M + 22, 23);
  tc(doc, [124, 152, 133]);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
  doc.text(`Gerado em ${new Date().toLocaleString('pt-BR')}${input.geradoPor ? ` por ${input.geradoPor}` : ''}`, M + 22, 28.5);
  y = 42;

  // ── KPIs ────────────────────────────────────────────────────────────────
  const pctAnuncio = input.totals.conversas > 0 ? (input.totals.leadsAnuncio / input.totals.conversas) * 100 : 0;
  const kpis: { v: string; l: string; c: RGB }[] = [
    { v: String(input.totals.leadsAnuncio), l: 'Leads de anúncio', c: PRIMARY },
    { v: String(input.totals.conversas || '—'), l: 'Conversas novas', c: SKY },
    { v: `${pctAnuncio.toFixed(1).replace('.', ',')}%`, l: '% via anúncio', c: EMERALD },
  ];
  const kw = (CW - 2 * 4) / 3;
  kpis.forEach((k, i) => {
    const x = M + i * (kw + 4);
    rect(doc, x, y, kw, 24, LIGHT, 2);
    dc(doc, BORDER); doc.setLineWidth(0.3); doc.roundedRect(x, y, kw, 24, 2, 2, 'S');
    tc(doc, k.c); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(k.v, x + 3, y + 10);
    tc(doc, SLATE); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8);
    doc.text(doc.splitTextToSize(k.l, kw - 6) as string[], x + 3, y + 15.5);
  });
  y += 32;

  const section = (titulo: string) => {
    tc(doc, PRIMARY); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
    doc.text(titulo.toUpperCase(), M, y);
    y += 5.5;
  };

  // ── Leads por TIME (barras) ─────────────────────────────────────────────
  section(`Leads por time · total de ${input.amostra} na lista`);
  const maxT = Math.max(1, ...input.porTime.map(t => t.n));
  const bx = M + 52, bw = CW - 52 - 18;
  input.porTime.forEach(t => {
    const semTime = /sem time/i.test(t.nome);
    tc(doc, semTime ? AMBER : INK);
    doc.setFont('helvetica', semTime ? 'bold' : 'normal'); doc.setFontSize(8.5);
    doc.text(t.nome, M + 50, y + 3.4, { align: 'right' });
    rect(doc, bx, y, Math.max((t.n / maxT) * bw, 1.2), 4.6, semTime ? AMBER : PRIMARY, 1);
    tc(doc, INK); doc.setFont('helvetica', 'bold');
    doc.text(`${t.n} · ${(t.n / Math.max(input.amostra, 1) * 100).toFixed(0)}%`, bx + Math.max((t.n / maxT) * bw, 1.2) + 2, y + 3.4);
    y += 6.6;
  });
  y += 6;

  // ── Campanhas e Status lado a lado ──────────────────────────────────────
  const yCols = y;
  section('Por campanha (etiqueta)');
  const half = CW / 2 - 4;
  const maxC = Math.max(1, ...input.porCampanha.map(c => c.n));
  input.porCampanha.slice(0, 6).forEach(c => {
    tc(doc, /gen[ée]rica/i.test(c.nome) ? AMBER : INK);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(c.nome, M + 36, y + 3.2, { align: 'right' });
    rect(doc, M + 38, y, Math.max((c.n / maxC) * (half - 52), 1.2), 4.2, SKY, 1);
    tc(doc, INK); doc.setFont('helvetica', 'bold');
    doc.text(String(c.n), M + 38 + Math.max((c.n / maxC) * (half - 52), 1.2) + 2, y + 3.2);
    y += 6;
  });
  // Status (coluna direita)
  let ys = yCols;
  const xs = M + CW / 2 + 8;
  tc(doc, PRIMARY); doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5);
  doc.text('STATUS DOS LEADS', xs, ys); ys += 5.5;
  input.porStatus.forEach(st => {
    rect(doc, xs, ys + 0.6, 3, 3, STATUS_COLOR[st.cor] ?? SLATE, 1);
    tc(doc, INK); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
    doc.text(st.nome, xs + 5, ys + 3.2);
    tc(doc, STATUS_COLOR[st.cor] ?? SLATE); doc.setFont('helvetica', 'bold');
    doc.text(`${st.n} · ${(st.n / Math.max(input.amostra, 1) * 100).toFixed(1).replace('.', ',')}%`, M + CW, ys + 3.2, { align: 'right' });
    ys += 6;
  });
  y = Math.max(y, ys) + 7;

  // ── Conversão por mês (só se fornecida — removida da tela) ──────────────
  if ((input.porMes ?? []).length > 1) {
    section('Conversão por mês · matrícula creditada no mês em que aconteceu');
    rect(doc, M, y, CW, 7, PRIMARY, 1);
    tc(doc, WHITE); doc.setFont('helvetica', 'bold'); doc.setFontSize(7.8);
    const cols = [M + 3, M + 44, M + 86, M + 126, M + CW - 3];
    doc.text('MÊS', cols[0], y + 4.7);
    doc.text('CONVERSAS', cols[1], y + 4.7);
    doc.text('LEADS ANÚNCIO', cols[2], y + 4.7);
    doc.text('VIRARAM ALUNOS', cols[3], y + 4.7);
    doc.text('TAXA', cols[4], y + 4.7, { align: 'right' });
    y += 7;
    (input.porMes ?? []).forEach((m, i) => {
      if (i % 2 === 1) rect(doc, M, y, CW, 6.4, LIGHT);
      tc(doc, INK); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2);
      doc.text(monthLabelBR(m.month), cols[0], y + 4.3);
      doc.setFont('helvetica', 'normal');
      doc.text(m.conversas ? String(m.conversas) : '—', cols[1], y + 4.3);
      doc.text(String(m.leadsAnuncio), cols[2], y + 4.3);
      tc(doc, EMERALD); doc.setFont('helvetica', 'bold');
      doc.text(String(m.viraram), cols[3], y + 4.3);
      tc(doc, INK);
      doc.text(`${m.taxa.toFixed(1).replace('.', ',')}%`, cols[4], y + 4.3, { align: 'right' });
      y += 6.4;
    });
    y += 6;
  }

  // ── Notas ───────────────────────────────────────────────────────────────
  tc(doc, SLATE); doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8);
  const notas = [
    `Lead = conversa criada no mês com etiqueta anuncio/anuncio-* no Fluxo.`,
    input.truncated ? 'Lista do período amostrada (cap de 2.000 por envio do Fluxo) — totais oficiais completos; a acumulação diária completa o detalhe.' : '',
    input.jaEram !== undefined ? `${input.jaEram} contatos do período já eram alunos antes do lead.` : '',
  ].filter(Boolean);
  doc.text(doc.splitTextToSize(notas.join(' '), CW) as string[], M, Math.min(y + 2, 285));

  doc.save(`relatorio-leads-${input.month}.pdf`);
}
