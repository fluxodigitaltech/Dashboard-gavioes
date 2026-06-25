// NocoDB Integration Service
// Base: https://outros-sistemas-nocodb.r3k7br.easypanel.host | Project: pq2izu4dn5chv9s
// (login/usuários ficam neste NocoDB self-hosted — separado da fonte de dados,
//  que vem do scraper EVO. Migrado do app.nocodb.com em jun/2026.)

import { localYMD } from '../lib/date';

const NOCO_BASE = 'https://outros-sistemas-nocodb.r3k7br.easypanel.host/api/v2';
// SECURITY NOTE: VITE_* values are bundled into the public JS — readable by any user via DevTools.
// This is a stopgap until the backend proxy is implemented. Token must be rotated after public exposure.
// ⚠️ Fallback hardcoded: o Easypanel NÃO propaga env vars como build args do Docker
// (mesmo problema do VITE_DATA_SOURCE no commit a83fc48), então VITE_NOCODB_TOKEN
// chega vazio no build e o login dá 401. Como o token já é público no bundle por
// design, embutir o default aqui garante o build. ROTACIONAR e atualizar este valor.
const NOCO_TOKEN = import.meta.env.VITE_NOCODB_TOKEN || 'gV3tJ7cm7o_wep9gLmQFe1c2SjhMeDfNok_4IFfK';

const TABLES = {
  users:       'm5gvxov7n0eah6o',
  evoSnapshot: 'mz3j6q155ow62wg',
  kpis:        'm0e4fmdvti599he',
  relatorios:  'mz64de7m3jrw9k3',
  financeiro:  'md8nl1tu1gyvhzd',
  // TODO: criar tabela 'gb_role_templates' no NocoDB com colunas: name (text), description (text),
  //       cell_permissions (long text), is_default (bool). Colar o table ID abaixo.
  //       Enquanto vazio, o sistema usa localStorage como fallback (funciona local-only).
  roleTemplates: '',
  // ─── Histórico mensal EVO (cache compartilhado entre todos usuários) ─────
  // PRECISA criar a tabela no NocoDB com este schema EXATO (nomes case-sensitive):
  //
  //   branch_name             SingleLineText
  //   snapshot_month          SingleLineText  // formato YYYY-MM (ex: '2025-04')
  //   period_kind             SingleSelect    // 'monthly' (snapshot mensal) | 'yearly' (anual)
  //   active_members          Number
  //   adimplentes             Number
  //   inadimplentes           Number
  //   faturamento_adimplentes Decimal
  //   vendas_qtd              Number
  //   vendas_valor            Decimal
  //   source                  SingleSelect    // 'evo_excel' | 'evo_sales' | 'manual'
  //   fetched_at              DateTime
  //
  // E criar UNIQUE index lógico em (branch_name, snapshot_month) — NocoDB não
  // tem unique nativo então o app faz upsert manual via fetch+patch/post.
  //
  // Cole o table ID abaixo. Enquanto vazio, o módulo de seed/leitura é
  // desabilitado mas o resto do dashboard funciona normal (usa cache localStorage).
  evoHistory: 'm8977z0p0caclq6',
  // Histórico mensal de receivables (cobros) - populado por scripts/seed-receivables.mjs
  // Schema: branch_name · snapshot_month (YYYY-MM) · total_amount · total_received ·
  //         total_pending · total_overdue · multa_cancelamento · manutencao_anual ·
  //         avulso · rows_count · source · fetched_at
  evoReceivablesHistory: 'mir3sp6fbi6si5v',
  // ─── Comercial diário (aulas experimentais por unidade) ──────────────────
  // Inputs manuais do gestor por (branch_name, snapshot_date YYYY-MM-DD):
  //   agendados, confirmados, compareceram, faltaram, fecharam, reagendados,
  //   notes, updated_by (email), updated_at (ISO).
  // Why manual: EVO nao expoe listagem de enrollments com status por
  // unidade/dia em endpoint utilizavel; confirmação/reagendamento são
  // operação manual de telefone.
  comercialDiario: 'mqig4weyjfdujhh',
} as const;

// ─── HTTP helper ──────────────────────────────────────────────────────────────

// Generic NocoDB response shape — list endpoints return { list, pageInfo }, single records return the record.
// Generic over the row type so callers can specify what shape they expect (default: arbitrary record).
type NocoRow = Record<string, unknown>;
interface NocoResponse<T extends NocoRow = NocoRow> {
  list?: T[];
  pageInfo?: unknown;
}

async function nocoGet<T extends NocoRow = NocoRow>(table: string, params = ''): Promise<NocoResponse<T>> {
  const res = await fetch(`${NOCO_BASE}/tables/${table}/records${params}`, {
    headers: { 'xc-token': NOCO_TOKEN },
  });
  if (!res.ok) throw new Error(`NocoDB GET ${res.status}`);
  return res.json();
}

async function nocoPost<T extends NocoRow = NocoRow>(table: string, body: object): Promise<NocoResponse<T>> {
  const res = await fetch(`${NOCO_BASE}/tables/${table}/records`, {
    method: 'POST',
    headers: { 'xc-token': NOCO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NocoDB POST ${res.status}`);
  return res.json();
}

async function nocoPatch<T extends NocoRow = NocoRow>(table: string, body: object): Promise<NocoResponse<T>> {
  const res = await fetch(`${NOCO_BASE}/tables/${table}/records`, {
    method: 'PATCH',
    headers: { 'xc-token': NOCO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`NocoDB PATCH ${res.status}`);
  return res.json();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Admin emails with full access
export const ADMIN_EMAILS = [
  'ti@fluxodigitaltech.com.br',
  'fluxodigitaltech@gmail.com',
];

export interface GbUser extends Record<string, unknown> {
  Id: number;
  email: string;
  name: string;
  role: string;
  // Comma-separated unit names or "all" — modo LEGADO (mantido pra retrocompat)
  allowed_units?: string;
  // Comma-separated page IDs or "all" — modo LEGADO (mantido pra retrocompat)
  allowed_pages?: string;
  // JSON serializado da matriz Página×Unidade. Se preenchido, tem PRECEDÊNCIA sobre allowed_*.
  // Schema: { "<NomeUnidade>": ["<pageId>", ...], "*": [...] }
  // Chave "*" = vale pra todas unidades. Valor ["*"] = vale pra todas páginas.
  cell_permissions?: string;
  // JSON serializado do layout customizado dos painéis (admin reorganiza cards)
  // Schema: { "order": ["cardId", ...], "hidden": ["cardId", ...] }
  dashboard_layout?: string;
  tv_layout?: string;
  // Preferências de exibição por usuário (checkbox no NocoDB).
  // AUSENTE/null = comportamento padrão = true (mostra tudo) — retrocompat.
  show_vendas_valor?: boolean;          // vê o card "Vendas (R$)" no Painel
  pdf_faturamento_estimado?: boolean;   // PDF gerado por ele inclui Faturamento Estimado
  show_taxa_ocupacao?: boolean;         // vê o card "Taxa de Ocupação" no Painel
  can_download_pdf?: boolean;           // pode baixar o relatório PDF no Painel
  can_edit_metas?: boolean;             // pode EDITAR/salvar metas (não-admin). Default false.
  // ── Visibilidade ao CLICAR num card (drill-down) — default true (mostra). ──
  can_see_inadimplentes?: boolean;      // % inadimplência, contagem e export no detalhe da unidade
  can_see_vendas_detalhe?: boolean;     // stat "Vendas Mês" no detalhe da unidade
  can_see_financeiro_detalhe?: boolean; // Faturamento Real/Estimado/Já Pagaram no detalhe
  can_see_receita_risco?: boolean;      // "Receita em Risco" no painel verde do detalhe
  can_see_evasao?: boolean;             // Evasão (card % Evasão, painel verde, modal de evasão)
  can_see_cliente_nome?: boolean;       // nome do cliente nas listas (matrículas, evasão)
  can_see_tendencia?: boolean;          // gráfico "Evolução da Rede / Tendência & Projeção" no Painel
  can_see_tendencia_faturamento?: boolean; // aba "Faturamento" DENTRO do gráfico Tendência & Projeção. Default true.
  can_see_meta_regional?: boolean;      // seção "Meta Regional" (visão consolidada) na tela KPIs. Default false.
}

/**
 * Coerção robusta de booleano vindo do NocoDB (checkbox pode voltar como
 * boolean, 0/1, ou string). undefined/null/'' caem no default — usamos default
 * `true` nas prefs de exibição pra manter o comportamento legado (mostra tudo)
 * em usuários criados antes das colunas existirem.
 */
function coerceBool(v: unknown, dflt: boolean): boolean {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 't'].includes(v.toLowerCase());
  return dflt;
}

/** Usuário vê o valor em R$ das vendas (card "Vendas (R$)") no Painel? Default true. */
export function canSeeVendasValor(user: GbUser): boolean {
  return coerceBool(user.show_vendas_valor, true);
}

/** O PDF gerado por esse usuário inclui o Faturamento Estimado? Default true. */
export function pdfIncludesFatEstimado(user: GbUser): boolean {
  return coerceBool(user.pdf_faturamento_estimado, true);
}

/** Usuário vê o card "Taxa de Ocupação" no Painel? Default true. */
export function canSeeTaxaOcupacao(user: GbUser): boolean {
  return coerceBool(user.show_taxa_ocupacao, true);
}

/** Usuário pode baixar o relatório PDF no Painel? Default true. */
export function canDownloadPdf(user: GbUser): boolean {
  return coerceBool(user.can_download_pdf, true);
}

/** Usuário pode EDITAR/salvar metas? Admin sempre pode. Não-admin: opt-in (default false). */
export function canEditMetas(user: GbUser): boolean {
  return isAdmin(user) || coerceBool(user.can_edit_metas, false);
}

// ─── Visibilidade no drill-down (ao clicar nos cards) ────────────────────────
// Todas default `true` (mostra) pra retrocompat com usuários criados antes das
// colunas existirem. Vale por USUÁRIO — inclusive admin: se o admin desmarcar
// no PRÓPRIO usuário, ele também deixa de ver (permite pré-visualizar o efeito
// sem trocar de login). Por padrão (coluna vazia) = true, então admin vê tudo
// até desmarcar explicitamente.

/** Vê % inadimplência, contagem e export de inadimplentes no detalhe da unidade? Default true. */
export function canSeeInadimplentes(user: GbUser): boolean {
  return coerceBool(user.can_see_inadimplentes, true);
}

/** Vê o stat "Vendas Mês" no detalhe da unidade? Default true. */
export function canSeeVendasDetalhe(user: GbUser): boolean {
  return coerceBool(user.can_see_vendas_detalhe, true);
}

/** Vê Faturamento Real/Estimado/Já Pagaram no detalhe da unidade? Default true. */
export function canSeeFinanceiroDetalhe(user: GbUser): boolean {
  return coerceBool(user.can_see_financeiro_detalhe, true);
}

/** Vê "Receita em Risco" no painel verde do detalhe? Default true. */
export function canSeeReceitaRisco(user: GbUser): boolean {
  return coerceBool(user.can_see_receita_risco, true);
}

/** Vê Evasão (card % Evasão, painel verde do detalhe, modal de evasão)? Default true. */
export function canSeeEvasao(user: GbUser): boolean {
  return coerceBool(user.can_see_evasao, true);
}

/** Vê nome do cliente nas listas (matrículas, evasão)? Default true. */
export function canSeeClienteNome(user: GbUser): boolean {
  return coerceBool(user.can_see_cliente_nome, true);
}

/** Vê o gráfico "Evolução da Rede / Tendência & Projeção" no Painel? Default true. */
export function canSeeTendencia(user: GbUser): boolean {
  return coerceBool(user.can_see_tendencia, true);
}

/** Vê a aba "Faturamento" DENTRO do gráfico Tendência & Projeção? Default true.
 *  Pensado pra sócios cotistas: veem o gráfico, mas sem a métrica de faturamento. */
export function canSeeTendenciaFaturamento(user: GbUser): boolean {
  return coerceBool(user.can_see_tendencia_faturamento, true);
}

/** Vê a seção "Meta Regional" (visão consolidada da rede) na tela KPIs?
 *  Admin sempre vê. Demais: só se o toggle estiver ligado. Default false. */
export function canSeeMetaRegional(user: GbUser): boolean {
  return isAdmin(user) || coerceBool(user.can_see_meta_regional, false);
}

export function isAdmin(user: GbUser): boolean {
  return user.role === 'admin' || ADMIN_EMAILS.includes(user.email.toLowerCase());
}

/**
 * Guard defensivo: aborta a operação se o usuário corrente não for admin.
 * Lance esse helper no início de qualquer função que persista mudanças no
 * NocoDB (saveKpi, deleteUser, etc.) — a tabela não tem ACL, então frontend
 * é a única barreira. Logamos pra detectar tentativas via console/devtools.
 */
function ensureAdminOrThrow(operation: string): void {
  const session = getSession();
  if (!session || !isAdmin(session)) {
    const err = new Error(`Operação ${operation} requer privilégios de administrador.`);
    console.warn(`[nocodbApi] ${operation} bloqueada — usuário não-admin (${session?.email ?? 'sem sessão'})`);
    throw err;
  }
}

/**
 * Guard pra salvar metas: admin OU usuário com a permissão can_edit_metas.
 * Diferente do ensureAdminOrThrow porque editar metas pode ser delegado a
 * gerentes (por usuário, na tela de Usuários).
 */
function ensureCanEditMetasOrThrow(operation: string): void {
  const session = getSession();
  if (!session || !canEditMetas(session)) {
    const err = new Error(`Operação ${operation} requer permissão para editar metas.`);
    console.warn(`[nocodbApi] ${operation} bloqueada — sem permissão de editar metas (${session?.email ?? 'sem sessão'})`);
    throw err;
  }
}

export function getAllowedUnits(user: GbUser): string[] | 'all' {
  if (isAdmin(user)) return 'all';
  if (!user.allowed_units || user.allowed_units === 'all') return 'all';
  return user.allowed_units.split(',').map(s => s.trim()).filter(Boolean);
}

export function getAllowedPages(user: GbUser): string[] | 'all' {
  if (isAdmin(user)) return 'all';
  if (!user.allowed_pages || user.allowed_pages === 'all') return 'all';
  return user.allowed_pages.split(',').map(s => s.trim()).filter(Boolean);
}

// ─── Matriz Página×Unidade (novo modelo de permissões) ───────────────────────
//
// Permite controle granular: 'Gerente vê Financeiro DA Saúde mas não DA Belenzinho'.
// Mantém retrocompat com allowed_pages/allowed_units (modo legado) via fallback.
//
// Convenção:
//   chave '*'         → vale pra TODAS as unidades
//   valor ['*']       → vale pra TODAS as páginas
//   {} (vazio)        → sem permissão nenhuma
//   { '*': ['*'] }    → acesso total (equivalente a admin)
//
// Storage: campo cell_permissions é o JSON serializado dessa estrutura.
export type CellPermissions = Record<string, string[]>;

export function parseCellPermissions(raw: string | undefined): CellPermissions | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CellPermissions;
    }
  } catch { /* json malformado vira null → cai no legado */ }
  return null;
}

export function serializeCellPermissions(perms: CellPermissions): string {
  return JSON.stringify(perms);
}

/** Deriva matriz a partir do modo legado (allowed_pages × allowed_units). */
export function deriveCellPermissionsFromLegacy(user: GbUser): CellPermissions {
  const pages = getAllowedPages(user);
  const units = getAllowedUnits(user);
  const pagesArr: string[] = pages === 'all' ? ['*'] : pages;
  if (units === 'all') {
    return { '*': pagesArr };
  }
  const result: CellPermissions = {};
  for (const u of units) result[u] = pagesArr;
  return result;
}

/** Retorna a matriz efetiva do usuário: cell_permissions se existir, senão deriva do legado. */
export function getMatrixForUser(user: GbUser): CellPermissions {
  if (isAdmin(user)) return { '*': ['*'] };
  const fromCell = parseCellPermissions(user.cell_permissions);
  if (fromCell) return fromCell;
  return deriveCellPermissionsFromLegacy(user);
}

/** Pode ver a página X NA unidade Y? Resposta granular. */
export function canAccessPageInUnit(user: GbUser, page: string, unit: string): boolean {
  if (isAdmin(user)) return true;
  const perms = getMatrixForUser(user);
  const unitPerms = perms[unit] ?? perms['*'];
  if (!unitPerms) return false;
  return unitPerms.includes('*') || unitPerms.includes(page);
}

/** Pode ver a página em ALGUMA unidade? (usa pra decidir se aba aparece na sidebar) */
export function canAccessPage(user: GbUser, page: string): boolean {
  if (isAdmin(user)) return true;
  const perms = getMatrixForUser(user);
  return Object.values(perms).some(pages => pages.includes('*') || pages.includes(page));
}

/** Lista unidades que o usuário pode ver pra uma página específica. 'all' = qualquer uma. */
export function getAllowedUnitsForPage(user: GbUser, page: string): string[] | 'all' {
  if (isAdmin(user)) return 'all';

  // ─── CAP global de unidades ──────────────────────────────────────────────
  // allowed_units é o teto absoluto: o usuário NUNCA pode ver dados de
  // unidades além desse conjunto, mesmo que a matriz Página×Unidade conceda
  // acesso coringa ('*'). Garante que gerente da Altino só veja Altino em
  // TODAS as abas do dashboard, sem exceção.
  const globalUnits = getAllowedUnits(user); // 'all' | string[]

  const perms = getMatrixForUser(user);
  const wildcard = perms['*'];
  if (wildcard && (wildcard.includes('*') || wildcard.includes(page))) {
    // Página liberada pelo coringa na matriz — mas ainda limitada pelo CAP global.
    return globalUnits;
  }

  const pageUnits = Object.entries(perms)
    .filter(([unit, pages]) => unit !== '*' && (pages.includes('*') || pages.includes(page)))
    .map(([unit]) => unit);

  if (pageUnits.length === 0) return [];
  if (globalUnits === 'all') return pageUnits;

  // Intersecção: só mostra unidades presentes em AMBOS (matriz da página + CAP global).
  const globalSet = new Set(globalUnits);
  return pageUnits.filter(u => globalSet.has(u));
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mapeia um record cru do NocoDB pro GbUser da sessão (fonte única — usada
// pelo login e pela revalidação em fetchUserByEmail).
function mapUserRecord(record: GbUser): GbUser {
  return {
    Id:            record.Id,
    email:         record.email,
    name:          record.name,
    role:          record.role,
    allowed_units: record.allowed_units ?? 'all',
    allowed_pages: record.allowed_pages ?? 'all',
    cell_permissions: typeof record.cell_permissions === 'string' ? record.cell_permissions : undefined,
    dashboard_layout: typeof record.dashboard_layout === 'string' ? record.dashboard_layout : undefined,
    tv_layout:        typeof record.tv_layout === 'string' ? record.tv_layout : undefined,
    show_vendas_valor:        coerceBool(record.show_vendas_valor, true),
    pdf_faturamento_estimado: coerceBool(record.pdf_faturamento_estimado, true),
    show_taxa_ocupacao:       coerceBool(record.show_taxa_ocupacao, true),
    can_download_pdf:         coerceBool(record.can_download_pdf, true),
    can_edit_metas:           coerceBool(record.can_edit_metas, false),
    can_see_inadimplentes:     coerceBool(record.can_see_inadimplentes, true),
    can_see_vendas_detalhe:    coerceBool(record.can_see_vendas_detalhe, true),
    can_see_financeiro_detalhe: coerceBool(record.can_see_financeiro_detalhe, true),
    can_see_receita_risco:     coerceBool(record.can_see_receita_risco, true),
    can_see_evasao:            coerceBool(record.can_see_evasao, true),
    can_see_cliente_nome:      coerceBool(record.can_see_cliente_nome, true),
    can_see_tendencia:         coerceBool(record.can_see_tendencia, true),
    can_see_tendencia_faturamento: coerceBool(record.can_see_tendencia_faturamento, true),
    can_see_meta_regional:     coerceBool(record.can_see_meta_regional, false),
  };
}

export async function loginWithNocoDB(email: string, password: string): Promise<GbUser> {
  const hash = await sha256(password);
  const encoded = encodeURIComponent(email);
  const data = await nocoGet<GbUser>(
    TABLES.users,
    `?where=(email,eq,${encoded})~and(password_hash,eq,${hash})~and(active,eq,true)&limit=1`
  );
  const record = data?.list?.[0];
  if (!record) throw new Error('Credenciais inválidas ou acesso inativo.');
  return mapUserRecord(record);
}

/**
 * Troca de senha self-service (sem precisar de admin nem do fluxo de convite).
 * Valida a senha ATUAL fazendo um login real e, se passar, grava o novo hash.
 * Lança se a senha atual estiver errada/conta inativa.
 */
export async function changeOwnPassword(email: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await loginWithNocoDB(email, currentPassword); // valida identidade (lança se inválida)
  const newHash = await sha256(newPassword);
  await nocoPatch(TABLES.users, { Id: user.Id, password_hash: newHash });
}

/**
 * Revalida o usuário corrente direto no NocoDB (por email, sem senha). Usado no
 * load do app pra atualizar permissões/preferências SEM exigir logout+login —
 * quando o admin muda um toggle, o usuário só precisa recarregar a página.
 * Retorna null se o usuário não existe mais ou foi desativado (caller decide
 * se desloga). Lança em erro de rede (caller mantém a sessão atual).
 */
export async function fetchUserByEmail(email: string): Promise<GbUser | null> {
  const encoded = encodeURIComponent(email);
  const data = await nocoGet<GbUser>(
    TABLES.users,
    `?where=(email,eq,${encoded})~and(active,eq,true)&limit=1`
  );
  const record = data?.list?.[0];
  if (!record) return null;
  return mapUserRecord(record);
}

export function saveSession(user: GbUser) {
  localStorage.setItem('gb_session', JSON.stringify(user));
}

export function getSession(): GbUser | null {
  try {
    const raw = localStorage.getItem('gb_session');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearSession() {
  localStorage.removeItem('gb_session');
}

// ─── EVO Snapshot ─────────────────────────────────────────────────────────────

export async function saveEvoSnapshot(branchName: string, data: {
  activeMembers: number;
  inactiveMembers: number;
  todayEntries: number;
  rawJson?: object;
}) {
  const today = localYMD();
  return nocoPost(TABLES.evoSnapshot, {
    branch_name:     branchName,
    active_members:  data.activeMembers,
    inactive_members: data.inactiveMembers,
    today_entries:   data.todayEntries,
    snapshot_date:   today,
    raw_json:        data.rawJson ? JSON.stringify(data.rawJson) : null,
  });
}

// ─── Relatórios ───────────────────────────────────────────────────────────────

export async function logRelatorio(opts: {
  titulo: string;
  tipo: string;
  geradoPor: string;
  periodoInicio?: string;
  periodoFim?: string;
  resumo?: object;
}) {
  const today = localYMD();
  return nocoPost(TABLES.relatorios, {
    titulo:         opts.titulo,
    tipo:           opts.tipo,
    gerado_por:     opts.geradoPor,
    periodo_inicio: opts.periodoInicio ?? today,
    periodo_fim:    opts.periodoFim ?? today,
    resumo_json:    opts.resumo ? JSON.stringify(opts.resumo) : null,
  });
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export interface Kpi extends Record<string, unknown> {
  Id?: number;
  nome: string;
  valor: number;
  meta: number;
  unidade: string;
  categoria: string;
  periodo: string;
  observacao?: string;
}

export async function fetchKpis(): Promise<Kpi[]> {
  // limit alto + sort por mais-recente: com upsert em saveKpi a tabela converge
  // pra ~1 linha por (unidade, categoria, periodo), mas linhas duplicadas de
  // saves antigos (antes do upsert) ainda existem. Trazemos um lote grande e o
  // consumidor faz dedup pegando a 1ª ocorrência (= mais recente) de cada chave.
  const data = await nocoGet<Kpi>(TABLES.kpis, '?limit=1000&sort=-CreatedAt');
  return data?.list ?? [];
}

export async function saveKpi(kpi: Omit<Kpi, 'Id'>): Promise<void> {
  // Guard defensivo: NocoDB não tem ACL configurado, frontend é a única barreira.
  // Admin OU usuário com can_edit_metas pode salvar.
  ensureCanEditMetasOrThrow('saveKpi');
  // Upsert (não POST cego): procura a linha existente e atualiza no lugar.
  // Nomes de unidade não têm vírgula nem parênteses (só espaços/acentos), então
  // são seguros no where do NocoDB.
  const where = `(unidade,eq,${kpi.unidade})~and(categoria,eq,${kpi.categoria})~and(periodo,eq,${kpi.periodo})`;
  const existing = await nocoGet<Kpi>(TABLES.kpis, `?where=${encodeURIComponent(where)}&limit=1&sort=-CreatedAt`);
  const row = existing?.list?.[0];
  if (row?.Id != null) {
    await nocoPatch(TABLES.kpis, { ...kpi, Id: row.Id });
  } else {
    await nocoPost(TABLES.kpis, kpi);
  }
}

/** Busca todas as linhas de kpis de um período (paginado). */
async function fetchKpisByPeriodo(periodo: string): Promise<Kpi[]> {
  const where = encodeURIComponent(`(periodo,eq,${periodo})`);
  const all: Kpi[] = [];
  let offset = 0;
  for (;;) {
    const data = await nocoGet<Kpi>(TABLES.kpis, `?where=${where}&limit=100&offset=${offset}&sort=Id`);
    const list = data?.list ?? [];
    all.push(...list);
    const total = (data?.pageInfo as { totalRows?: number } | undefined)?.totalRows ?? all.length;
    offset += list.length;
    // Para antes de pedir offset >= total (NocoDB rejeita com 422).
    if (list.length === 0 || all.length >= total) break;
  }
  return all;
}

/**
 * Salva VÁRIAS metas de uma vez (bulk upsert).
 *
 * Por que: o "Salvar Metas" grava ~84 linhas (unidades × categorias). Fazer uma
 * request por linha (84, ou ~168 com o upsert do saveKpi) estourava o NocoDB
 * cloud — a maioria falhava em silêncio e a tela mostrava "Salvo" sem persistir,
 * então ao recarregar "sumia tudo". Aqui buscamos as linhas do período 1x,
 * separamos update (já existe) de insert (novo) e mandamos PATCH/POST em LOTE
 * (poucas requests). Lança se algum lote falhar — o chamador mostra erro real.
 */
export async function saveKpisBulk(kpis: Omit<Kpi, 'Id'>[], periodo: string): Promise<void> {
  ensureCanEditMetasOrThrow('saveKpisBulk');
  if (kpis.length === 0) return;

  // Mapa (unidade|categoria) → Id mais recente, a partir das linhas já existentes.
  const existing = await fetchKpisByPeriodo(periodo);
  const idByKey = new Map<string, number>();
  for (const r of existing) {
    if (r.Id == null) continue;
    const key = `${r.unidade}|${r.categoria}`;
    const prev = idByKey.get(key);
    if (prev == null || r.Id > prev) idByKey.set(key, r.Id);
  }

  const toUpdate: (Omit<Kpi, 'Id'> & { Id: number })[] = [];
  const toInsert: Omit<Kpi, 'Id'>[] = [];
  for (const k of kpis) {
    const id = idByKey.get(`${k.unidade}|${k.categoria}`);
    if (id != null) toUpdate.push({ ...k, Id: id });
    else toInsert.push(k);
  }

  // Lotes de até 100 (limite confortável do NocoDB cloud por request).
  const chunk = <T,>(arr: T[], n: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };
  // Sequencial (não paralelo) pra não recriar o problema de concorrência.
  for (const part of chunk(toUpdate, 100)) await nocoPatch(TABLES.kpis, part);
  for (const part of chunk(toInsert, 100)) await nocoPost(TABLES.kpis, part);
}

// ─── Financeiro ───────────────────────────────────────────────────────────────

export interface LancamentoFinanceiro extends Record<string, unknown> {
  Id?: number;
  unidade: string;
  tipo: 'receita' | 'despesa';
  descricao: string;
  valor: number;
  data: string;
  categoria: string;
  observacao?: string;
}

export async function fetchLancamentos(): Promise<LancamentoFinanceiro[]> {
  const data = await nocoGet<LancamentoFinanceiro>(TABLES.financeiro, '?limit=200&sort=-data');
  return data?.list ?? [];
}

export async function saveLancamento(l: Omit<LancamentoFinanceiro, 'Id'>): Promise<void> {
  ensureAdminOrThrow('saveLancamento');
  await nocoPost(TABLES.financeiro, l);
}

// ─── Gestão de Usuários (admin only) ─────────────────────────────────────────

export interface GbUserRecord extends Record<string, unknown> {
  Id: number;
  email: string;
  name: string;
  role: string;
  active: boolean;
  allowed_units?: string;
  allowed_pages?: string;
  cell_permissions?: string; // JSON serializado da matriz (novo modelo)
  dashboard_layout?: string; // JSON serializado do layout do Painel principal
  tv_layout?: string;        // JSON serializado do layout do Modo TV
  show_vendas_valor?: boolean;        // vê o card "Vendas (R$)" no Painel
  pdf_faturamento_estimado?: boolean; // PDF inclui Faturamento Estimado
  show_taxa_ocupacao?: boolean;       // vê o card "Taxa de Ocupação" no Painel
  can_download_pdf?: boolean;         // pode baixar o relatório PDF no Painel
  can_edit_metas?: boolean;           // pode EDITAR/salvar metas (não-admin)
  can_see_inadimplentes?: boolean;       // vê inadimplentes no detalhe da unidade
  can_see_vendas_detalhe?: boolean;      // vê "Vendas Mês" no detalhe da unidade
  can_see_financeiro_detalhe?: boolean;  // vê Faturamento/Já Pagaram no detalhe
  can_see_receita_risco?: boolean;       // vê "Receita em Risco" no detalhe
  can_see_evasao?: boolean;              // vê Evasão (card, detalhe, modal)
  can_see_cliente_nome?: boolean;        // vê nome do cliente nas listas
  can_see_tendencia?: boolean;           // vê o gráfico Evolução da Rede no Painel
  can_see_tendencia_faturamento?: boolean; // vê a aba Faturamento dentro do gráfico de tendência
  can_see_meta_regional?: boolean;       // vê a seção "Meta Regional" na tela KPIs
}

export async function fetchAllUsers(): Promise<GbUserRecord[]> {
  const data = await nocoGet<GbUserRecord>(TABLES.users, '?limit=100&sort=name');
  return (data?.list ?? []).map(r => ({
    Id:            r.Id,
    email:         r.email,
    name:          r.name,
    role:          r.role,
    active:        r.active,
    allowed_units: r.allowed_units ?? 'all',
    allowed_pages: r.allowed_pages ?? 'all',
    cell_permissions: typeof r.cell_permissions === 'string' ? r.cell_permissions : undefined,
    dashboard_layout: typeof r.dashboard_layout === 'string' ? r.dashboard_layout : undefined,
    tv_layout:        typeof r.tv_layout === 'string' ? r.tv_layout : undefined,
    show_vendas_valor:        coerceBool(r.show_vendas_valor, true),
    pdf_faturamento_estimado: coerceBool(r.pdf_faturamento_estimado, true),
    show_taxa_ocupacao:       coerceBool(r.show_taxa_ocupacao, true),
    can_download_pdf:         coerceBool(r.can_download_pdf, true),
    can_edit_metas:           coerceBool(r.can_edit_metas, false),
    can_see_inadimplentes:     coerceBool(r.can_see_inadimplentes, true),
    can_see_vendas_detalhe:    coerceBool(r.can_see_vendas_detalhe, true),
    can_see_financeiro_detalhe: coerceBool(r.can_see_financeiro_detalhe, true),
    can_see_receita_risco:     coerceBool(r.can_see_receita_risco, true),
    can_see_evasao:            coerceBool(r.can_see_evasao, true),
    can_see_cliente_nome:      coerceBool(r.can_see_cliente_nome, true),
    can_see_tendencia:         coerceBool(r.can_see_tendencia, true),
    can_see_tendencia_faturamento: coerceBool(r.can_see_tendencia_faturamento, true),
    can_see_meta_regional:     coerceBool(r.can_see_meta_regional, false),
  }));
}

/**
 * Exclui usuário do NocoDB (hard delete — registro removido permanentemente).
 * Usado pelo admin pra deletar contas antigas/sem uso. Operação irreversível.
 *
 * Pra desativar sem perder histórico, prefira `updateUserPermissions(id, { active: false })`.
 */
export async function deleteUser(id: number): Promise<void> {
  ensureAdminOrThrow('deleteUser');
  const res = await fetch(`${NOCO_BASE}/tables/${TABLES.users}/records`, {
    method: 'DELETE',
    headers: { 'xc-token': NOCO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Id: id }),
  });
  if (!res.ok) throw new Error(`NocoDB DELETE user ${res.status}`);
}

export async function updateUserPermissions(id: number, fields: Partial<GbUserRecord>): Promise<void> {
  ensureAdminOrThrow('updateUserPermissions');
  await nocoPatch(TABLES.users, { Id: id, ...fields });
}

export async function createNewUser(opts: {
  email: string;
  name: string;
  role: string;
  password: string;
  allowed_units: string;
  allowed_pages: string;
  cell_permissions?: string; // JSON serializado da matriz (opcional)
  show_vendas_valor?: boolean;
  pdf_faturamento_estimado?: boolean;
  show_taxa_ocupacao?: boolean;
  can_download_pdf?: boolean;
  can_edit_metas?: boolean;
  can_see_inadimplentes?: boolean;
  can_see_vendas_detalhe?: boolean;
  can_see_financeiro_detalhe?: boolean;
  can_see_receita_risco?: boolean;
  can_see_evasao?: boolean;
  can_see_cliente_nome?: boolean;
  can_see_tendencia?: boolean;
  can_see_tendencia_faturamento?: boolean;
  can_see_meta_regional?: boolean;
}): Promise<void> {
  ensureAdminOrThrow('createNewUser');
  const hash = await sha256(opts.password);
  const body: Record<string, unknown> = {
    email:         opts.email,
    name:          opts.name,
    role:          opts.role,
    password_hash: hash,
    active:        true,
    allowed_units: opts.allowed_units,
    allowed_pages: opts.allowed_pages,
  };
  if (opts.cell_permissions !== undefined) body.cell_permissions = opts.cell_permissions;
  if (opts.show_vendas_valor !== undefined) body.show_vendas_valor = opts.show_vendas_valor;
  if (opts.pdf_faturamento_estimado !== undefined) body.pdf_faturamento_estimado = opts.pdf_faturamento_estimado;
  if (opts.show_taxa_ocupacao !== undefined) body.show_taxa_ocupacao = opts.show_taxa_ocupacao;
  if (opts.can_download_pdf !== undefined) body.can_download_pdf = opts.can_download_pdf;
  if (opts.can_edit_metas !== undefined) body.can_edit_metas = opts.can_edit_metas;
  if (opts.can_see_inadimplentes !== undefined) body.can_see_inadimplentes = opts.can_see_inadimplentes;
  if (opts.can_see_vendas_detalhe !== undefined) body.can_see_vendas_detalhe = opts.can_see_vendas_detalhe;
  if (opts.can_see_financeiro_detalhe !== undefined) body.can_see_financeiro_detalhe = opts.can_see_financeiro_detalhe;
  if (opts.can_see_receita_risco !== undefined) body.can_see_receita_risco = opts.can_see_receita_risco;
  if (opts.can_see_evasao !== undefined) body.can_see_evasao = opts.can_see_evasao;
  if (opts.can_see_cliente_nome !== undefined) body.can_see_cliente_nome = opts.can_see_cliente_nome;
  if (opts.can_see_tendencia !== undefined) body.can_see_tendencia = opts.can_see_tendencia;
  if (opts.can_see_tendencia_faturamento !== undefined) body.can_see_tendencia_faturamento = opts.can_see_tendencia_faturamento;
  if (opts.can_see_meta_regional !== undefined) body.can_see_meta_regional = opts.can_see_meta_regional;
  await nocoPost(TABLES.users, body);
}

// ─── Templates de Função (Roles) ─────────────────────────────────────────────
// Permite criar templates customizados além dos 4 padrão (admin/gerente/consultor/viewer).
// Storage com fallback gracioso:
//   - Se TABLES.roleTemplates está preenchido → usa NocoDB (compartilhado entre usuários)
//   - Senão → usa localStorage (funciona local, não compartilha)

export interface RoleTemplate extends Record<string, unknown> {
  Id?: number;
  name: string;
  description: string;
  cell_permissions: string; // JSON serializado da matriz
  is_default?: boolean;     // true pros 4 templates padrão (não editáveis)
}

const ROLE_TEMPLATES_LOCAL_KEY = 'gb_role_templates_local_v1';

function readLocalTemplates(): RoleTemplate[] {
  try {
    const raw = localStorage.getItem(ROLE_TEMPLATES_LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function writeLocalTemplates(list: RoleTemplate[]): void {
  try { localStorage.setItem(ROLE_TEMPLATES_LOCAL_KEY, JSON.stringify(list)); } catch { /* quota cheia, ignora */ }
}

export async function fetchRoleTemplates(): Promise<RoleTemplate[]> {
  if (TABLES.roleTemplates) {
    try {
      const data = await nocoGet<RoleTemplate>(TABLES.roleTemplates, '?limit=100&sort=name');
      return data?.list ?? [];
    } catch (e) {
      console.warn('[roleTemplates] NocoDB falhou, caindo pra localStorage:', e);
    }
  }
  return readLocalTemplates();
}

export async function createRoleTemplate(t: Omit<RoleTemplate, 'Id'>): Promise<RoleTemplate> {
  ensureAdminOrThrow('createRoleTemplate');
  if (TABLES.roleTemplates) {
    try {
      await nocoPost(TABLES.roleTemplates, t as object);
      return t as RoleTemplate;
    } catch (e) {
      console.warn('[roleTemplates] NocoDB falhou no create, salvando local:', e);
    }
  }
  // Fallback localStorage. Cast: Omit<RoleTemplate,'Id'> com index signature perde os fields nominais,
  // então TypeScript não consegue inferir que o spread tem name/description/cell_permissions.
  const list = readLocalTemplates();
  const newTemplate = { ...t, Id: Date.now() } as RoleTemplate;
  list.push(newTemplate);
  writeLocalTemplates(list);
  return newTemplate;
}

export async function updateRoleTemplate(id: number, fields: Partial<RoleTemplate>): Promise<void> {
  ensureAdminOrThrow('updateRoleTemplate');
  if (TABLES.roleTemplates) {
    try {
      await nocoPatch(TABLES.roleTemplates, { Id: id, ...fields });
      return;
    } catch (e) {
      console.warn('[roleTemplates] NocoDB falhou no update:', e);
    }
  }
  const list = readLocalTemplates().map(t => t.Id === id ? { ...t, ...fields } : t);
  writeLocalTemplates(list);
}

export async function deleteRoleTemplate(id: number): Promise<void> {
  ensureAdminOrThrow('deleteRoleTemplate');
  if (TABLES.roleTemplates) {
    try {
      await fetch(`${NOCO_BASE}/tables/${TABLES.roleTemplates}/records`, {
        method: 'DELETE',
        headers: { 'xc-token': NOCO_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ Id: id }),
      });
      return;
    } catch (e) {
      console.warn('[roleTemplates] NocoDB falhou no delete:', e);
    }
  }
  writeLocalTemplates(readLocalTemplates().filter(t => t.Id !== id));
}

/** Conta quantos usuários usam um determinado role (pra aviso de impacto) */
export async function countUsersByRole(roleName: string): Promise<number> {
  try {
    const data = await nocoGet<GbUserRecord>(TABLES.users, `?where=(role,eq,${encodeURIComponent(roleName)})&limit=1000`);
    return data?.list?.length ?? 0;
  } catch { return 0; }
}

// ─── Layout customizado dos painéis (por usuário) ────────────────────────────
// Permite ao admin reordenar/esconder cards do Painel principal e do Modo TV.
// Storage: NocoDB (sincroniza entre máquinas) com fallback gracioso pra session local.
// Schema do JSON: { "order": ["card1", "card2", ...], "hidden": ["card3"] }
//
// Pra ativar storage no NocoDB, criar 2 colunas Long Text na tabela gb_users:
//   - dashboard_layout
//   - tv_layout
// Sem essas colunas, o sistema continua funcionando salvando só na session local.

export interface PanelLayout {
  order: string[];   // IDs dos cards na ordem de exibição
  hidden: string[];  // IDs dos cards escondidos
}

export function parsePanelLayout(raw: string | undefined): PanelLayout | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.order) && Array.isArray(parsed.hidden)) {
      return { order: parsed.order.map(String), hidden: parsed.hidden.map(String) };
    }
  } catch { /* json malformado → null */ }
  return null;
}

export function serializePanelLayout(layout: PanelLayout): string {
  return JSON.stringify(layout);
}

/** Lê o layout do usuário logado pra um painel específico. Retorna null se nunca configurado. */
export function getLayoutForCurrentUser(field: 'dashboard_layout' | 'tv_layout'): PanelLayout | null {
  const session = getSession();
  if (!session) return null;
  const raw = session[field];
  return parsePanelLayout(typeof raw === 'string' ? raw : undefined);
}

/** Salva layout do usuário atual: atualiza session local imediatamente + tenta NocoDB (fail-safe).
 *  Usa nocoPatch direto (e não updateUserPermissions) porque cada user PODE
 *  salvar seu PRÓPRIO layout — esse não é privilégio admin. */
export async function saveLayoutForCurrentUser(
  field: 'dashboard_layout' | 'tv_layout',
  layout: PanelLayout,
): Promise<void> {
  const session = getSession();
  if (!session) throw new Error('Sem sessão ativa');
  const serialized = serializePanelLayout(layout);
  // Atualiza session local IMEDIATAMENTE (UX instantâneo, sobrevive a refresh)
  saveSession({ ...session, [field]: serialized });
  // Persiste no NocoDB (async, fail-safe — local já tá atualizado).
  // Direto via nocoPatch: cada user pode atualizar APENAS o próprio layout
  // (id da sessão), sem precisar de privilégio admin.
  try {
    await nocoPatch(TABLES.users, { Id: session.Id, [field]: serialized });
  } catch (e) {
    console.warn(`[layout] Falha ao salvar ${field} no NocoDB (coluna pode não existir ainda — mantido só local):`, e);
  }
}

// ─── Histórico mensal EVO (cache compartilhado entre usuários) ───────────────
//
// Objetivo: chamar a API EVO 1x pra cada combinação (unidade × mês) e gravar
// no NocoDB. Próximas leituras (todos os usuários, todas as sessões) vêm do
// banco — sem consumir quota EVO. Dado é histórico fechado e imutável.
//
// Schema da tabela `gb_evo_history` está documentado no TABLES acima.
//
// Identidade lógica do registro: (branch_name, snapshot_month, period_kind).
// NocoDB não suporta unique multi-coluna nativamente, então isHistoryEnabled()
// e os helpers fazem upsert manual (find-then-update ou create).

export interface EvoHistoryRow extends Record<string, unknown> {
  Id?: number;
  branch_name: string;
  snapshot_month: string;             // 'YYYY-MM'
  period_kind: 'monthly' | 'yearly';
  active_members: number;
  adimplentes: number;
  inadimplentes: number;
  faturamento_adimplentes: number;
  /** ValorContrato somado dos clientes inadimplentes (Receita em Risco) — só na fonte /api/history. */
  faturamento_inadimplentes?: number;
  vendas_qtd: number;
  vendas_valor: number;
  source: 'evo_excel' | 'evo_sales' | 'manual';
  fetched_at?: string;                // ISO datetime
}

/** Detecta se o cache histórico tá configurado (table ID preenchido em TABLES.evoHistory). */
export function isHistoryEnabled(): boolean {
  return !!TABLES.evoHistory;
}

/**
 * Lê 1 snapshot histórico específico do NocoDB. Retorna null se vazio ou desabilitado.
 *
 * Filtro NocoDB: `where=(branch_name,eq,X)~and(snapshot_month,eq,Y)~and(period_kind,eq,Z)`.
 * Limita a 1 (caller espera 1 ou nenhum por chave lógica).
 */
export async function fetchEvoHistorySnapshot(
  branchName: string,
  snapshotMonth: string,
  periodKind: 'monthly' | 'yearly' = 'monthly',
): Promise<EvoHistoryRow | null> {
  if (!isHistoryEnabled()) return null;
  try {
    const where = `(branch_name,eq,${encodeURIComponent(branchName)})~and(snapshot_month,eq,${encodeURIComponent(snapshotMonth)})~and(period_kind,eq,${periodKind})`;
    const data = await nocoGet<EvoHistoryRow>(TABLES.evoHistory, `?where=${where}&limit=1`);
    return data?.list?.[0] ?? null;
  } catch (e) {
    console.warn('[evoHistory] fetchEvoHistorySnapshot falhou (NocoDB indisponível?):', e);
    return null;
  }
}

/**
 * Lista todos snapshots de uma unidade (ordenados por snapshot_month desc).
 * Útil pro futuro card de média móvel 12 meses.
 */
export async function listEvoHistoryByBranch(
  branchName: string,
  periodKind: 'monthly' | 'yearly' = 'monthly',
  limit = 24,
): Promise<EvoHistoryRow[]> {
  if (!isHistoryEnabled()) return [];
  try {
    const where = `(branch_name,eq,${encodeURIComponent(branchName)})~and(period_kind,eq,${periodKind})`;
    const data = await nocoGet<EvoHistoryRow>(TABLES.evoHistory, `?where=${where}&sort=-snapshot_month&limit=${limit}`);
    return data?.list ?? [];
  } catch (e) {
    console.warn('[evoHistory] listEvoHistoryByBranch falhou:', e);
    return [];
  }
}

// ─── Série temporal agregada (pra gráficos de tendência) ─────────────────────
//
// Um ponto por mês, somando todas as unidades pedidas. Usado pelo gráfico
// "Evolução da Rede" no Painel e pelos gráficos vetoriais do PDF.

export interface MonthlyAggregate {
  month: string;                  // 'YYYY-MM'
  active_members: number;
  adimplentes: number;
  inadimplentes: number;
  faturamento_adimplentes: number;
  faturamento_inadimplentes?: number;
  vendas_qtd: number;
  vendas_valor: number;
}

/**
 * Agrega linhas brutas de gb_evo_history em uma série mensal (1 ponto/mês),
 * somando as unidades. Se `branchNames` for passado, filtra só essas unidades.
 * Resultado ordenado do mês mais ANTIGO ao mais RECENTE.
 *
 * Função PURA (testável, sem rede) — separada do fetch de propósito.
 */
/**
 * Normaliza nome de unidade pra casar histórico × filtro de forma tolerante.
 * A fonte EVO grava nomes com espaço no fim ("ALTO DO IPIRANGA "), caixa e acento
 * variáveis; comparar string crua fazia o filtro por unidade ZERAR os cards de
 * estoque (ativos/adimplentes/inadimplentes) em meses passados quando escopado a
 * 2-3 unidades. Aqui igualamos por chave normalizada (trim + sem acento + minúsculo
 * + espaços colapsados). Só torna o match MAIS tolerante — nunca casa a menos.
 */
function normBranch(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacriticos (acentos)
    .toUpperCase()
    .replace(/GAVIOES/g, '')          // prefixo da rede ("GAVIOES - BELENZINHO" -> "BELENZINHO")
    .replace(/BE\s*FREE/g, '')       // sub-marca ("BELENZINHO BE FREE" -> "BELENZINHO")
    .replace(/[^A-Z0-9]+/g, ' ')     // hifen/pontuacao/etc. -> espaco
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Casa um branch_name "sujo" do historico contra os nomes de unidade permitidos,
 * de forma tolerante (igual OU um contido no outro) -- espelha o mapHistUnit do
 * backend (server/index.mjs). Nenhum nome oficial de unidade e substring de outro,
 * entao casar por inclusao NUNCA atribui a unidade errada; so torna o filtro mais
 * robusto a variacoes de caixa/acento/espaco/prefixo de rede.
 */
function branchAllowed(raw: unknown, allowNorm: string[]): boolean {
  const n = normBranch(raw);
  if (!n) return false;
  // n.includes(a): historico tem token extra ("belenzinho be free" contem "belenzinho").
  // a.includes(n): historico abreviado ("alto" dentro de "alto do ipiranga"); >=4 evita lixo curto.
  return allowNorm.some(a => a === n || n.includes(a) || (n.length >= 4 && a.includes(n)));
}

export function aggregateHistoryByMonth(
  rows: EvoHistoryRow[],
  branchNames?: string[],
): MonthlyAggregate[] {
  const allowNorm = branchNames ? branchNames.map(normBranch).filter(Boolean) : null;
  const byMonth = new Map<string, MonthlyAggregate>();
  for (const r of rows) {
    if (allowNorm && !branchAllowed(r.branch_name, allowNorm)) continue;
    const month = String(r.snapshot_month);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const acc = byMonth.get(month) ?? {
      month,
      active_members: 0, adimplentes: 0, inadimplentes: 0,
      faturamento_adimplentes: 0, vendas_qtd: 0, vendas_valor: 0,
    };
    acc.active_members          += Number(r.active_members) || 0;
    acc.adimplentes             += Number(r.adimplentes) || 0;
    acc.inadimplentes           += Number(r.inadimplentes) || 0;
    acc.faturamento_adimplentes += Number(r.faturamento_adimplentes) || 0;
    acc.faturamento_inadimplentes = (acc.faturamento_inadimplentes ?? 0) + (Number(r.faturamento_inadimplentes) || 0);
    acc.vendas_qtd              += Number(r.vendas_qtd) || 0;
    acc.vendas_valor            += Number(r.vendas_valor) || 0;
    byMonth.set(month, acc);
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Sobrescreve vendas_qtd/vendas_valor das linhas de histórico com a MESMA fonte
 * do card de Vendas (VendasEvo real, via /api/vendas-range) — pra o gráfico de
 * Tendência (Nº Vendas) BATER com o card. O snapshot gb_evo_history calcula
 * vendas por "diff de membros" e diverge das vendas reais. Só sobrescreve meses
 * DENTRO da cobertura do VendasEvo (preserva meses antigos que só existem no
 * snapshot). Qualquer falha de rede/backend → mantém o snapshot (fallback seguro).
 */
async function overrideVendasFromRealSource(rows: EvoHistoryRow[]): Promise<void> {
  const months = rows.map(r => String(r.snapshot_month)).filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
  if (!months.length) return;
  const from = `${months[0]}-01`;
  const to = new Date().toISOString().slice(0, 10);
  let vr: { enabled?: boolean; list?: Array<{ branchName?: string; saleDate?: string; total?: number }> } | null = null;
  try {
    const resp = await fetch(`/api/vendas-range?from=${from}&to=${to}`);
    if (resp.ok) vr = await resp.json();
  } catch { return; }
  if (!vr?.enabled || !Array.isArray(vr.list) || vr.list.length === 0) return;

  const key = (u: unknown, mo: string) => `${normBranch(u)}|${mo}`;
  const agg = new Map<string, { qtd: number; valor: number }>();
  let minM = '9999-99', maxM = '0000-00';
  for (const it of vr.list) {
    const mo = String(it.saleDate ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mo)) continue;
    if (mo < minM) minM = mo;
    if (mo > maxM) maxM = mo;
    const k = key(it.branchName, mo);
    const cur = agg.get(k) ?? { qtd: 0, valor: 0 };
    cur.qtd += 1;
    cur.valor += Number(it.total) || 0;
    agg.set(k, cur);
  }
  if (maxM < minM) return;
  for (const row of rows) {
    const mo = String(row.snapshot_month);
    if (mo < minM || mo > maxM) continue; // fora da cobertura -> preserva snapshot
    const a = agg.get(key(row.branch_name, mo));
    row.vendas_qtd = a?.qtd ?? 0;
    row.vendas_valor = a ? Math.round(a.valor * 100) / 100 : 0;
  }
}

/**
 * Lê TODAS as linhas mensais de gb_evo_history (todas as unidades de uma vez).
 * São ~7 unidades × 12 meses = 84 linhas — cabe num fetch só. O caller agrega
 * por unidade permitida via {@link aggregateHistoryByMonth} (sem refazer rede
 * quando o filtro de unidade muda no Painel). Retorna [] se desabilitado/erro.
 */
export async function fetchAllEvoHistoryMonthly(limit = 500): Promise<EvoHistoryRow[]> {
  // 1) Fonte preferida: mini-backend /api/history — agrega a tabela "Membros"
  //    do NocoDB self-hosted em runtime (ativos/adimplentes/inadimplentes/
  //    faturamento estimado). O token fica no servidor, fora do bundle.
  let apiRows: EvoHistoryRow[] = [];
  try {
    const r = await fetch('/api/history');
    if (r.ok) {
      const j = await r.json();
      if (j?.enabled && Array.isArray(j.rows)) apiRows = j.rows as EvoHistoryRow[];
    }
  } catch { /* backend fora do ar (ex.: dev sem o server local) → usa só o fallback */ }

  // 2) Tabela gb_evo_history (NocoDB cloud) — fallback completo e fonte das VENDAS,
  //    que não existem na tabela de Membros.
  let nocoRows: EvoHistoryRow[] = [];
  if (isHistoryEnabled()) {
    try {
      const data = await nocoGet<EvoHistoryRow>(
        TABLES.evoHistory,
        `?where=(period_kind,eq,monthly)&sort=snapshot_month&limit=${limit}`,
      );
      nocoRows = data?.list ?? [];
    } catch (e) {
      console.warn('[evoHistory] fetchAllEvoHistoryMonthly falhou:', e);
    }
  }

  if (apiRows.length === 0) { await overrideVendasFromRealSource(nocoRows); return nocoRows; }

  // Merge: métricas de MEMBROS vêm da fonte nova; vendas_qtd/vendas_valor da
  // antiga. Mês×unidade que só existe na antiga entra inteiro (união).
  // Chave por NOME NORMALIZADO: a fonte nova grava o nome oficial e a antiga
  // pode ter nome sujo ("GAVIOES - BELENZINHO"); sem normalizar elas nao casavam
  // -> viravam DUAS linhas e, com o filtro tolerante, dobravam os ativos.
  const rowKey = (r: EvoHistoryRow) => `${normBranch(r.branch_name)}|${r.snapshot_month}`;
  const byKey = new Map(apiRows.map(r => [rowKey(r), r]));
  for (const old of nocoRows) {
    const cur = byKey.get(rowKey(old));
    if (cur) {
      cur.vendas_qtd   = Number(old.vendas_qtd)   || 0;
      cur.vendas_valor = Number(old.vendas_valor) || 0;
    } else {
      byKey.set(rowKey(old), old);
    }
  }
  const merged = [...byKey.values()].sort((a, b) => a.snapshot_month.localeCompare(b.snapshot_month));
  await overrideVendasFromRealSource(merged);
  return merged;
}

/** Payload para upsert (mesmas props de EvoHistoryRow exceto Id/fetched_at). */
export interface EvoHistoryUpsertInput {
  branch_name: string;
  snapshot_month: string;
  period_kind: 'monthly' | 'yearly';
  active_members: number;
  adimplentes: number;
  inadimplentes: number;
  faturamento_adimplentes: number;
  vendas_qtd: number;
  vendas_valor: number;
  source: 'evo_excel' | 'evo_sales' | 'manual';
}

/**
 * Upsert de 1 snapshot (cria se não existe, atualiza se existe).
 * `fetched_at` é setado automaticamente em ISO atual.
 */
export async function upsertEvoHistorySnapshot(
  row: EvoHistoryUpsertInput,
): Promise<void> {
  if (!isHistoryEnabled()) {
    throw new Error('Histórico EVO desabilitado: TABLES.evoHistory está vazio');
  }
  const payload = { ...row, fetched_at: new Date().toISOString() };
  const existing = await fetchEvoHistorySnapshot(row.branch_name, row.snapshot_month, row.period_kind);
  if (existing?.Id) {
    await nocoPatch(TABLES.evoHistory, { Id: existing.Id, ...payload });
  } else {
    await nocoPost(TABLES.evoHistory, payload);
  }
}

// ─── Histórico de RECEIVABLES (cobros) ───────────────────────────────────
//
// Tabela `gb_evo_receivables_history` — populada por scripts/seed-receivables.mjs
// que puxa /api/v1/receivables/summary-excel mes a mes pra cada unidade.
// Permite comparativo "Mes passado: ..." e "Ano passado: ..." nos cards do
// Financeiro (Faturamento Real, Multa, Manutencao, Avulso) que hoje so tem
// dado do mes corrente.

export interface EvoReceivablesHistoryRow extends Record<string, unknown> {
  Id?: number;
  branch_name: string;
  snapshot_month: string;             // 'YYYY-MM'
  total_amount: number;
  total_received: number;
  total_pending: number;
  total_overdue: number;
  multa_cancelamento: number;
  manutencao_anual: number;
  avulso: number;
  rows_count: number;
  source?: string;
  fetched_at?: string;
}

/** Detecta se a tabela de receivables histórico está configurada. */
export function isReceivablesHistoryEnabled(): boolean {
  return !!TABLES.evoReceivablesHistory;
}

/** Lê 1 snapshot de receivables (branch + mês). */
export async function fetchReceivablesHistorySnapshot(
  branchName: string,
  snapshotMonth: string,
): Promise<EvoReceivablesHistoryRow | null> {
  if (!isReceivablesHistoryEnabled()) return null;
  try {
    const where = `(branch_name,eq,${encodeURIComponent(branchName)})~and(snapshot_month,eq,${encodeURIComponent(snapshotMonth)})`;
    const data = await nocoGet<EvoReceivablesHistoryRow>(TABLES.evoReceivablesHistory, `?where=${where}&limit=1`);
    return data?.list?.[0] ?? null;
  } catch (e) {
    console.warn('[evoReceivablesHistory] fetch falhou:', e);
    return null;
  }
}

// Cache de sessão do /api/history-recebimentos (Recebimentos self-hosted
// agregados pelo mini-backend). Busca 1x; meses fechados não mudam.
interface RecebRow {
  branch_name: string;
  snapshot_month: string;
  total_amount: number;
  total_received: number;
  total_pending: number;
  pagantes?: number;     // clientes distintos com recebimento no mês
  rows_count: number;
}
let _recebRowsCache: RecebRow[] | null = null;
// Cache de sessão da tabela CLOUD gb_evo_receivables_history (meses fechados
// não mudam): 1 fetch por sessão, agregações seguintes são filtro em memória.
let _recebCloudCache: EvoReceivablesHistoryRow[] | null = null;
let _recebCloudInflight: Promise<EvoReceivablesHistoryRow[]> | null = null;
async function fetchCloudRecebRows(): Promise<EvoReceivablesHistoryRow[]> {
  if (_recebCloudCache) return _recebCloudCache;
  if (!_recebCloudInflight) {
    _recebCloudInflight = (async () => {
      try {
        const data = await nocoGet<EvoReceivablesHistoryRow>(TABLES.evoReceivablesHistory, '?limit=1000');
        return data?.list ?? [];
      } catch (e) {
        console.warn('[evoReceivablesHistory] fetch falhou:', e);
        return [];
      } finally {
        _recebCloudInflight = null;
      }
    })();
    _recebCloudInflight.then(rows => { _recebCloudCache = rows; });
  }
  return _recebCloudInflight;
}
let _recebInflight: Promise<RecebRow[]> | null = null;
async function fetchRecebimentosRows(): Promise<RecebRow[]> {
  if (_recebRowsCache) return _recebRowsCache;
  if (!_recebInflight) {
    _recebInflight = (async () => {
      try {
        const r = await fetch('/api/history-recebimentos');
        if (!r.ok) return [];
        const j = await r.json();
        return (j?.enabled && Array.isArray(j.rows)) ? (j.rows as RecebRow[]) : [];
      } catch {
        return []; // backend fora do ar (dev sem server local) → fallback
      } finally {
        _recebInflight = null;
      }
    })();
    _recebInflight.then(rows => { _recebRowsCache = rows; });
  }
  return _recebInflight;
}

/** Soma agregada de receivables pra um mês (todas as unidades visíveis). */
export async function fetchReceivablesHistoryAggregate(
  snapshotMonth: string,
  allowedBranches?: string[],
): Promise<{
  total_amount: number;
  total_received: number;
  multa_cancelamento: number;
  manutencao_anual: number;
  avulso: number;
  pagantes: number;
  lancamentos: number;
  hasData: boolean;
}> {
  const empty = {
    total_amount: 0, total_received: 0,
    multa_cancelamento: 0, manutencao_anual: 0, avulso: 0,
    pagantes: 0, lancamentos: 0,
    hasData: false,
  };

  // 1) Fonte preferida: tabela Recebimentos (self-hosted) agregada pelo
  //    mini-backend — total lançado/recebido REAIS por unidade × competência.
  const apiRows = (await fetchRecebimentosRows()).filter(r =>
    r.snapshot_month === snapshotMonth &&
    (!allowedBranches || allowedBranches.includes(r.branch_name)),
  );

  // 2) Tabela gb_evo_receivables_history (cloud) — fallback completo e única
  //    fonte das categorias (multa/manutenção/avulso), que não dá pra derivar
  //    com segurança da tabela de Recebimentos.
  let cloud = empty;
  if (isReceivablesHistoryEnabled()) {
    {
      const all = await fetchCloudRecebRows(); // cache de sessão — sem refetch
      const rows = all.filter(r =>
        String(r.snapshot_month) === snapshotMonth &&
        (!allowedBranches || allowedBranches.includes(String(r.branch_name)))
      );
      if (rows.length > 0) {
        cloud = {
          total_amount:       rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0),
          total_received:     rows.reduce((s, r) => s + (Number(r.total_received) || 0), 0),
          multa_cancelamento: rows.reduce((s, r) => s + (Number(r.multa_cancelamento) || 0), 0),
          manutencao_anual:   rows.reduce((s, r) => s + (Number(r.manutencao_anual) || 0), 0),
          avulso:             rows.reduce((s, r) => s + (Number(r.avulso) || 0), 0),
          pagantes:           0, // tabela cloud não tem pagantes distintos
          lancamentos:        rows.reduce((s, r) => s + (Number(r.rows_count) || 0), 0),
          hasData:            true,
        };
      }
    }
  }

  if (apiRows.length === 0) return cloud;
  return {
    total_amount:       apiRows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0),
    total_received:     apiRows.reduce((s, r) => s + (Number(r.total_received) || 0), 0),
    multa_cancelamento: cloud.multa_cancelamento,
    manutencao_anual:   cloud.manutencao_anual,
    avulso:             cloud.avulso,
    pagantes:           apiRows.reduce((s, r) => s + (Number(r.pagantes) || 0), 0),
    lancamentos:        apiRows.reduce((s, r) => s + (Number(r.rows_count) || 0), 0),
    hasData:            true,
  };
}

// ─── Comercial Diário (aulas experimentais por unidade) ──────────────────────
//
// Métricas que o gestor de loja preenche manualmente todo dia:
//   agendados, confirmados, compareceram, faltaram, fecharam, reagendados.
// Identidade lógica: (branch_name, snapshot_date) → upsert manual.

export interface ComercialDiarioRow extends Record<string, unknown> {
  Id?: number;
  branch_name: string;
  snapshot_date: string;          // YYYY-MM-DD
  agendados: number;
  confirmados: number;
  compareceram: number;
  faltaram: number;
  fecharam: number;
  reagendados: number;
  notes?: string;
  updated_by?: string;
  updated_at?: string;
}

/** Lista todos os registros do comercial pra uma data específica (todas unidades). */
export async function fetchComercialDoDia(snapshotDate: string): Promise<ComercialDiarioRow[]> {
  if (!TABLES.comercialDiario) return [];
  try {
    const where = `(snapshot_date,eq,${encodeURIComponent(snapshotDate)})`;
    const data = await nocoGet<ComercialDiarioRow>(TABLES.comercialDiario, `?where=${where}&limit=200`);
    return data?.list ?? [];
  } catch (e) {
    console.warn('[comercialDiario] fetch falhou:', e);
    return [];
  }
}

/** Lista um intervalo de datas pra agregações em painéis. */
export async function fetchComercialRange(dateFrom: string, dateTo: string): Promise<ComercialDiarioRow[]> {
  if (!TABLES.comercialDiario) return [];
  try {
    const where = `(snapshot_date,ge,${encodeURIComponent(dateFrom)})~and(snapshot_date,le,${encodeURIComponent(dateTo)})`;
    const data = await nocoGet<ComercialDiarioRow>(TABLES.comercialDiario, `?where=${where}&limit=1000&sort=-snapshot_date`);
    return data?.list ?? [];
  } catch (e) {
    console.warn('[comercialDiario] range falhou:', e);
    return [];
  }
}

/** Payload de upsert (sem index signature, propriedades concretas). */
export interface ComercialDiarioInput {
  branch_name: string;
  snapshot_date: string;
  agendados: number;
  confirmados: number;
  compareceram: number;
  faltaram: number;
  fecharam: number;
  reagendados: number;
  notes?: string;
  updated_by?: string;
}

/** Upsert: se existe registro pra (branch, date) atualiza, senão cria. */
export async function upsertComercialDiario(
  row: ComercialDiarioInput,
): Promise<void> {
  if (!TABLES.comercialDiario) throw new Error('Tabela comercialDiario não configurada');
  const payload = { ...row, updated_at: new Date().toISOString() };
  // Find existing
  const where = `(branch_name,eq,${encodeURIComponent(row.branch_name)})~and(snapshot_date,eq,${encodeURIComponent(row.snapshot_date)})`;
  const existing = await nocoGet<ComercialDiarioRow>(TABLES.comercialDiario, `?where=${where}&limit=1`);
  const found = existing?.list?.[0];
  if (found?.Id) {
    await nocoPatch(TABLES.comercialDiario, { Id: found.Id, ...payload });
  } else {
    await nocoPost(TABLES.comercialDiario, payload);
  }
}

// ─── Aulas Experimentais (EVO) por intervalo — lê a tabela ExperimentalEvo ────
// O servidor varre a EVO e grava 1 linha por unidade×dia (regra do Passo 5:
// idProspect preenchido & idMember nulo). Aqui o cliente só LÊ (zero 429).
export interface ComercialExpUnit {
  agendados: number;
  compareceram: number;
  faltaram: number;
  reagendados: number;
  dias: number;        // dias com linha gravada no intervalo
  completos: number;   // dias cuja varredura terminou sem falha
}
export interface ComercialExpRange {
  enabled: boolean;                              // false = backend de histórico não configurado
  byUnit: Record<string, ComercialExpUnit>;
  backfilling: boolean;                          // true = servidor varrendo o mês em background
}
export interface ComercialExpStatus {
  running: boolean;
  month: string;
  total: number;
  done: number;
  unidade: string;
}

/** Lê o agregado de aulas experimentais por unidade no intervalo [from,to] (YYYY-MM-DD). */
export async function fetchComercialExpRange(from: string, to: string): Promise<ComercialExpRange | null> {
  try {
    const r = await fetch(`/api/comercial-exp-range?from=${from}&to=${to}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.enabled) return { enabled: false, byUnit: {}, backfilling: false };
    return { enabled: true, byUnit: (j.byUnit ?? {}) as Record<string, ComercialExpUnit>, backfilling: !!j.backfilling };
  } catch {
    return null;
  }
}

/** Dispara o recálculo (varredura EVO) de um mês YYYY-MM no servidor. force re-escaneia tudo. */
export async function triggerComercialExpBackfill(month: string, force = false): Promise<void> {
  try {
    await fetch('/api/comercial-exp-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month, force }),
    });
  } catch { /* melhor esforço */ }
}

/** Progresso do recálculo em andamento (poll). */
export async function fetchComercialExpStatus(): Promise<ComercialExpStatus | null> {
  try {
    const r = await fetch('/api/comercial-exp-backfill/status');
    if (!r.ok) return null;
    return (await r.json()) as ComercialExpStatus;
  } catch {
    return null;
  }
}
