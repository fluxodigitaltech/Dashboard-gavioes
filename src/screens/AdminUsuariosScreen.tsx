import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Save, RefreshCw, Shield, Search, X, EyeOff, Eye,
  Users as UsersIcon, Lock, Mail, ToggleLeft, ToggleRight,
  CheckCircle2, AlertCircle, Sparkles, Grid3x3, Trash2, BookmarkPlus,
  DollarSign, FileText, Activity, Download, Target,
  MousePointerClick, AlertTriangle, ShoppingBag, TrendingDown, UserX, IdCard, LineChart, Send,
} from 'lucide-react';
import { sendInvite } from '../services/inviteApi';
import {
  fetchAllUsers,
  updateUserPermissions,
  createNewUser,
  deleteUser,
  parseCellPermissions,
  serializeCellPermissions,
  deriveCellPermissionsFromLegacy,
  fetchRoleTemplates,
  createRoleTemplate,
  deleteRoleTemplate,
  getSession,
  isAdmin,
  type GbUserRecord,
  type GbUser,
  type CellPermissions,
  type RoleTemplate,
} from '../services/nocodbApi';
import { UNITS } from '../services/evoApi';

// ─── Configuração ────────────────────────────────────────────────────────────
const ALL_PAGES: { id: string; label: string }[] = [
  { id: 'dashboard',   label: 'Painel' },
  { id: 'unidades',    label: 'Unidades' },
  { id: 'planos',      label: 'Planos' },
  { id: 'financeiro',  label: 'Financeiro' },
  { id: 'metas',       label: 'Metas' },
  { id: 'agregadores', label: 'Agregadores' },
  { id: 'campanhas',   label: 'Marketing' },
  { id: 'leads',       label: 'Leads' },
  { id: 'kpis',        label: 'KPIs' },
  { id: 'comercial',   label: 'Comercial' },
  { id: 'ocupacao',    label: 'Ocupação' },
];

const ALL_UNITS = Object.keys(UNITS);
const ALL_PAGE_IDS = ALL_PAGES.map(p => p.id);
const TOTAL_CELLS = ALL_UNITS.length * ALL_PAGE_IDS.length;

// ─── Helpers da Matriz Página×Unidade ────────────────────────────────────────
// Estado interno do form trabalha com forma EXPANDIDA (sem wildcards) por simplicidade
// Compacta pra CellPermissions só na hora de salvar.
type ExpandedMatrix = Record<string, string[]>;

function expandMatrix(compact: CellPermissions): ExpandedMatrix {
  const result: ExpandedMatrix = {};
  for (const u of ALL_UNITS) result[u] = [];
  const wildcardPages = compact['*'];
  if (wildcardPages) {
    for (const u of ALL_UNITS) {
      const expanded = wildcardPages.includes('*') ? ALL_PAGE_IDS : wildcardPages;
      result[u] = Array.from(new Set([...result[u], ...expanded]));
    }
  }
  for (const u of ALL_UNITS) {
    const pages = compact[u];
    if (pages) {
      const expanded = pages.includes('*') ? ALL_PAGE_IDS : pages;
      result[u] = Array.from(new Set([...result[u], ...expanded]));
    }
  }
  return result;
}

function compactMatrix(expanded: ExpandedMatrix): CellPermissions {
  const sigs = ALL_UNITS.map(u => JSON.stringify([...(expanded[u] ?? [])].sort()));
  const allSame = sigs.every(s => s === sigs[0]);
  if (allSame) {
    const pages = expanded[ALL_UNITS[0]] ?? [];
    if (pages.length === 0) return {};
    if (pages.length === ALL_PAGE_IDS.length) return { '*': ['*'] };
    return { '*': [...pages] };
  }
  const result: CellPermissions = {};
  for (const u of ALL_UNITS) {
    const pages = expanded[u] ?? [];
    if (pages.length === 0) continue;
    if (pages.length === ALL_PAGE_IDS.length) result[u] = ['*'];
    else result[u] = [...pages];
  }
  return result;
}

function isCellChecked(matrix: ExpandedMatrix, unit: string, page: string): boolean {
  return matrix[unit]?.includes(page) ?? false;
}

function toggleCell(matrix: ExpandedMatrix, unit: string, page: string): ExpandedMatrix {
  const next = { ...matrix };
  const current = next[unit] ?? [];
  next[unit] = current.includes(page) ? current.filter(p => p !== page) : [...current, page];
  return next;
}

function toggleRow(matrix: ExpandedMatrix, page: string): ExpandedMatrix {
  const allChecked = ALL_UNITS.every(u => matrix[u]?.includes(page));
  const next: ExpandedMatrix = {};
  for (const u of ALL_UNITS) {
    const current = matrix[u] ?? [];
    next[u] = allChecked
      ? current.filter(p => p !== page)
      : (current.includes(page) ? current : [...current, page]);
  }
  return next;
}

function toggleColumn(matrix: ExpandedMatrix, unit: string): ExpandedMatrix {
  const current = matrix[unit] ?? [];
  const allChecked = ALL_PAGE_IDS.every(p => current.includes(p));
  const next = { ...matrix };
  next[unit] = allChecked ? [] : [...ALL_PAGE_IDS];
  return next;
}

function setAllCells(checked: boolean): ExpandedMatrix {
  const result: ExpandedMatrix = {};
  for (const u of ALL_UNITS) result[u] = checked ? [...ALL_PAGE_IDS] : [];
  return result;
}

function countChecked(matrix: ExpandedMatrix): number {
  return Object.values(matrix).reduce((s, pages) => s + pages.length, 0);
}

function diffCount(a: ExpandedMatrix, b: ExpandedMatrix): number {
  let diff = 0;
  for (const u of ALL_UNITS) {
    for (const p of ALL_PAGE_IDS) {
      const inA = a[u]?.includes(p) ?? false;
      const inB = b[u]?.includes(p) ?? false;
      if (inA !== inB) diff++;
    }
  }
  return diff;
}

/** Converte preset legado em matriz expandida */
function presetToMatrix(p: { allPages: boolean; pages: string[]; allUnits: boolean; units: string[] }): ExpandedMatrix {
  const targetUnits = p.allUnits ? ALL_UNITS : p.units;
  const targetPages = p.allPages ? ALL_PAGE_IDS : p.pages;
  const matrix: ExpandedMatrix = {};
  for (const u of ALL_UNITS) {
    matrix[u] = targetUnits.includes(u) ? [...targetPages] : [];
  }
  return matrix;
}

// ─── Quick Presets (atalhos contextuais pra padrões comuns) ──────────────────
// Aplicam um padrão na matriz inteira (em todas as unidades). Pra restringir
// unidades depois, usar os toggles de coluna.
const QUICK_PRESETS: { label: string; description: string; pages: string[] }[] = [
  { label: 'Só leitura',     description: 'Apenas Painel + KPIs em todas as unidades',            pages: ['dashboard', 'kpis'] },
  { label: 'Operacional',    description: 'Painel, Unidades, Agregadores (sem dados financeiros)', pages: ['dashboard', 'unidades', 'agregadores'] },
  { label: 'Sem financeiro', description: 'Tudo menos a página Financeiro',                       pages: ALL_PAGE_IDS.filter(p => p !== 'financeiro') },
  { label: 'Marketing only', description: 'Apenas a aba de Marketing/Campanhas',                  pages: ['campanhas'] },
];

/** Aplica um quick preset em todas as unidades de uma vez */
function applyQuickPreset(pages: string[]): ExpandedMatrix {
  const matrix: ExpandedMatrix = {};
  for (const u of ALL_UNITS) matrix[u] = [...pages];
  return matrix;
}

interface RoleConfig {
  value: string;
  label: string;
  description: string;
  pillClass: string;       // texto + bg do badge na lista
  preset: { allPages: boolean; pages: string[]; allUnits: boolean; units: string[] };
  customMatrix?: ExpandedMatrix; // só pra templates customizados (sobrescreve preset)
  customId?: number;             // ID no NocoDB/localStorage pra deletar
}

const ROLES: RoleConfig[] = [
  {
    value: 'admin',
    label: 'Administrador',
    description: 'Acesso total · gerencia usuários',
    pillClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    preset: { allPages: true, pages: ALL_PAGES.map(p => p.id), allUnits: true, units: ALL_UNITS },
  },
  {
    value: 'gerente',
    label: 'Gerente',
    description: 'Vê tudo nas unidades atribuídas',
    pillClass: 'bg-amber-50 text-amber-700 border-amber-200',
    preset: { allPages: true, pages: ALL_PAGES.map(p => p.id), allUnits: false, units: [] },
  },
  {
    value: 'regional',
    label: 'Regional',
    description: 'Coordena várias unidades · acesso amplo',
    pillClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    preset: { allPages: true, pages: ALL_PAGES.map(p => p.id), allUnits: false, units: [] },
  },
  {
    value: 'socio_cotista',
    label: 'Sócio Cotista',
    description: 'Painel · Financeiro · Metas · KPIs (sem operação)',
    pillClass: 'bg-purple-50 text-purple-700 border-purple-200',
    preset: { allPages: false, pages: ['dashboard', 'financeiro', 'metas', 'kpis'], allUnits: true, units: ALL_UNITS },
  },
  {
    value: 'coord_vendas',
    label: 'Coord. Vendas',
    description: 'Painel · Comercial · Unidades · Metas · Marketing · Agregadores',
    pillClass: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    preset: { allPages: false, pages: ['dashboard', 'unidades', 'metas', 'campanhas', 'agregadores', 'comercial'], allUnits: false, units: [] },
  },
  {
    value: 'consultor',
    label: 'Consultor de Vendas',
    description: 'Painel · Comercial · Unidades · Financeiro · KPIs (edita Comercial)',
    pillClass: 'bg-blue-50 text-blue-700 border-blue-200',
    preset: { allPages: false, pages: ['dashboard', 'unidades', 'financeiro', 'kpis', 'comercial'], allUnits: false, units: [] },
  },
  {
    value: 'viewer',
    label: 'Visualizador',
    description: 'Apenas Painel e KPIs',
    pillClass: 'bg-slate-100 text-slate-600 border-slate-200',
    preset: { allPages: false, pages: ['dashboard', 'kpis'], allUnits: false, units: [] },
  },
];

// Fallback = último role (sempre o mais restrito = Visualizador), independente da quantidade.
function roleOf(role: string): RoleConfig { return ROLES.find(r => r.value === role) ?? ROLES[ROLES.length - 1]; }

// ─── Helpers de serialização ─────────────────────────────────────────────────
function parseList(val: string | undefined, allItems: string[]): { items: string[]; all: boolean } {
  if (!val || val === 'all') return { items: allItems, all: true };
  const items = val.split(',').map(s => s.trim()).filter(Boolean);
  return { items, all: false };
}

// ─── Estado do formulário (criar/editar) ─────────────────────────────────────
interface FormState {
  mode: 'create' | 'edit';
  id?: number;
  email: string;
  originalEmail?: string;        // e-mail antes da edição — pra detectar troca e disparar convite
  name: string;
  role: string;
  active: boolean;
  password: string;
  confirmPassword: string;
  matrix: ExpandedMatrix;
  showVendasValor: boolean;
  pdfFaturamentoEstimado: boolean;
  showTaxaOcupacao: boolean;
  canDownloadPdf: boolean;
  canEditMetas: boolean;
  // Visibilidade ao clicar nos cards (drill-down)
  canSeeInadimplentes: boolean;
  canSeeVendasDetalhe: boolean;
  canSeeFinanceiroDetalhe: boolean;
  canSeeReceitaRisco: boolean;
  canSeeEvasao: boolean;
  canSeeClienteNome: boolean;
  canSeeTendencia: boolean;
  canSeeTendenciaFaturamento: boolean;
  canSeeMetaRegional: boolean;
  sendInviteOnCreate: boolean;   // criar sem senha e mandar convite por e-mail
}

function emptyForm(): FormState {
  const preset = ROLES[3].preset;
  return {
    mode: 'create',
    email: '', name: '', role: 'viewer', active: true,
    password: '', confirmPassword: '',
    matrix: presetToMatrix(preset),
    showVendasValor: true,
    pdfFaturamentoEstimado: true,
    showTaxaOcupacao: true,
    canDownloadPdf: true,
    canEditMetas: false,
    canSeeInadimplentes: true,
    canSeeVendasDetalhe: true,
    canSeeFinanceiroDetalhe: true,
    canSeeReceitaRisco: true,
    canSeeEvasao: true,
    canSeeClienteNome: true,
    canSeeTendencia: true,
    canSeeTendenciaFaturamento: true,
    canSeeMetaRegional: false,
    sendInviteOnCreate: false,
  };
}

function fromUser(u: GbUserRecord): FormState {
  // Se cell_permissions existir, usa ela; senão deriva do modo legado
  const compact = parseCellPermissions(u.cell_permissions)
    ?? deriveCellPermissionsFromLegacy(u as unknown as GbUser);
  return {
    mode: 'edit',
    id: u.Id,
    email: u.email,
    originalEmail: u.email,
    name: u.name,
    role: u.role,
    active: u.active ?? true,
    password: '', confirmPassword: '',
    matrix: expandMatrix(compact),
    showVendasValor: u.show_vendas_valor ?? true,
    pdfFaturamentoEstimado: u.pdf_faturamento_estimado ?? true,
    showTaxaOcupacao: u.show_taxa_ocupacao ?? true,
    canDownloadPdf: u.can_download_pdf ?? true,
    canEditMetas: u.can_edit_metas ?? false,
    canSeeInadimplentes: u.can_see_inadimplentes ?? true,
    canSeeVendasDetalhe: u.can_see_vendas_detalhe ?? true,
    canSeeFinanceiroDetalhe: u.can_see_financeiro_detalhe ?? true,
    canSeeReceitaRisco: u.can_see_receita_risco ?? true,
    canSeeEvasao: u.can_see_evasao ?? true,
    canSeeClienteNome: u.can_see_cliente_nome ?? true,
    canSeeTendencia: u.can_see_tendencia ?? true,
    canSeeTendenciaFaturamento: u.can_see_tendencia_faturamento ?? true,
    canSeeMetaRegional: u.can_see_meta_regional ?? false,
    sendInviteOnCreate: false,
  };
}

// ═════════════════════════════════════════════════════════════════════════════

export function AdminUsuariosScreen() {
  const [users, setUsers]     = useState<GbUserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [search, setSearch]   = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('todos');
  const [form, setForm]       = useState<FormState | null>(null);
  const [saving, setSaving]   = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  // Modal de confirmação de exclusão
  const [userToDelete, setUserToDelete] = useState<GbUserRecord | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Convite por e-mail (reenvio pra usuário existente)
  const [invitingId, setInvitingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const currentSessionEmail = (() => {
    const s = getSession();
    return s?.email?.toLowerCase() ?? '';
  })();
  // Só admin pode trocar o e-mail de um usuário já existente.
  const sessionIsAdmin = (() => {
    const s = getSession();
    return s ? isAdmin(s) : false;
  })();
  const [customTemplates, setCustomTemplates] = useState<RoleTemplate[]>([]);

  async function loadCustomTemplates() {
    try { setCustomTemplates(await fetchRoleTemplates()); }
    catch (e) { console.error('[Templates] fetch error:', e); }
  }
  // queueMicrotask difere o setState interno pra fora do body do effect.
  useEffect(() => { queueMicrotask(() => { loadCustomTemplates(); }); }, []);

  // Combina ROLES hardcoded + templates customizados (NocoDB ou localStorage)
  const effectiveRoles: RoleConfig[] = useMemo(() => {
    const customAsConfig: RoleConfig[] = customTemplates.map(t => {
      const perms = parseCellPermissions(t.cell_permissions) ?? {};
      // Deriva preset legado a partir da matriz pra retrocompat
      return {
        value: `custom_${t.Id ?? t.name}`,
        label: t.name,
        description: t.description || 'Template customizado',
        pillClass: 'bg-violet-50 text-violet-700 border-violet-200',
        preset: { allPages: false, pages: [], allUnits: false, units: [] },
        customMatrix: expandMatrix(perms),
        customId: t.Id,
      };
    });
    return [...ROLES, ...customAsConfig];
  }, [customTemplates]);

  async function handleSaveAsTemplate(name: string, description: string) {
    if (!form) return;
    const compact = compactMatrix(form.matrix);
    await createRoleTemplate({
      name,
      description,
      cell_permissions: serializeCellPermissions(compact),
      is_default: false,
    });
    await loadCustomTemplates();
  }

  async function handleDeleteTemplate(id: number) {
    if (!confirm('Excluir esse template? Usuários que usam ele não são afetados, mas o template some da lista.')) return;
    await deleteRoleTemplate(id);
    await loadCustomTemplates();
  }

  async function loadUsers() {
    setLoading(true); setError(null);
    try {
      const list = await fetchAllUsers();
      setUsers(list);
    } catch (e) {
      setError('Erro ao carregar usuários do NocoDB.');
      console.error('[Usuarios] fetch error:', e);
    } finally {
      setLoading(false);
    }
  }
  // queueMicrotask difere o setLoading(true) interno pra fora do body do effect.
  useEffect(() => { queueMicrotask(() => { loadUsers(); }); }, []);

  // ── Filtragem ──
  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter(u => {
      if (roleFilter !== 'todos' && u.role !== roleFilter) return false;
      if (!q) return true;
      return (u.name ?? '').toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q);
    });
  }, [users, search, roleFilter]);

  // ── Toggle ativo direto ──
  async function handleToggleActive(user: GbUserRecord) {
    setTogglingId(user.Id);
    try {
      await updateUserPermissions(user.Id, { active: !user.active });
      setUsers(prev => prev.map(u => u.Id === user.Id ? { ...u, active: !u.active } : u));
    } catch (e) {
      console.error('[Usuarios] toggle active error:', e);
    } finally {
      setTogglingId(null);
    }
  }

  // ── Excluir usuário (após confirmação no modal) ──
  // Hard delete no NocoDB. Pra desativar sem perder histórico, use o toggle.
  // Proteção: admin atual não pode se auto-excluir (validação UI antes do click).
  async function handleConfirmDelete() {
    if (!userToDelete) return;
    setDeletingId(userToDelete.Id);
    try {
      await deleteUser(userToDelete.Id);
      setUsers(prev => prev.filter(u => u.Id !== userToDelete.Id));
      setUserToDelete(null);
    } catch (e) {
      console.error('[Usuarios] delete error:', e);
      setError('Falha ao excluir usuário. Tente novamente.');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Reenviar convite por e-mail pra um usuário existente ──
  async function handleInvite(user: GbUserRecord) {
    setInvitingId(user.Id);
    setError(null); setNotice(null);
    try {
      await sendInvite(user.email);
      setNotice(`Convite enviado para ${user.email}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao enviar convite.');
    } finally {
      setInvitingId(null);
    }
  }

  // ── Salvar form (create/update) ──
  async function handleSubmit() {
    if (!form) return;
    if (!form.name.trim() || !form.email.trim()) { setError('Nome e e-mail são obrigatórios.'); return; }
    if (form.mode === 'create' && !form.sendInviteOnCreate) {
      if (!form.password || form.password.length < 8) { setError('Senha mínima de 8 caracteres.'); return; }
      if (form.password !== form.confirmPassword) { setError('Senhas não conferem.'); return; }
    }

    setSaving(true); setError(null);
    try {
      // Compacta a matriz pra cell_permissions (fonte de verdade)
      const compact = compactMatrix(form.matrix);
      const cell_permissions = serializeCellPermissions(compact);
      // Deriva allowed_pages/units pra retrocompat (união de tudo que está marcado)
      const activeUnits = ALL_UNITS.filter(u => (form.matrix[u]?.length ?? 0) > 0);
      const activePagesSet = new Set<string>();
      for (const u of ALL_UNITS) for (const p of (form.matrix[u] ?? [])) activePagesSet.add(p);
      const allowed_pages = activePagesSet.size === ALL_PAGE_IDS.length
        ? 'all'
        : Array.from(activePagesSet).join(',');
      const allowed_units = activeUnits.length === ALL_UNITS.length
        ? 'all'
        : activeUnits.join(',');

      if (form.mode === 'create') {
        // Modo convite: cria com senha aleatória descartável (a pessoa define a
        // dela pelo link do e-mail) e dispara o convite logo após criar.
        const pwd = form.sendInviteOnCreate ? crypto.randomUUID() : form.password;
        await createNewUser({
          email: form.email.trim(),
          name:  form.name.trim(),
          role:  form.role,
          password: pwd,
          allowed_pages,
          allowed_units,
          cell_permissions,
          show_vendas_valor: form.showVendasValor,
          pdf_faturamento_estimado: form.pdfFaturamentoEstimado,
          show_taxa_ocupacao: form.showTaxaOcupacao,
          can_download_pdf: form.canDownloadPdf,
          can_edit_metas: form.canEditMetas,
          can_see_inadimplentes: form.canSeeInadimplentes,
          can_see_vendas_detalhe: form.canSeeVendasDetalhe,
          can_see_financeiro_detalhe: form.canSeeFinanceiroDetalhe,
          can_see_receita_risco: form.canSeeReceitaRisco,
          can_see_evasao: form.canSeeEvasao,
          can_see_cliente_nome: form.canSeeClienteNome,
          can_see_tendencia: form.canSeeTendencia,
          can_see_tendencia_faturamento: form.canSeeTendenciaFaturamento,
          can_see_meta_regional: form.canSeeMetaRegional,
        });
        // Dispara o convite por e-mail (pessoa define a própria senha).
        if (form.sendInviteOnCreate) {
          await sendInvite(form.email.trim());
        }
      } else if (form.id) {
        // Só admin pode trocar o e-mail. Detecta a mudança pra disparar convite depois.
        const newEmail = form.email.trim();
        const emailChanged =
          sessionIsAdmin && newEmail.toLowerCase() !== (form.originalEmail ?? '').toLowerCase();
        await updateUserPermissions(form.id, {
          // Persiste o e-mail só quando admin de fato o alterou (campo travado pros demais).
          ...(emailChanged ? { email: newEmail } : {}),
          name: form.name.trim(),
          role: form.role,
          active: form.active,
          allowed_pages,
          allowed_units,
          cell_permissions,
          show_vendas_valor: form.showVendasValor,
          pdf_faturamento_estimado: form.pdfFaturamentoEstimado,
          show_taxa_ocupacao: form.showTaxaOcupacao,
          can_download_pdf: form.canDownloadPdf,
          can_edit_metas: form.canEditMetas,
          can_see_inadimplentes: form.canSeeInadimplentes,
          can_see_vendas_detalhe: form.canSeeVendasDetalhe,
          can_see_financeiro_detalhe: form.canSeeFinanceiroDetalhe,
          can_see_receita_risco: form.canSeeReceitaRisco,
          can_see_evasao: form.canSeeEvasao,
          can_see_cliente_nome: form.canSeeClienteNome,
          can_see_tendencia: form.canSeeTendencia,
          can_see_tendencia_faturamento: form.canSeeTendenciaFaturamento,
          can_see_meta_regional: form.canSeeMetaRegional,
        });
        // E-mail trocado por um admin: a pessoa precisa revalidar o acesso no novo e-mail.
        if (emailChanged) {
          await sendInvite(newEmail);
          setNotice(`E-mail atualizado. Convite enviado para ${newEmail}`);
        }
      }
      setSavedAt(new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
      setForm(null);
      await loadUsers();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar.');
      console.error('[Usuarios] save error:', e);
    } finally {
      setSaving(false);
    }
  }

  // ── Aplicar template do role (sobrescreve checkboxes) ──
  function applyRoleTemplate(role: string) {
    if (!form) return;
    const config = effectiveRoles.find(r => r.value === role) ?? roleOf(role);
    const matrix = config.customMatrix ?? presetToMatrix(config.preset);
    setForm({ ...form, role, matrix });
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* ── Header ── */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="mb-10">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">
          Administração
        </span>
        <div className="flex items-end justify-between flex-wrap gap-6">
          <div>
            <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
              Gestão de <span className="text-accent">Usuários</span>
            </h1>
            <p className="text-slate-400 text-[15px] font-semibold max-w-xl">
              Defina o que cada usuário pode ver — páginas, unidades e função (template).
            </p>
          </div>
          <div className="flex items-center gap-3">
            {notice && (
              <span className="flex items-center gap-1.5 text-[12px] font-bold text-emerald-600">
                <Send size={14} /> {notice}
              </span>
            )}
            {savedAt && !notice && (
              <span className="flex items-center gap-1.5 text-[12px] font-bold text-emerald-600">
                <CheckCircle2 size={14} /> Salvo às {savedAt}
              </span>
            )}
            <button
              onClick={loadUsers}
              disabled={loading}
              className="w-11 h-11 flex items-center justify-center rounded-2xl bg-white border border-slate-100 text-slate-400 hover:text-primary hover:border-primary/20 transition-all disabled:opacity-40"
              title="Recarregar"
            >
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => setForm(emptyForm())}
              className="flex items-center gap-2 px-5 py-3 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[12px] font-black uppercase tracking-wider shadow-[0_8px_25px_rgba(15,60,35,0.2)] transition-all"
            >
              <Plus size={14} /> Novo Usuário
            </button>
          </div>
        </div>
      </motion.div>

      {/* ── Filtros ── */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" strokeWidth={2.5} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nome ou e-mail..."
            className="w-full pl-11 pr-4 py-3 bg-white border border-slate-100 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 text-slate-700"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-black text-slate-400 uppercase tracking-wider">Função:</span>
          {[{ value: 'todos', label: 'Todos' } as RoleConfig | { value: string; label: string }, ...ROLES].map(r => (
            <button
              key={r.value}
              onClick={() => setRoleFilter(r.value)}
              className={`px-3.5 py-1.5 rounded-full text-[11px] font-black transition-all ${
                roleFilter === r.value
                  ? 'bg-primary text-white shadow-[0_4px_12px_rgba(15,60,35,0.2)]'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Erro ── */}
      {error && (
        <div className="flex items-start gap-3 px-5 py-4 mb-6 bg-rose-50 border border-rose-100 rounded-2xl">
          <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          <p className="text-[13px] font-bold text-rose-700">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-rose-400 hover:text-rose-600"><X size={16} /></button>
        </div>
      )}

      {/* ── Lista de usuários ── */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-24 rounded-[1.8rem] bg-slate-100 animate-pulse" />)}
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="py-16 text-center bg-white rounded-[2rem] border border-slate-100">
          <UsersIcon size={36} className="mx-auto text-slate-200 mb-4" />
          <p className="text-slate-400 font-bold">{users.length === 0 ? 'Nenhum usuário cadastrado' : 'Nenhum resultado para o filtro'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredUsers.map(u => {
            const role  = roleOf(u.role);
            const pages = parseList(u.allowed_pages, ALL_PAGES.map(p => p.id));
            const units = parseList(u.allowed_units, ALL_UNITS);
            const pagesLabel = pages.all ? 'Todas as páginas' : `${pages.items.length} ${pages.items.length === 1 ? 'página' : 'páginas'}`;
            const unitsLabel = units.all ? 'Todas as unidades' : `${units.items.length} ${units.items.length === 1 ? 'unidade' : 'unidades'}`;
            const isToggling = togglingId === u.Id;
            return (
              <motion.div
                key={u.Id}
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.25 }}
                className={`flex items-center gap-4 px-5 py-4 bg-white rounded-[1.8rem] border border-slate-100 hover:border-slate-200 hover:shadow-[0_4px_20px_rgba(0,0,0,0.04)] transition-all ${u.active ? '' : 'opacity-60'}`}
              >
                {/* Avatar */}
                <div className="w-12 h-12 rounded-2xl bg-[#fde7e2] flex items-center justify-center shrink-0">
                  <span className="text-[14px] font-black text-primary">
                    {(u.name ?? '?').charAt(0).toUpperCase()}
                  </span>
                </div>

                {/* Nome + email */}
                <div className="flex-1 min-w-0">
                  <p className="font-black text-[#0F172A] text-[14px] truncate">{u.name}</p>
                  <p className="text-[12px] text-slate-400 font-semibold truncate flex items-center gap-1.5">
                    <Mail size={11} /> {u.email}
                  </p>
                </div>

                {/* Badges: role + permissões */}
                <div className="hidden md:flex items-center gap-2 shrink-0">
                  <span className={`px-3 py-1 rounded-full text-[10px] font-black border ${role.pillClass}`}>
                    {role.label}
                  </span>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-black bg-slate-50 text-slate-500 border border-slate-100">
                    {pagesLabel}
                  </span>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-black bg-slate-50 text-slate-500 border border-slate-100">
                    {unitsLabel}
                  </span>
                </div>

                {/* Toggle Ativo/Inativo */}
                <button
                  onClick={() => handleToggleActive(u)}
                  disabled={isToggling}
                  title={u.active ? 'Desativar' : 'Ativar'}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all shrink-0 ${
                    u.active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                  } disabled:opacity-50`}
                >
                  {isToggling ? <RefreshCw size={12} className="animate-spin" /> : u.active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                  {u.active ? 'Ativo' : 'Inativo'}
                </button>

                {/* Convidar por e-mail (envia/reenvia link de definir senha) */}
                <button
                  onClick={() => handleInvite(u)}
                  disabled={invitingId === u.Id}
                  title={`Enviar convite por e-mail para ${u.email}`}
                  className="w-9 h-9 flex items-center justify-center rounded-xl bg-emerald-50/70 hover:bg-emerald-500 hover:text-white text-emerald-600 transition-all shrink-0 disabled:opacity-50"
                >
                  {invitingId === u.Id ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} strokeWidth={2.5} />}
                </button>

                {/* Editar */}
                <button
                  onClick={() => setForm(fromUser(u))}
                  className="px-4 py-2 bg-primary/5 hover:bg-primary hover:text-white text-primary rounded-xl text-[11px] font-black uppercase tracking-wider transition-all shrink-0"
                >
                  Editar
                </button>

                {/* Excluir — protege contra auto-deleção */}
                {u.email?.toLowerCase() !== currentSessionEmail && (
                  <button
                    onClick={() => setUserToDelete(u)}
                    title={`Excluir ${u.name}`}
                    className="w-9 h-9 flex items-center justify-center rounded-xl bg-rose-50/60 hover:bg-rose-500 hover:text-white text-rose-500 transition-all shrink-0"
                  >
                    <Trash2 size={14} strokeWidth={2.5} />
                  </button>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* ── Modal de criar/editar ── */}
      <AnimatePresence>
        {form && (
          <UserFormModal
            form={form}
            setForm={setForm}
            onClose={() => { setForm(null); setError(null); }}
            onSubmit={handleSubmit}
            onApplyTemplate={applyRoleTemplate}
            saving={saving}
            error={error}
            roles={effectiveRoles}
            onSaveAsTemplate={handleSaveAsTemplate}
            onDeleteTemplate={handleDeleteTemplate}
            sessionIsAdmin={sessionIsAdmin}
          />
        )}
      </AnimatePresence>

      {/* ── Modal de confirmação de exclusão ── */}
      <AnimatePresence>
        {userToDelete && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
            onClick={deletingId === null ? () => setUserToDelete(null) : undefined}
          >
            <motion.div
              initial={{ scale: 0.96, y: 8, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.97, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="bg-white rounded-3xl shadow-2xl border border-slate-200/60 w-full max-w-md overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              {/* Header com ícone vermelho */}
              <div className="px-6 pt-6 pb-4 flex items-start gap-4">
                <div className="w-12 h-12 rounded-2xl bg-rose-50 flex items-center justify-center shrink-0">
                  <Trash2 size={20} className="text-rose-500" strokeWidth={2.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-[1.1rem] font-black text-slate-900 leading-tight mb-1">
                    Excluir usuário?
                  </h3>
                  <p className="text-[12px] font-medium text-slate-500 leading-relaxed">
                    Esta ação é <strong className="text-rose-600">permanente</strong> e não pode ser desfeita.
                    Pra desativar mantendo o histórico, use o toggle Ativo/Inativo.
                  </p>
                </div>
              </div>

              {/* Card com info do user */}
              <div className="mx-6 mb-5 px-4 py-3 bg-slate-50/60 border border-slate-100 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#fde7e2] flex items-center justify-center shrink-0">
                    <span className="text-[13px] font-black text-primary">
                      {(userToDelete.name ?? '?').charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-black text-slate-900 truncate">{userToDelete.name}</p>
                    <p className="text-[11px] font-bold text-slate-400 truncate flex items-center gap-1">
                      <Mail size={10} /> {userToDelete.email}
                    </p>
                  </div>
                </div>
              </div>

              {/* Botões */}
              <div className="px-6 pb-6 flex items-center gap-2 justify-end">
                <button
                  onClick={() => setUserToDelete(null)}
                  disabled={deletingId !== null}
                  className="px-5 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-wider text-slate-500 hover:bg-slate-100 transition-colors disabled:opacity-30"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirmDelete}
                  disabled={deletingId !== null}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[11px] font-black uppercase tracking-wider bg-rose-500 hover:bg-rose-600 text-white transition-colors disabled:opacity-50"
                >
                  {deletingId !== null
                    ? <><RefreshCw size={12} className="animate-spin" /> Excluindo...</>
                    : <><Trash2 size={12} /> Excluir definitivamente</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MODAL DE CRIAR/EDITAR
// ═════════════════════════════════════════════════════════════════════════════

interface UserFormModalProps {
  form: FormState;
  setForm: (f: FormState | null) => void;
  onClose: () => void;
  onSubmit: () => void;
  onApplyTemplate: (role: string) => void;
  saving: boolean;
  error: string | null;
  roles: RoleConfig[];
  onSaveAsTemplate: (name: string, description: string) => Promise<void>;
  onDeleteTemplate: (id: number) => Promise<void>;
  sessionIsAdmin: boolean;
}

function UserFormModal({ form, setForm, onClose, onSubmit, onApplyTemplate, saving, error, roles, onSaveAsTemplate, onDeleteTemplate, sessionIsAdmin }: UserFormModalProps) {
  const [showPass, setShowPass] = useState(false);

  // Helpers da matriz inline (todos chamam setForm)
  const updateMatrix = (next: ExpandedMatrix) => setForm({ ...form, matrix: next });
  const checkedCount = countChecked(form.matrix);
  const currentRolePreset = roleOf(form.role).preset;
  const templateMatrix = presetToMatrix(currentRolePreset);
  const modifiedCount = diffCount(form.matrix, templateMatrix);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-[#0F172A]/40 backdrop-blur-sm"
      />

      {/* Modal */}
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 20 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        className="relative w-full max-w-3xl max-h-[90vh] bg-white rounded-[2.5rem] shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header bar */}
        <div className="shrink-0 h-2 bg-gradient-to-r from-[#141414] via-[#141414] to-[#fc3000]" />

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-6 right-6 z-10 w-10 h-10 flex items-center justify-center rounded-xl bg-white/95 text-slate-400 hover:bg-slate-100 hover:text-slate-600 border border-slate-100 shadow-sm transition-all"
        >
          <X size={20} />
        </button>

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto p-8 sm:p-10 pb-4">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center gap-2 text-primary font-black text-[11px] uppercase tracking-[0.2em] mb-3">
              <Shield size={14} /> {form.mode === 'create' ? 'Novo Usuário' : 'Editar Usuário'}
            </div>
            <h2 className="text-[2rem] font-black text-[#0F172A] leading-tight tracking-tighter">
              {form.mode === 'create' ? 'Cadastrar acesso' : form.name || form.email}
            </h2>
          </div>

          {/* SEÇÃO 1: Identidade ─────────────────────────────────────────── */}
          <div className="mb-3 flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
            <UsersIcon size={12} /> Identidade
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-7">
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Nome completo"
              className="px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <div className="flex flex-col gap-1">
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                placeholder="email@exemplo.com"
                disabled={form.mode === 'edit' && !sessionIsAdmin}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
              />
              {form.mode === 'edit' && sessionIsAdmin && form.email.trim().toLowerCase() !== (form.originalEmail ?? '').toLowerCase() && (
                <span className="px-1 text-[11px] font-bold text-amber-600">
                  Ao salvar, um novo convite será enviado para este e-mail.
                </span>
              )}
            </div>
          </div>

          {/* Acesso (só na criação): convite por e-mail OU senha manual */}
          {form.mode === 'create' && (
            <div className="mb-7">
              <div className="mb-3 flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
                <Lock size={12} /> Acesso
              </div>
              {/* Toggle: enviar convite por e-mail */}
              <div className="flex items-center justify-between gap-3 px-5 py-4 bg-[#fde7e2]/50 border border-emerald-100 rounded-2xl mb-3">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 shrink-0 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
                    <Send size={16} />
                  </div>
                  <div>
                    <p className="text-[12px] font-black text-slate-700">Enviar convite por e-mail</p>
                    <p className="text-[11px] font-bold text-slate-400">A pessoa recebe um link e define a própria senha. Você não digita senha nenhuma.</p>
                  </div>
                </div>
                <button
                  onClick={() => setForm({ ...form, sendInviteOnCreate: !form.sendInviteOnCreate })}
                  type="button"
                  className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                    form.sendInviteOnCreate ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                  }`}
                >
                  {form.sendInviteOnCreate ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                  {form.sendInviteOnCreate ? 'Convite' : 'Senha manual'}
                </button>
              </div>

              {/* Campos de senha — só quando NÃO é convite */}
              {!form.sendInviteOnCreate && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="relative">
                    <input
                      type={showPass ? 'text' : 'password'}
                      value={form.password}
                      onChange={e => setForm({ ...form, password: e.target.value })}
                      placeholder="Senha"
                      className="w-full px-4 py-3 pr-11 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <button
                      onClick={() => setShowPass(s => !s)}
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    >
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <input
                    type={showPass ? 'text' : 'password'}
                    value={form.confirmPassword}
                    onChange={e => setForm({ ...form, confirmPassword: e.target.value })}
                    placeholder="Confirmar senha"
                    className="px-4 py-3 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>
              )}
            </div>
          )}

          {/* SEÇÃO 2: Função (template) ────────────────────────────────────── */}
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
              <Sparkles size={12} /> Função · Aplica preset (4 padrão + customizados)
            </span>
            <button
              type="button"
              onClick={async () => {
                const name = window.prompt('Nome do novo template (ex: "Gerente Saúde"):');
                if (!name || !name.trim()) return;
                const description = window.prompt('Descrição curta (opcional):') ?? '';
                try { await onSaveAsTemplate(name.trim(), description.trim()); }
                catch (e) { alert('Erro ao salvar template: ' + (e instanceof Error ? e.message : String(e))); }
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-black bg-violet-50 text-violet-700 hover:bg-violet-100 uppercase tracking-wider transition-all"
              title="Cria um novo template a partir da matriz atual"
            >
              <BookmarkPlus size={12} /> Salvar como template
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-7">
            {roles.map(r => {
              const selected = form.role === r.value;
              const isCustom = r.customId !== undefined;
              return (
                <div
                  key={r.value}
                  className={`group relative text-left p-4 rounded-2xl border-2 transition-all cursor-pointer ${
                    selected
                      ? 'border-primary bg-[#fde7e2]'
                      : isCustom
                      ? 'border-violet-100 bg-violet-50/30 hover:border-violet-200'
                      : 'border-slate-100 bg-white hover:border-slate-200'
                  }`}
                  onClick={() => onApplyTemplate(r.value)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className={`font-black text-[13px] flex items-center gap-1.5 ${selected ? 'text-primary' : isCustom ? 'text-violet-700' : 'text-slate-700'}`}>
                      {isCustom && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[8px] uppercase tracking-wider">custom</span>}
                      {r.label}
                    </span>
                    {selected && <CheckCircle2 size={14} className="text-primary" />}
                  </div>
                  <p className="text-[11px] font-bold text-slate-500">{r.description}</p>
                  {isCustom && r.customId !== undefined && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onDeleteTemplate(r.customId!); }}
                      className="absolute top-2 right-2 w-6 h-6 rounded-lg bg-white/80 text-rose-400 hover:bg-rose-50 hover:text-rose-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all"
                      title="Excluir template"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* SEÇÃO 3: Matriz Página × Unidade ───────────────────────────────── */}
          <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
            <span className="flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
              <Grid3x3 size={12} /> Matriz de Permissões · Página × Unidade
            </span>
            <div className="flex items-center gap-2">
              {modifiedCount > 0 && (
                <button
                  onClick={() => updateMatrix(templateMatrix)}
                  type="button"
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-black bg-amber-50 text-amber-700 hover:bg-amber-100 uppercase tracking-wider transition-all"
                  title={`Reverter pra preset do ${roleOf(form.role).label}`}
                >
                  <RefreshCw size={10} /> {modifiedCount} {modifiedCount === 1 ? 'modificada' : 'modificadas'} · Resetar
                </button>
              )}
              <button
                onClick={() => updateMatrix(setAllCells(checkedCount < TOTAL_CELLS))}
                type="button"
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${
                  checkedCount === TOTAL_CELLS
                    ? 'bg-rose-50 text-rose-600 hover:bg-rose-100'
                    : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                }`}
              >
                {checkedCount === TOTAL_CELLS ? 'Limpar tudo' : 'Marcar tudo'}
              </button>
            </div>
          </div>
          {/* Quick presets — atalhos contextuais que aplicam padrões na matriz inteira */}
          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider mr-1">Atalhos:</span>
            {QUICK_PRESETS.map(qp => (
              <button
                key={qp.label}
                type="button"
                onClick={() => updateMatrix(applyQuickPreset(qp.pages))}
                title={qp.description}
                className="px-2.5 py-1 rounded-lg text-[10px] font-black bg-slate-100 text-slate-600 hover:bg-primary hover:text-white transition-all uppercase tracking-tight"
              >
                {qp.label}
              </button>
            ))}
          </div>
          <div className="border border-slate-100 rounded-2xl overflow-hidden bg-white mb-3">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-slate-50/70">
                    <th className="sticky left-0 z-10 bg-slate-50/70 backdrop-blur p-3 text-left text-[10px] font-black text-slate-400 uppercase tracking-wider min-w-[120px]">
                      Página \ Unidade
                    </th>
                    {ALL_UNITS.map(unit => {
                      const colChecked = ALL_PAGE_IDS.every(p => form.matrix[unit]?.includes(p));
                      const colPartial = !colChecked && ALL_PAGE_IDS.some(p => form.matrix[unit]?.includes(p));
                      return (
                        <th key={unit} className="p-2 text-center min-w-[68px]">
                          <button
                            onClick={() => updateMatrix(toggleColumn(form.matrix, unit))}
                            type="button"
                            title={`Marcar/desmarcar todas as páginas em ${unit}`}
                            className={`block w-full text-[10px] font-black uppercase tracking-tight transition-colors ${
                              colChecked ? 'text-primary' : colPartial ? 'text-amber-600' : 'text-slate-400 hover:text-primary'
                            }`}
                          >
                            {unit}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {ALL_PAGES.map((page, idx) => {
                    const rowChecked = ALL_UNITS.every(u => form.matrix[u]?.includes(page.id));
                    const rowPartial = !rowChecked && ALL_UNITS.some(u => form.matrix[u]?.includes(page.id));
                    return (
                      <tr key={page.id} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}>
                        <td className="sticky left-0 z-10 bg-inherit p-3">
                          <button
                            onClick={() => updateMatrix(toggleRow(form.matrix, page.id))}
                            type="button"
                            title={`Marcar/desmarcar ${page.label} em todas unidades`}
                            className={`text-[12px] font-black w-full text-left transition-colors ${
                              rowChecked ? 'text-primary' : rowPartial ? 'text-amber-700' : 'text-slate-600 hover:text-primary'
                            }`}
                          >
                            {page.label}
                          </button>
                        </td>
                        {ALL_UNITS.map(unit => {
                          const checked = isCellChecked(form.matrix, unit, page.id);
                          return (
                            <td key={`${page.id}-${unit}`} className="p-1.5 text-center">
                              <button
                                onClick={() => updateMatrix(toggleCell(form.matrix, unit, page.id))}
                                type="button"
                                aria-label={`${checked ? 'Desmarcar' : 'Marcar'} ${page.label} em ${unit}`}
                                className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                                  checked
                                    ? 'bg-primary text-white shadow-[0_2px_8px_rgba(15,60,35,0.2)] hover:bg-[#0a0a0a]'
                                    : 'bg-white border border-slate-200 text-transparent hover:border-primary hover:text-primary/30'
                                }`}
                              >
                                <CheckCircle2 size={16} strokeWidth={2.5} />
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 mb-7">
            <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-black">
              {checkedCount} / {TOTAL_CELLS} células
            </span>
            <span>·</span>
            <span>
              {checkedCount === TOTAL_CELLS
                ? 'Acesso total ao sistema'
                : checkedCount === 0
                ? 'Sem acesso a nada'
                : 'Acesso customizado'}
            </span>
            <span className="ml-auto text-slate-300">Clique no nome da página/unidade pra marcar a linha/coluna inteira</span>
          </div>

          {/* SEÇÃO 4: Preferências de Exibição ──────────────────────────────── */}
          <div className="mb-3 flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
            <Eye size={12} /> Preferências de Exibição
          </div>
          <div className="space-y-2 mb-7">
            {/* Vendas (R$) no Painel */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
                  <DollarSign size={16} />
                </div>
                <div>
                  <p className="text-[12px] font-black text-slate-700">Valor (R$) das vendas no Painel</p>
                  <p className="text-[11px] font-bold text-slate-400">Se desligado, vê só a quantidade de vendas — sem o card "Vendas (R$)"</p>
                </div>
              </div>
              <button
                onClick={() => setForm({ ...form, showVendasValor: !form.showVendasValor })}
                type="button"
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.showVendasValor ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                }`}
              >
                {form.showVendasValor ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.showVendasValor ? 'Mostra' : 'Oculta'}
              </button>
            </div>

            {/* Faturamento Estimado no PDF */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <FileText size={16} />
                </div>
                <div>
                  <p className="text-[12px] font-black text-slate-700">Faturamento Estimado no relatório PDF</p>
                  <p className="text-[11px] font-bold text-slate-400">Inclui ou omite o Faturamento Estimado no PDF que esse usuário gera</p>
                </div>
              </div>
              <button
                onClick={() => setForm({ ...form, pdfFaturamentoEstimado: !form.pdfFaturamentoEstimado })}
                type="button"
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.pdfFaturamentoEstimado ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                }`}
              >
                {form.pdfFaturamentoEstimado ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.pdfFaturamentoEstimado ? 'Inclui' : 'Omite'}
              </button>
            </div>

            {/* Taxa de Ocupação no Painel */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center">
                  <Activity size={16} />
                </div>
                <div>
                  <p className="text-[12px] font-black text-slate-700">Taxa de Ocupação no Painel</p>
                  <p className="text-[11px] font-bold text-slate-400">Mostra ou oculta o card "Taxa de Ocupação" no Painel desse usuário</p>
                </div>
              </div>
              <button
                onClick={() => setForm({ ...form, showTaxaOcupacao: !form.showTaxaOcupacao })}
                type="button"
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.showTaxaOcupacao ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                }`}
              >
                {form.showTaxaOcupacao ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.showTaxaOcupacao ? 'Mostra' : 'Oculta'}
              </button>
            </div>

            {/* Baixar relatório PDF */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-sky-100 text-sky-700 flex items-center justify-center">
                  <Download size={16} />
                </div>
                <div>
                  <p className="text-[12px] font-black text-slate-700">Baixar relatório PDF</p>
                  <p className="text-[11px] font-bold text-slate-400">Permite ou bloqueia o botão de baixar o relatório PDF no Painel</p>
                </div>
              </div>
              <button
                onClick={() => setForm({ ...form, canDownloadPdf: !form.canDownloadPdf })}
                type="button"
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.canDownloadPdf ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                }`}
              >
                {form.canDownloadPdf ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.canDownloadPdf ? 'Pode' : 'Bloqueado'}
              </button>
            </div>

            {/* Editar metas — permissão (não-admin). Default desligado. */}
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center">
                  <Target size={16} />
                </div>
                <div>
                  <p className="text-[12px] font-black text-slate-700">Editar metas</p>
                  <p className="text-[11px] font-bold text-slate-400">Permite definir e salvar as metas (na aba Metas) das unidades que o usuário acessa. Desligado = só visualiza.</p>
                </div>
              </div>
              <button
                onClick={() => setForm({ ...form, canEditMetas: !form.canEditMetas })}
                type="button"
                className={`shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.canEditMetas ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                }`}
              >
                {form.canEditMetas ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.canEditMetas ? 'Pode editar' : 'Só leitura'}
              </button>
            </div>
          </div>

          {/* SEÇÃO 5: Visibilidade no Painel (drill-down) ───────────────────── */}
          <div className="mb-3 flex items-center gap-2 text-slate-500 text-[10px] font-black uppercase tracking-[0.18em]">
            <MousePointerClick size={12} /> No Painel · O que esse usuário vê / pode abrir
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-7">
            {([
              { key: 'canSeeInadimplentes',     icon: AlertTriangle, color: 'bg-rose-100 text-rose-700',     label: 'Inadimplentes',     desc: '% inadimplência, contagem e exportar lista no detalhe da unidade' },
              { key: 'canSeeVendasDetalhe',     icon: ShoppingBag,   color: 'bg-indigo-100 text-indigo-700', label: 'Abrir lista de Vendas',  desc: 'Pode CLICAR no card de Vendas e abrir a lista de matrículas. Desmarcado: vê o card no Painel, mas clicar não abre nada.' },
              { key: 'canSeeFinanceiroDetalhe', icon: DollarSign,    color: 'bg-emerald-100 text-emerald-700', label: 'Financeiro',      desc: 'Faturamento Real, Estimado e "Já Pagaram" no detalhe da unidade' },
              { key: 'canSeeReceitaRisco',      icon: Activity,      color: 'bg-amber-100 text-amber-700',   label: 'Receita em Risco', desc: 'ValorContrato em atraso no painel resumo do detalhe' },
              { key: 'canSeeEvasao',            icon: TrendingDown,  color: 'bg-fuchsia-100 text-fuchsia-700', label: 'Abrir lista de Evasão',  desc: 'Pode CLICAR no card "% Evasão" e abrir a lista de cancelamentos. Desmarcado: vê o card no Painel, mas clicar não abre nada.' },
              { key: 'canSeeClienteNome',       icon: IdCard,        color: 'bg-sky-100 text-sky-700',       label: 'Nome do cliente',  desc: 'Nome/documento nas listas de matrículas e de evasão (some da tela e do Excel)' },
              { key: 'canSeeTendencia',         icon: LineChart,     color: 'bg-teal-100 text-teal-700',     label: 'Gráfico Evolução da Rede', desc: 'O gráfico "Tendência & Projeção" no fim do Painel. Desmarcado: não aparece pra esse usuário.' },
              { key: 'canSeeTendenciaFaturamento', icon: DollarSign,  color: 'bg-lime-100 text-lime-700',     label: 'Faturamento na Tendência', desc: 'A aba "Faturamento" DENTRO do gráfico Tendência & Projeção. Desmarcado: o usuário vê o gráfico, mas sem a opção de faturamento (ex.: sócio cotista).' },
              { key: 'canSeeMetaRegional',      icon: Eye,           color: 'bg-rose-100 text-rose-700',     label: 'Meta Regional (KPIs)', desc: 'A seção "Meta Regional" (visão consolidada da rede) na tela KPIs. Default desmarcado — só vê quem você liberar (admin sempre vê).' },
            ] as const).map(({ key, icon: Icon, color, label, desc }) => {
              const on = form[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setForm({ ...form, [key]: !on })}
                  className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-left transition-all border ${
                    on ? 'bg-white border-slate-100 hover:border-slate-200' : 'bg-slate-50 border-slate-100'
                  }`}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center ${on ? color : 'bg-slate-200 text-slate-400'}`}>
                      <Icon size={14} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[12px] font-black text-slate-700 flex items-center gap-1.5">
                        {label}
                        {!on && <UserX size={11} className="text-slate-400" />}
                      </p>
                      <p className="text-[10px] font-bold text-slate-400 leading-tight">{desc}</p>
                    </div>
                  </div>
                  <span className={`shrink-0 ${on ? 'text-emerald-600' : 'text-slate-300'}`}>
                    {on ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Toggle Ativo (só edição) */}
          {form.mode === 'edit' && (
            <div className="flex items-center justify-between gap-3 px-5 py-4 bg-slate-50 rounded-2xl mb-3">
              <div>
                <p className="text-[12px] font-black text-slate-700">Status do usuário</p>
                <p className="text-[11px] font-bold text-slate-400">Usuário inativo não consegue logar</p>
              </div>
              <button
                onClick={() => setForm({ ...form, active: !form.active })}
                type="button"
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider transition-all ${
                  form.active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-rose-100 text-rose-700 hover:bg-rose-200'
                }`}
              >
                {form.active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                {form.active ? 'Ativo' : 'Inativo'}
              </button>
            </div>
          )}

          {/* Erro */}
          {error && (
            <div className="flex items-start gap-2 px-4 py-3 mt-3 bg-rose-50 border border-rose-100 rounded-xl">
              <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
              <p className="text-[12px] font-bold text-rose-700">{error}</p>
            </div>
          )}
        </div>

        {/* Rodapé sticky com Salvar */}
        <div className="shrink-0 px-8 sm:px-10 py-5 border-t border-slate-100 bg-white flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-5 py-3 text-slate-500 font-black text-[12px] uppercase tracking-wider hover:text-slate-700 transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={onSubmit}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[12px] font-black uppercase tracking-wider shadow-[0_8px_25px_rgba(15,60,35,0.2)] transition-all disabled:opacity-50"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Salvando…' : form.mode === 'create' ? (form.sendInviteOnCreate ? 'Criar e enviar convite' : 'Criar Usuário') : 'Salvar Alterações'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
