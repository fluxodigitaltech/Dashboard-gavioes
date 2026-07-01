import { useState, useEffect, Suspense } from 'react';
import { RefreshCw, Bell, LogOut, Menu, X } from 'lucide-react';
import gbEncurtado from './assets/gb_encurtado.png';
import { motion, AnimatePresence } from 'framer-motion';
import { LoginScreen } from './components/LoginScreen';
import { SetPasswordScreen } from './screens/SetPasswordScreen';
import { DashboardScreen } from './screens/DashboardScreen';
// Painel é o landing — fica no chunk principal. Demais screens via lazy
// pra cortar bundle inicial e baixar só quando o user navegar pra elas.
const UnidadesScreen      = lazyWithRetry(() => import('./screens/UnidadesScreen').then(m => ({ default: m.UnidadesScreen })));
const FinanceiroScreen    = lazyWithRetry(() => import('./screens/FinanceiroScreen').then(m => ({ default: m.FinanceiroScreen })));
const CampanhasScreen     = lazyWithRetry(() => import('./screens/CampanhasScreen').then(m => ({ default: m.CampanhasScreen })));
const MetasScreen         = lazyWithRetry(() => import('./screens/MetasScreen').then(m => ({ default: m.MetasScreen })));
const AgregadoresScreen   = lazyWithRetry(() => import('./screens/AgregadoresScreen').then(m => ({ default: m.AgregadoresScreen })));
const AdminUsuariosScreen = lazyWithRetry(() => import('./screens/AdminUsuariosScreen').then(m => ({ default: m.AdminUsuariosScreen })));
const OcupacaoScreen      = lazyWithRetry(() => import('./screens/OcupacaoScreen').then(m => ({ default: m.OcupacaoScreen })));
const ComercialScreen     = lazyWithRetry(() => import('./screens/ComercialScreen').then(m => ({ default: m.ComercialScreen })));
const PlanosScreen        = lazyWithRetry(() => import('./screens/PlanosScreen').then(m => ({ default: m.PlanosScreen })));
const LeadsScreen         = lazyWithRetry(() => import('./screens/LeadsScreen').then(m => ({ default: m.LeadsScreen })));
import { IconButton } from './components/ui/IconButton';
import { Pill } from './components/ui/Pill';
import { Avatar } from './components/ui/Avatar';
import { LoadingBar } from './components/ui/LoadingBar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { captureError } from './lib/telemetry';
import { scopeDashboardData } from './lib/scopeData';
import { lazyWithRetry } from './lib/lazyWithRetry';
import { getSession, saveSession, clearSession, fetchUserByEmail, canAccessPage, getAllowedUnitsForPage, isAdmin, canSeeClienteNome, canDownloadPdf, type GbUser } from './services/nocodbApi';
import {
  fetchTodayEntriesAllBranches,
  fetchAllBranchStats,
  groupEntriesBySlot,
  groupEntriesBySlotPerBranch,
  type BranchStats,
} from './services/evoApi';

export type Page = 'dashboard' | 'unidades' | 'planos' | 'financeiro' | 'kpis' | 'campanhas' | 'leads' | 'metas' | 'agregadores' | 'ocupacao' | 'comercial' | 'admin_usuarios';

export interface DashboardData {
  totalActiveMembers: number;             // adimplentes + inadimplentes (sem VIPs)
  totalAdimplentesMembers: number;        // ativos não-VIP, em dia
  totalInadimplentesMembers: number;      // com débitos em aberto
  totalVipMembers: number;
  totalFaturamentoAdimplentes: number;
  totalVendasMesValor: number;
  totalVendasMesQtd: number;

  // ─── Histórico (mês passado) pra cálculo de % crescimento ──────────────
  totalActiveMembersPrev: number;
  totalAdimplentesMembersPrev: number;
  totalInadimplentesMembersPrev: number;
  totalFaturamentoAdimplentesPrev: number;
  totalFaturamentoInadimplentesPrev: number;
  totalVendasMesValorPrev: number;
  totalVendasMesQtdPrev: number;

  // ─── Snapshot anual (1 ano atrás) — pra crescimento direto financeiro ─
  totalActiveMembers1y: number;
  totalAdimplentesMembers1y: number;
  totalVipMembers1y: number;
  totalFaturamentoAdimplentes1y: number;
  totalFaturamentoInadimplentes1y: number;
  has1yDataAny: boolean; // true se ALGUMA unidade tem dados 1y (decide se mostra comparativo)

  // ─── Vendas no MESMO MÊS DO ANO ANTERIOR (comparativo "vs ano anterior") ─
  totalVendasMesValor1y: number;
  totalVendasMesQtd1y: number;
  has1yVendasAny: boolean; // true se ALGUMA unidade tem vendas 1y

  // ─── Cancelamentos do MÊS CORRENTE (pra card de Evasão real) ────────────
  totalCancelamentosMes: number;
  cancelamentosMesAllComplete: boolean;  // false = alguma unidade falhou paginação → mostra ⚠

  totalCancelledMembers: number;
  totalInactiveMembers: number;           // legacy alias = totalInadimplentesMembers
  todayEntries: number;
  retentionRate: number;
  units: BranchStats[];
  barData: number[];
  heatmapData: Record<string, number[]>;
  hasAnyError: boolean;
  lastUpdated: Date;
}

const FALLBACK_BARS = [40, 55, 65, 80, 75, 95, 100, 85, 70, 50, 40, 20];
// Janela de frescor do snapshot (compartilhado no NocoDB e local).
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000; // 3 horas

const ALL_NAV_ITEMS: { id: Page; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard',      label: 'Painel' },
  { id: 'unidades',       label: 'Unidades' },
  { id: 'planos',         label: 'Planos' },
  { id: 'financeiro',     label: 'Financeiro' },
  { id: 'metas',          label: 'Metas' },
  { id: 'campanhas',      label: 'Marketing' },
  { id: 'leads',          label: 'Leads' },
  { id: 'comercial',      label: 'Comercial' },
  { id: 'agregadores',    label: 'Agregadores' },
  { id: 'admin_usuarios', label: 'Usuários', adminOnly: true },
];

// ─── Filtragem de data por permissão de unidade ──────────────────────────────
// Aplica matriz Página×Unidade: se o usuário só pode ver Saúde e Belenzinho
// na página Financeiro, retorna data com units filtrado pra essas duas e totais recalculados.
function filterDataForUserOnPage(data: DashboardData | null, page: Page, user: GbUser | null): DashboardData | null {
  if (!data || !user) return data;
  const allowed = getAllowedUnitsForPage(user, page);
  if (allowed === 'all') return data;
  return scopeDashboardData(data, allowed);
}

// ─── Loader pro Suspense durante lazy load de screens ────────────────────────
function ScreenLoader() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-16 flex items-center justify-center" aria-busy="true" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <RefreshCw size={20} className="animate-spin text-primary" aria-hidden="true" />
        <span className="text-[12px] font-bold uppercase tracking-[0.18em]">Carregando…</span>
      </div>
    </div>
  );
}

// ─── Tela de bloqueio (sem permissão) ────────────────────────────────────────
function BlockedScreen({ pageName }: { pageName: string }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-24 text-center">
      <div className="w-20 h-20 mx-auto mb-6 rounded-3xl bg-rose-50 flex items-center justify-center">
        <span className="text-4xl">🔒</span>
      </div>
      <h1 className="text-[2.5rem] font-black text-primary tracking-tighter mb-3">Sem permissão</h1>
      <p className="text-slate-500 font-bold text-[15px] max-w-md mx-auto leading-relaxed">
        Sua conta não tem acesso à página <span className="text-primary font-black">{pageName}</span>.
        Fale com o administrador se precisar de acesso.
      </p>
    </div>
  );
}

function App() {
  // Lazy init lê sessão de localStorage uma vez no mount — evita flash de
  // tela de login pra usuários já logados e remove setState em useEffect.
  const [currentUser,  setCurrentUser]  = useState<GbUser | null>(() => getSession());
  const [isLoggedIn,   setIsLoggedIn]   = useState<boolean>(() => !!getSession());
  const [currentPage,  setCurrentPage]  = useState<Page>('dashboard');
  const [data,         setData]         = useState<DashboardData | null>(null);
  const [isLoading,    setIsLoading]    = useState(false);
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Filter nav items based on user permissions and admin-only flag
  // Usa canAccessPage que verifica a matriz Página×Unidade (com fallback pro modo legado)
  const NAV_ITEMS = currentUser
    ? ALL_NAV_ITEMS.filter(item => {
        if (item.adminOnly && !isAdmin(currentUser)) return false;
        if (item.id === 'admin_usuarios') return isAdmin(currentUser);
        return canAccessPage(currentUser, item.id);
      })
    : ALL_NAV_ITEMS;

  async function loadDashboard(isBackground = false, force = false) {
    if (!isBackground) setIsLoading(true);
    setLoadError(null);
    try {
      // ─── SNAPSHOT COMPARTILHADO (NocoDB via servidor) ─────────────────────
      // Membros/vendas do mês ficam salvos lá: quem abre o painel usa o snapshot
      // fresco e NEM TOCA na EVO (adeus 429 em cascata). Só o clique em
      // "Atualizar" (force=true) re-busca na EVO — e publica pra todo mundo.
      if (!force) {
        try {
          const r = await fetch('/api/snapshot?key=dashboard');
          if (r.ok) {
            const j = await r.json();
            const ts = j?.updated_at ? new Date(j.updated_at).getTime() : 0;
            if (j?.payload && ts > 0 && Date.now() - ts < REFRESH_INTERVAL) {
              const shared = j.payload as DashboardData;
              setData(shared);
              localStorage.setItem('gb_dashboard_snapshot_v13', JSON.stringify({ data: shared, timestamp: ts }));
              return; // dado fresco compartilhado — sem EVO
            }
          }
        } catch { /* servidor sem snapshot → segue pro fluxo EVO normal */ }
      }

      const [branchStats, entries] = await Promise.all([
        fetchAllBranchStats(force),
        fetchTodayEntriesAllBranches(),
      ]);

      const totalActive          = branchStats.reduce((s: number, b: BranchStats) => s + b.activeMembers, 0);
      const totalAdimplentes     = branchStats.reduce((s: number, b: BranchStats) => s + (b.adimplentesMembers     ?? 0), 0);
      const totalInadimplentes   = branchStats.reduce((s: number, b: BranchStats) => s + (b.inadimplentesMembers   ?? 0), 0);
      const totalVips            = branchStats.reduce((s: number, b: BranchStats) => s + (b.vipMembers             ?? 0), 0);
      const totalFaturamento     = branchStats.reduce((s: number, b: BranchStats) => s + (b.faturamentoAdimplentes ?? 0), 0);
      const totalVendasValor     = branchStats.reduce((s: number, b: BranchStats) => s + (b.vendasMesValor         ?? 0), 0);
      const totalVendasQtd       = branchStats.reduce((s: number, b: BranchStats) => s + (b.vendasMesQtd           ?? 0), 0);
      const totalActivePrev      = branchStats.reduce((s: number, b: BranchStats) => s + (b.activeMembersPrev        ?? 0), 0);
      const totalAdimplentesPrev = branchStats.reduce((s: number, b: BranchStats) => s + (b.adimplentesMembersPrev   ?? 0), 0);
      const totalInadimplentesPrev = branchStats.reduce((s: number, b: BranchStats) => s + (b.inadimplentesMembersPrev ?? 0), 0);
      const totalFatAdimpPrev    = branchStats.reduce((s: number, b: BranchStats) => s + (b.faturamentoAdimplentesPrev   ?? 0), 0);
      const totalFatInadPrev     = branchStats.reduce((s: number, b: BranchStats) => s + (b.faturamentoInadimplentesPrev ?? 0), 0);
      const totalVendasValorPrev = branchStats.reduce((s: number, b: BranchStats) => s + (b.vendasMesValorPrev      ?? 0), 0);
      const totalVendasQtdPrev   = branchStats.reduce((s: number, b: BranchStats) => s + (b.vendasMesQtdPrev        ?? 0), 0);
      // Snapshot anual — soma só unidades com has1yData=true (ignora unidades novas)
      const branches1y           = branchStats.filter((b: BranchStats) => b.has1yData);
      const totalActive1y        = branches1y.reduce((s: number, b: BranchStats) => s + (b.activeMembers1y          ?? 0), 0);
      const totalAdimp1y         = branches1y.reduce((s: number, b: BranchStats) => s + (b.adimplentesMembers1y       ?? 0), 0);
      const totalVips1y          = branches1y.reduce((s: number, b: BranchStats) => s + (b.vipMembers1y               ?? 0), 0);
      const totalFat1y           = branches1y.reduce((s: number, b: BranchStats) => s + (b.faturamentoAdimplentes1y   ?? 0), 0);
      const totalFatInad1y       = branches1y.reduce((s: number, b: BranchStats) => s + (b.faturamentoInadimplentes1y ?? 0), 0);
      // Vendas 1y — usa flag has1yVendas (separada da has1yData, porque pode falhar separadamente)
      const branchesV1y          = branchStats.filter((b: BranchStats) => b.has1yVendas);
      const totalVendasValor1y   = branchesV1y.reduce((s: number, b: BranchStats) => s + (b.vendasMesValor1y         ?? 0), 0);
      const totalVendasQtd1y     = branchesV1y.reduce((s: number, b: BranchStats) => s + (b.vendasMesQtd1y           ?? 0), 0);
      // Cancelamentos do mês — soma de todas unidades (cada uma puxa o seu da W12)
      const totalCancelamentos   = branchStats.reduce((s: number, b: BranchStats) => s + (b.cancelamentosMes        ?? 0), 0);
      const cancelAllComplete    = branchStats.every((b: BranchStats) => b.cancelamentosMesComplete !== false);
      // retentionRate = adimplentes / total active (mais preciso que active/(active+inactive))
      const retentionRate        = totalActive > 0 ? Math.round((totalAdimplentes / totalActive) * 100) : 0;

      const newData: DashboardData = {
        totalActiveMembers:          totalActive,
        totalAdimplentesMembers:     totalAdimplentes,
        totalInadimplentesMembers:   totalInadimplentes,
        totalVipMembers:             totalVips,
        totalFaturamentoAdimplentes: totalFaturamento,
        totalVendasMesValor:         totalVendasValor,
        totalVendasMesQtd:           totalVendasQtd,
        totalActiveMembersPrev:           totalActivePrev,
        totalAdimplentesMembersPrev:      totalAdimplentesPrev,
        totalInadimplentesMembersPrev:    totalInadimplentesPrev,
        totalFaturamentoAdimplentesPrev:  totalFatAdimpPrev,
        totalFaturamentoInadimplentesPrev:totalFatInadPrev,
        totalVendasMesValorPrev:     totalVendasValorPrev,
        totalVendasMesQtdPrev:       totalVendasQtdPrev,
        totalActiveMembers1y:          totalActive1y,
        totalAdimplentesMembers1y:       totalAdimp1y,
        totalVipMembers1y:               totalVips1y,
        totalFaturamentoAdimplentes1y:   totalFat1y,
        totalFaturamentoInadimplentes1y: totalFatInad1y,
        has1yDataAny:                  branches1y.length > 0,
        totalVendasMesValor1y:         totalVendasValor1y,
        totalVendasMesQtd1y:           totalVendasQtd1y,
        has1yVendasAny:                branchesV1y.length > 0,
        totalCancelamentosMes:       totalCancelamentos,
        cancelamentosMesAllComplete: cancelAllComplete,
        totalCancelledMembers:       0,
        totalInactiveMembers:        totalInadimplentes, // legacy alias
        todayEntries:              entries.length,
        retentionRate:             retentionRate,
        units:                     branchStats,
        barData:                   entries.length > 0 ? groupEntriesBySlot(entries) : FALLBACK_BARS,
        heatmapData:               groupEntriesBySlotPerBranch(entries),
        hasAnyError:               branchStats.some((b: BranchStats) => b.hasError),
        lastUpdated:               new Date(),
      };

      setData(newData);
      // Cache key versionado: bumpear ao mudar a LÓGICA de contagem/campos pra
      // invalidar o cache antigo de todos os usuários. 'v11' = conta Massagem +
      // desconsidera clientes Suspensos (StatusCliente).
      localStorage.setItem('gb_dashboard_snapshot_v13', JSON.stringify({
        data: newData,
        timestamp: Date.now()
      }));
      // Publica o snapshot novo pros OUTROS usuários (fire-and-forget).
      fetch('/api/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'dashboard', payload: newData, updated_by: currentUser?.email ?? '' }),
      }).catch(() => { /* melhor esforço — local já está atualizado */ });
    } catch (err) {
      captureError(err, { scope: 'loadDashboard', isBackground });
      if (!isBackground) setLoadError('Erro ao sincronizar dados com W12 EVO. Tente atualizar.');
    } finally {
      if (!isBackground) setIsLoading(false);
    }
  }

  // Revalida permissões/preferências do usuário no NocoDB a cada load do app.
  // Sem isso, mudanças do admin (toggles, matriz de acesso) só valeriam após
  // logout+login — aqui basta recarregar a página. Falha de rede = mantém sessão.
  useEffect(() => {
    if (!isLoggedIn) return;
    const s = getSession();
    if (!s?.email) return;
    let cancelled = false;
    fetchUserByEmail(s.email)
      .then(fresh => {
        if (cancelled) return;
        if (fresh) {
          saveSession(fresh);
          setCurrentUser(fresh);
        } else {
          // Usuário removido/desativado no backend → encerra a sessão.
          clearSession();
          setIsLoggedIn(false);
          setCurrentUser(null);
        }
      })
      .catch(() => { /* offline/erro de rede: mantém a sessão atual */ });
    return () => { cancelled = true; };
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;

    // queueMicrotask difere o setData/loadDashboard pra fora do effect body
    // (anti-pattern set-state-in-effect). Comportamento idêntico, sem warning.
    queueMicrotask(() => {
      const saved = localStorage.getItem('gb_dashboard_snapshot_v13');
      if (saved) {
        try {
          const { data: cachedData } = JSON.parse(saved);
          setData(cachedData);
          // Sempre revalida em background no mount: mostra o cache na hora e puxa
          // o snapshot atual do scraper (GET /data é instantâneo). Antes só
          // atualizava se o cache tivesse > 3h, deixando dado velho preso na tela.
          loadDashboard(true);
        } catch {
          loadDashboard();
        }
      } else {
        loadDashboard();
      }
    });

    // Set background polling every 3 hours
    const intervalId = setInterval(() => {
      loadDashboard(true);
    }, REFRESH_INTERVAL);

    return () => clearInterval(intervalId);
    // loadDashboard fora das deps de propósito: é recriada a cada render (usa
    // currentUser só pra assinar o snapshot publicado) e incluí-la refaria o
    // polling inteiro a cada mudança de usuário/estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn]);

  const handleLogout = () => {
    clearSession();
    setIsLoggedIn(false);
    setCurrentUser(null);
    setData(null);
    setCurrentPage('dashboard');
  };

  // Rota do convite por e-mail — tem precedência sobre login/sessão.
  if (window.location.pathname.startsWith('/definir-senha')) {
    return <SetPasswordScreen />;
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={(user) => { setCurrentUser(user); setIsLoggedIn(true); }} />;
  }

  return (
    <div className="min-h-screen bg-white font-manrope selection:bg-accent selection:text-white">
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-(--z-header) bg-white/90 backdrop-blur-xl border-b border-slate-100 h-16 lg:h-20 px-4 sm:px-6 lg:px-8 safe-x">
        <div className="max-w-screen-2xl mx-auto h-full flex items-center justify-between gap-3">
          {/* Left: Logo + Nav (desktop) */}
          <div className="flex items-center gap-4 lg:gap-8 min-w-0 flex-1">
            <div
              className="flex items-center gap-2 lg:gap-3 cursor-pointer shrink-0"
              onClick={() => { setCurrentPage('dashboard'); setMobileMenuOpen(false); }}
            >
               <img src={gbEncurtado} alt="Gaviões" className="h-8 lg:h-10 w-auto object-contain shrink-0" />
               <span className="text-[14px] lg:text-[15px] font-black text-primary tracking-tighter uppercase hidden sm:block whitespace-nowrap">Gaviões</span>
            </div>

            {/* Desktop nav (lg+) */}
            <nav className="hidden lg:flex items-center gap-1 min-w-0">
              {NAV_ITEMS.map(({ id, label }) => (
                <Pill
                  key={id}
                  active={currentPage === id}
                  onClick={() => setCurrentPage(id)}
                  aria-current={currentPage === id ? 'page' : undefined}
                  className="text-[13px]"
                >
                  {label}
                </Pill>
              ))}
            </nav>
          </div>

          {/* Right: Tools + User */}
          <div className="flex items-center gap-2 lg:gap-6 shrink-0">

            {/* Refresh + Bell — visíveis em todas as larguras */}
            <div className="flex items-center gap-1.5 lg:gap-2">
               <IconButton
                  onClick={() => loadDashboard(false, true)}
                  disabled={isLoading}
                  label="Atualizar dados"
                  className="group"
                  icon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-700'} />}
               />
               <IconButton
                  label={data?.hasAnyError ? 'Notificações (há alertas)' : 'Notificações'}
                  icon={<Bell size={16} />}
                  badge={data?.hasAnyError ? <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-rose-500 rounded-full border-2 border-white" aria-hidden="true" /> : undefined}
               />
            </div>

            {/* User block — full no desktop, só avatar no mobile */}
            <div className="flex items-center gap-2 lg:gap-3 lg:pl-4 lg:border-l lg:border-slate-100">
               <div className="text-right hidden lg:block">
                  <p className="text-[12px] font-black text-primary leading-none truncate max-w-[120px]">
                    {currentUser?.name ?? 'Admin'}
                  </p>
                  <p className="text-[10px] font-bold text-slate-500">
                    {currentUser?.role ?? 'Usuário'}
                  </p>
               </div>
               <div className="w-9 h-9 lg:w-10 lg:h-10 rounded-2xl overflow-hidden border-2 border-slate-100 shadow-sm cursor-pointer shrink-0">
                  <Avatar
                    seed={currentUser?.email ?? 'Admin'}
                    alt={currentUser?.name ?? 'Admin'}
                    className="w-full h-full"
                  />
               </div>
               <IconButton
                 onClick={handleLogout}
                 label="Sair da conta"
                 tone="danger"
                 size="md"
                 className="hidden lg:flex"
                 icon={<LogOut size={16} />}
               />
            </div>

            {/* Hamburger — só mobile (< lg) */}
            <IconButton
              onClick={() => setMobileMenuOpen(o => !o)}
              label={mobileMenuOpen ? 'Fechar menu' : 'Abrir menu'}
              tone="primary"
              size="md"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-nav-drawer"
              className="lg:hidden shrink-0"
              icon={mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
            />
          </div>
        </div>

        {/* ── Mobile menu drawer ── */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              id="mobile-nav-drawer"
              className="lg:hidden absolute top-full left-0 right-0 bg-white border-b border-slate-100 shadow-xl scroll-contain max-h-[calc(100vh-4rem)] overflow-y-auto"
            >
              <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-1 safe-bottom">
                {NAV_ITEMS.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => {
                      setCurrentPage(id);
                      setMobileMenuOpen(false);
                    }}
                    className={`text-left px-4 py-3 rounded-xl text-[14px] font-black tracking-tight transition-colors ${
                      currentPage === id
                        ? 'bg-primary text-white'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => { handleLogout(); setMobileMenuOpen(false); }}
                  className="text-left px-4 py-3 rounded-xl text-[14px] font-black tracking-tight text-rose-500 hover:bg-rose-50 transition-colors flex items-center gap-2 mt-2 border-t border-slate-100 pt-4"
                >
                  <LogOut size={16} />
                  Sair
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* ── Error Banner ── */}
      <AnimatePresence>
        {loadError && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-rose-50 border-b border-rose-100 overflow-hidden"
          >
            <div className="max-w-screen-2xl mx-auto px-8 py-4 flex items-center justify-between">
              <p className="text-rose-600 text-[13px] font-bold flex items-center gap-2">
                <RefreshCw size={14} className="animate-spin" /> {loadError}
              </p>
              <button
                onClick={() => loadDashboard()}
                className="px-4 py-2 bg-rose-600 text-white rounded-xl text-[11px] font-black uppercase tracking-widest hover:bg-rose-700 transition-all"
              >
                Tentar Sincronizar Agora
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Barra de loading global — carregamento principal de dados (EVO/snapshot) */}
      <LoadingBar active={isLoading} label="Sincronizando dados" />

      {/* ── Page Content ── */}
      <main className="relative z-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentPage}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -10 }}
            transition={{ duration: 0.3 }}
          >
            <ErrorBoundary scope={currentPage}>
            <Suspense fallback={<ScreenLoader />}>
              {(() => {
                // Admin sempre tem acesso. Demais usuários: checa canAccessPage
                const isAdminUser = currentUser ? isAdmin(currentUser) : false;
                const navItem = ALL_NAV_ITEMS.find(i => i.id === currentPage);
                const pageLabel = navItem?.label ?? currentPage;
                // Página admin_usuarios só pra admins
                if (currentPage === 'admin_usuarios' && !isAdminUser) {
                  return <BlockedScreen pageName={pageLabel} />;
                }
                // Demais páginas: checa permissão
                if (currentPage !== 'admin_usuarios' && currentUser && !canAccessPage(currentUser, currentPage)) {
                  return <BlockedScreen pageName={pageLabel} />;
                }
                // Filtra data pra unidades permitidas nessa página específica
                const pageData = filterDataForUserOnPage(data, currentPage, currentUser);
                switch (currentPage) {
                  case 'dashboard':      return <DashboardScreen   data={pageData} isLoading={isLoading} onNavigate={setCurrentPage} currentUser={currentUser} />;
                  case 'unidades':       return <UnidadesScreen    data={pageData} isLoading={isLoading} onNavigate={setCurrentPage} />;
                  case 'planos':         return <PlanosScreen      data={pageData} />;
                  case 'financeiro':     return <FinanceiroScreen  data={pageData} isLoading={isLoading} />;
                  case 'campanhas':      return <CampanhasScreen data={pageData} />;
                  case 'leads':          return <LeadsScreen showClientData={currentUser ? canSeeClienteNome(currentUser) : true} canDownloadPdf={currentUser ? canDownloadPdf(currentUser) : true} />;
                  case 'metas':          return <MetasScreen       data={pageData} />;
                  case 'agregadores':    return <AgregadoresScreen />;
                  case 'ocupacao':       return <OcupacaoScreen    data={pageData} />;
                  case 'comercial':      return <ComercialScreen   data={pageData} />;
                  case 'admin_usuarios': return <AdminUsuariosScreen />;
                  default: return null;
                }
              })()}
            </Suspense>
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      {/* ── Footer ── */}
      <footer className="max-w-screen-2xl mx-auto px-4 sm:px-8 py-12 sm:py-16 mt-12 sm:mt-20 border-t border-slate-50 flex flex-col md:flex-row items-center justify-between gap-6 md:gap-10">
        <div className="flex items-center gap-4">
           <div className="w-10 h-10 bg-slate-100 rounded-2xl flex items-center justify-center overflow-hidden">
             <img src={gbEncurtado} alt="" aria-hidden="true" className="w-8 h-8 object-contain" />
           </div>
           <div>
              <p className="text-[12px] font-black text-primary uppercase tracking-widest">Gaviões 24h Dashboard</p>
              <p className="text-[11px] font-bold text-slate-500 mt-0.5">Gestão Inteligente © {new Date().getFullYear()}</p>
           </div>
        </div>
        <div className="flex items-center gap-6 sm:gap-10 text-[11px] font-black text-slate-500 uppercase tracking-widest">
           <span className="text-slate-400">V1.2.0 Stable</span>
           <span className="text-slate-300 cursor-not-allowed select-none" title="Em breve">Suporte</span>
           <span className="text-slate-300 cursor-not-allowed select-none" title="Em breve">Docs</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
