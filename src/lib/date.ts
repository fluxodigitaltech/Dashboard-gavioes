/**
 * Data local no formato YYYY-MM-DD, SEM conversão pra UTC.
 *
 * `Date.prototype.toISOString()` converte pra UTC — em São Paulo (UTC-3), das
 * ~21h à meia-noite isso "empurra" a data pro dia seguinte, fazendo o dashboard
 * buscar o dia errado no EVO. Use SEMPRE este helper pra datas de calendário.
 */
export function localYMD(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM' do mês corrente (fuso local). */
export function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Rótulo pt-BR capitalizado: '2026-06' → 'Junho de 2026'. */
export function monthLabelBR(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
