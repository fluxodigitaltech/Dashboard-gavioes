import { useState, useEffect, useCallback } from 'react';
import { DateFilterBar } from '../components/DateFilterBar';
import { localYMD } from '../lib/date';
import { motion } from 'framer-motion';
import {
  TrendingUp, MousePointer2, Eye,
  DollarSign, RefreshCw, AlertCircle, BarChart3,
  Trophy, Target, Search, X, Users, ArrowRight, Award,
  type LucideIcon,
} from 'lucide-react';
import { fetchAdAccounts, fetchCampaigns, type AdAccount, type MetaCampaign } from '../services/metaApi';
import { getCachedAvgTicket } from '../services/evoApi';
import type { DashboardData } from '../App';
import { InfoTooltip } from '../components/ui/InfoTooltip';
import { LoadingBar } from '../components/ui/LoadingBar';

type Platform = 'meta' | 'google';

interface Props {
  /** Snapshot EVO — pra cruzar investimento × alunos novos × faturamento. */
  data: DashboardData | null;
}

const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return fallback;
}

export function CampanhasScreen({ data }: Props) {
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [campaigns, setCampaigns] = useState<MetaCampaign[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePlatform, setActivePlatform] = useState<Platform>('meta');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  // ── Filtro da lista de campanhas (busca + status + ordenação) ──
  const [campaignSearch, setCampaignSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todas' | 'ativas' | 'pausadas'>('todas');
  const [sortBy, setSortBy] = useState<'leads' | 'cpl' | 'spend' | 'ctr'>('leads');

  const loadCampaigns = useCallback(async (accountId: string, from?: string, to?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const effFrom = from ?? dateFrom;
      const effTo = to ?? dateTo;
      const data = await fetchCampaigns(accountId, effFrom, effTo);
      setCampaigns(data);

      // Espelha o gasto pro KPI (mktInvestment) SÓ no período padrão (últimos 30
      // dias). Um intervalo custom de 3 meses não pode virar "investimento mensal".
      if (!effFrom || !effTo) {
        const totalSpend = data.reduce((sum, c) => sum + (Number(c.insights?.spend) || 0), 0);
        localStorage.setItem('gb_meta_total_spend', totalSpend.toString());
        // Alimenta o CAC/LTV do MetasScreen (que lê gb_kpi_mkt_investment) — antes
        // quem gravava era a aba KPIs; agora o investimento mora aqui no Marketing.
        localStorage.setItem('gb_kpi_mkt_investment', String(Math.round(totalSpend)));
      }
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar campanhas'));
    } finally {
      setIsLoading(false);
    }
  }, [dateFrom, dateTo]);

  const loadAccounts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const accounts = await fetchAdAccounts();
      setAdAccounts(accounts);
      if (accounts.length > 0) {
        // Gaviões: prefere a conta da unidade (ou a última escolhida), não a 1ª da lista.
        const saved = localStorage.getItem('gb_meta_account');
        const preferred = accounts.find(a => a.id === saved)
          || accounts.find(a => a.id === 'act_2033147407575965') // 01 - Gaviões Paraíso
          || accounts[0];
        setSelectedAccount(preferred.id);
        loadCampaigns(preferred.id, dateFrom, dateTo);
      }
    } catch (err: unknown) {
      setError(errorMessage(err, 'Erro ao carregar contas de anúncios'));
    } finally {
      setIsLoading(false);
    }
  }, [dateFrom, dateTo, loadCampaigns]);

  useEffect(() => {
    if (activePlatform !== 'meta') return;
    // queueMicrotask difere o setIsLoading(true) interno de loadAccounts
    // pra fora do body do effect, evitando o anti-pattern set-state-in-effect.
    queueMicrotask(() => { loadAccounts(); });
    // Só dispara ao entrar na aba Meta — NÃO nas mudanças de data (senão
    // re-busca contas + campanhas a cada data, duplicando com o onChange do
    // filtro de data, que já chama loadCampaigns sozinho).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlatform]);

  const totals = campaigns.reduce((acc, c) => {
    const i = c.insights;
    if (i) {
      acc.spend += Number(i.spend) || 0;
      acc.impressions += Number(i.impressions) || 0;
      acc.clicks += Number(i.clicks) || 0;
      acc.leads += Number(i.leads) || 0;
      acc.reach += Number(i.reach) || 0;
    }
    return acc;
  }, { spend: 0, impressions: 0, clicks: 0, leads: 0, reach: 0 });

  const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const avgCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  // Métricas-chave pra geração de leads (caso da Gaviões, não e-commerce):
  // CPL é A métrica — quanto custa cada lead. CPM e Frequência medem saúde/fadiga.
  const avgCpl = totals.leads > 0 ? totals.spend / totals.leads : 0;
  const cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  const frequency = totals.reach > 0 ? totals.impressions / totals.reach : 0;
  // Rótulo do período: reflete o filtro de data quando definido.
  const periodoLabel = dateFrom && dateTo ? 'Período selecionado' : 'Últimos 30 dias';
  const ativasCount = campaigns.filter(c => c.status === 'ACTIVE').length;
  const cplOf = (c: MetaCampaign) => {
    const l = Number(c.insights?.leads) || 0;
    const s = Number(c.insights?.spend) || 0;
    return l > 0 ? s / l : Infinity;
  };
  // Lista visível: aplica busca + status + ordenação escolhidos pelo usuário.
  const campaignsView = campaigns
    .filter(c => {
      if (statusFilter === 'ativas' && c.status !== 'ACTIVE') return false;
      if (statusFilter === 'pausadas' && c.status === 'ACTIVE') return false;
      const q = campaignSearch.trim().toLowerCase();
      if (q && !(`${c.name} ${c.objective}`.toLowerCase().includes(q))) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'spend') return (Number(b.insights?.spend) || 0) - (Number(a.insights?.spend) || 0);
      if (sortBy === 'ctr')   return (Number(b.insights?.ctr) || 0) - (Number(a.insights?.ctr) || 0);
      if (sortBy === 'cpl')   return cplOf(a) - cplOf(b); // menor CPL (melhor) primeiro
      return (Number(b.insights?.leads) || 0) - (Number(a.insights?.leads) || 0); // mais leads
    });

  // ── Mapa de Aquisição: Investido (Meta) → Leads → Alunos novos (EVO) → Faturamento ──
  // CAC/ROAS "blended": usa TODOS os alunos novos do mês (EVO), não só os vindos do Meta.
  const acqInvest = totals.spend;
  const acqLeads = totals.leads;
  const acqAlunos = data?.totalVendasMesQtd ?? 0;
  const acqFaturamento = data?.totalVendasMesValor ?? 0;
  const acqCpl = acqLeads > 0 ? acqInvest / acqLeads : 0;
  const acqCac = acqAlunos > 0 ? acqInvest / acqAlunos : 0;
  const acqRoas = acqInvest > 0 ? acqFaturamento / acqInvest : 0;
  const acqTicket = getCachedAvgTicket();
  const acqAtivos = data?.totalActiveMembers ?? 0;
  const acqChurn = acqAtivos > 0 ? (data?.totalCancelamentosMes ?? 0) / acqAtivos : 0;
  const acqLtv = acqChurn > 0 ? Math.round(1 / acqChurn) * acqTicket : 0;
  const acqLtvCac = acqCac > 0 ? acqLtv / acqCac : 0;
  const hasEvo = !!data;

  // ── Indicadores OPERACIONAIS (vindos da antiga aba KPIs, agora aqui) ──
  const opInativos = data?.totalInactiveMembers ?? 0;
  const opTotalBase = acqAtivos + opInativos;
  const opEvasao = opTotalBase > 0 ? (opInativos / opTotalBase) * 100 : 0;
  const opInadimplencia = acqAtivos > 0 ? (opInativos / acqAtivos) * 100 : 0;
  const opChurnPct = acqChurn * 100;
  const opRetencao = data?.retentionRate ?? 0;
  const opLifetimeMeses = acqChurn > 0 ? Math.round(1 / acqChurn) : 0;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">
      <LoadingBar active={isLoading} label="Carregando campanhas" />
      {/* Header */}
      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="mb-14 flex flex-col md:flex-row md:items-end justify-between gap-6"
      >
        <div>
          <span className="text-[11px] uppercase font-black text-primary tracking-[0.4em] mb-4 block">
            Marketing & Aquisição
          </span>
          <h1 className="text-[3.6rem] font-black text-primary leading-[0.9] tracking-tighter mb-4">
            Campanhas <span className="text-accent">Meta Ads</span>
          </h1>
          <p className="text-slate-400 text-[17px] font-semibold max-w-2xl">
            Acompanhe o desempenho dos seus anúncios e o ROI das campanhas integradas ao financeiro.
          </p>
        </div>

        <div className="flex flex-col gap-3 md:items-end">
          {/* Filtro de data */}
          <div className="order-2 w-fit">
            <DateFilterBar
              value={{ from: dateFrom || (() => { const d = new Date(); d.setDate(d.getDate() - 29); return localYMD(d); })(), to: dateTo || localYMD() }}
              onChange={r => {
                setDateFrom(r.from);
                setDateTo(r.to);
                if (selectedAccount) loadCampaigns(selectedAccount, r.from, r.to);
              }}
              maxDate={localYMD()}
              isCurrent={!dateFrom && !dateTo}
              onReset={() => {
                setDateFrom('');
                setDateTo('');
                if (selectedAccount) loadCampaigns(selectedAccount, '', '');
              }}
              legend="Vazio = últimos 30 dias"
            />
          </div>

          {/* Platform Tabs — switcher principal, no topo */}
          <div className="order-1 flex bg-slate-100 p-1 rounded-2xl w-fit" role="group" aria-label="Plataforma de anúncios">
            <button
              onClick={() => setActivePlatform('meta')}
              aria-pressed={activePlatform === 'meta'}
              className={`px-6 py-2 rounded-xl text-[12px] font-black transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                activePlatform === 'meta' ? 'bg-white text-primary shadow-sm' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              Meta Ads
            </button>
            <button
              onClick={() => setActivePlatform('google')}
              aria-pressed={activePlatform === 'google'}
              className={`px-6 py-2 rounded-xl text-[12px] font-black transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                activePlatform === 'google' ? 'bg-white text-primary shadow-sm' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              Google Ads
            </button>
          </div>

          {activePlatform === 'meta' && !error && adAccounts.length > 0 && (
            <div className="order-3 flex items-center gap-3">
              <div className="bg-slate-50 border border-slate-100 rounded-2xl p-1.5 flex items-center gap-2 shadow-sm">
                {adAccounts.length > 1 ? (
                  <select
                    value={selectedAccount}
                    onChange={(e) => {
                      setSelectedAccount(e.target.value);
                      localStorage.setItem('gb_meta_account', e.target.value);
                      loadCampaigns(e.target.value);
                    }}
                    className="bg-transparent text-[13px] font-black text-primary px-4 py-2 focus:outline-none min-w-[200px]"
                  >
                    {adAccounts.map(acc => (
                      <option key={acc.id} value={acc.id}>{acc.name}</option>
                    ))}
                  </select>
                ) : (
                  <div className="px-6 py-2">
                    <span className="text-[13px] font-black text-primary uppercase tracking-tight">
                      {adAccounts[0].name}
                    </span>
                  </div>
                )}
                
                <button
                  onClick={() => loadCampaigns(selectedAccount, dateFrom, dateTo)}
                  disabled={isLoading}
                  className="w-10 h-10 flex items-center justify-center rounded-xl bg-white border border-slate-100 text-slate-400 hover:text-primary transition-all"
                >
                  <RefreshCw size={18} className={isLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>
          )}
        </div>
      </motion.div>

      {activePlatform === 'google' ? (
        <div className="p-20 bg-slate-50 border border-slate-100 rounded-[3rem] flex flex-col items-center text-center">
          <div className="w-20 h-20 bg-white shadow-xl rounded-[2rem] flex items-center justify-center mb-8">
            <BarChart3 size={32} className="text-slate-300" />
          </div>
          <h3 className="text-[1.8rem] font-black text-primary mb-4 tracking-tight">Google Ads: Em Breve</h3>
          <p className="text-slate-400 font-semibold max-w-sm leading-relaxed text-[15px]">
            Estamos preparando a integração com o Google Ads. Em breve você poderá acompanhar seus gastos e conversões de busca aqui.
          </p>
        </div>
      ) : error ? (
        <div className="p-10 bg-rose-50 border border-rose-100 rounded-[2.5rem] flex flex-col items-center text-center">
          <div className="w-16 h-16 bg-rose-100 text-rose-500 rounded-2xl flex items-center justify-center mb-6">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-[1.4rem] font-black text-primary mb-2">Erro na Integração</h3>
          <p className="text-rose-600 font-bold mb-8 max-w-md">{error}</p>
          <button 
            onClick={loadAccounts}
            className="px-8 py-3 bg-primary text-white rounded-2xl text-[13px] font-black uppercase tracking-widest hover:bg-primary/90 transition-all"
          >
            Tentar Novamente
          </button>
        </div>
      ) : (isLoading && campaigns.length === 0) ? (
        <CampaignsSkeleton />
      ) : (
        <>
          {/* Rótulo de seção — dá ritmo e contexto do período */}
          <div className="flex items-center justify-between gap-4 mb-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
              Resumo · {periodoLabel.toLowerCase()}
            </p>
            {isLoading && (
              <span className="inline-flex items-center gap-1.5 text-[10px] font-black text-primary uppercase tracking-wider">
                <RefreshCw size={11} className="animate-spin" /> atualizando
              </span>
            )}
          </div>

          {/* Summary Cards — prioridade de geração de leads */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
            <SummaryCard
              label="Investimento"
              value={`R$ ${totals.spend.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
              icon={DollarSign}
              color="accent"
              sub={`Total investido · ${periodoLabel.toLowerCase()}`}
              info="Quanto foi gasto em anúncios no período selecionado."
            />
            <SummaryCard
              label="Leads"
              value={totals.leads.toLocaleString('pt-BR')}
              icon={MousePointer2}
              color="purple"
              sub={`${totals.clicks.toLocaleString('pt-BR')} cliques · ${avgCtr.toFixed(2)}% CTR`}
              info="Conversas/leads gerados pelos anúncios (mensagens iniciadas)."
            />
            <SummaryCard
              label="CPL — Custo por Lead"
              value={totals.leads > 0 ? `R$ ${avgCpl.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '—'}
              icon={Target}
              color="amber"
              sub="Investimento ÷ leads — quanto menor, melhor"
              info="A métrica-chave pra geração de leads: quanto custa, em média, cada lead gerado."
            />
            <SummaryCard
              label="CTR"
              value={`${avgCtr.toFixed(2)}%`}
              icon={TrendingUp}
              color="blue"
              sub={`CPC médio R$ ${avgCpc.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`}
              info="Taxa de cliques: % de quem viu o anúncio e clicou. Acima de ~1% costuma ser bom."
            />
          </div>

          {/* Faixa secundária — métricas de alcance/saúde do anúncio */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
            <MiniStat label="Impressões" value={totals.impressions.toLocaleString('pt-BR')} icon={Eye} info="Quantas vezes os anúncios foram exibidos (conta repetições)." />
            <MiniStat label="Alcance" value={totals.reach.toLocaleString('pt-BR')} icon={Eye} info="Quantas pessoas DIFERENTES viram os anúncios." />
            <MiniStat label="CPM" value={`R$ ${cpm.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`} icon={DollarSign} info="Custo por mil impressões — preço pra alcançar o público." />
            <MiniStat label="Frequência" value={frequency > 0 ? `${frequency.toFixed(1)}x` : '—'} icon={RefreshCw} info="Quantas vezes, em média, cada pessoa viu o anúncio. Acima de ~3x indica desgaste (fadiga de criativo)." />
          </div>

          {/* ── Mapa de Aquisição: Investido → Leads → Alunos → Faturamento ── */}
          <div className="mb-12">
            <div className="flex items-center gap-3 mb-5">
              <h3 className="text-[1.2rem] font-black text-primary">Mapa de Aquisição</h3>
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.18em]">investido → leads → alunos → faturamento</span>
            </div>
            <div className="flex flex-col lg:flex-row items-stretch gap-3 lg:gap-2">
              <AcqStage icon={DollarSign} color="#fc3000" label="Investido" value={brl(acqInvest)} sub={`Meta · ${periodoLabel.toLowerCase()}`} />
              <div className="hidden lg:flex items-center text-slate-300"><ArrowRight size={22} /></div>
              <AcqStage icon={MousePointer2} color="#268549" label="Leads" value={acqLeads.toLocaleString('pt-BR')} sub={`CPL ${acqCpl > 0 ? brl(acqCpl) : '—'}`} />
              <div className="hidden lg:flex items-center text-slate-300"><ArrowRight size={22} /></div>
              <AcqStage icon={Users} color="#3a0f06" label="Alunos novos" value={hasEvo ? acqAlunos.toLocaleString('pt-BR') : '—'} sub={`CAC ${acqCac > 0 ? brl(acqCac) : '—'}`} badge="EVO" />
              <div className="hidden lg:flex items-center text-slate-300"><ArrowRight size={22} /></div>
              <AcqStage icon={TrendingUp} color="#141414" label="Faturamento" value={hasEvo ? brl(acqFaturamento) : '—'} sub={acqRoas > 0 ? `ROAS ${acqRoas.toFixed(1)}x` : 'matrículas do mês'} badge="EVO" />
            </div>
            {/* Resumo de eficiência */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
              <MiniStat label="CPL (custo/lead)" value={acqCpl > 0 ? brl(acqCpl) : '—'} icon={Target} info="Investido ÷ leads gerados." />
              <MiniStat label="CAC (custo/aluno)" value={acqCac > 0 ? brl(acqCac) : '—'} icon={Target} info="Investido ÷ alunos novos do mês (EVO). CAC blended — todos os alunos novos, não só os do Meta." />
              <MiniStat label="ROAS (retorno)" value={acqRoas > 0 ? `${acqRoas.toFixed(1)}x` : '—'} icon={Award} info="Faturamento das matrículas ÷ investido. Reais que entram por real investido." />
              <MiniStat label="LTV / CAC" value={acqLtvCac > 0 ? `${acqLtvCac.toFixed(1)}x` : '—'} icon={Award} info="Valor do aluno (LTV) ÷ custo de adquiri-lo (CAC). Ideal ≥ 3x." />
            </div>
            {!hasEvo && (
              <p className="text-[11px] font-bold text-amber-600 mt-3">Aguardando dados da EVO (alunos/faturamento) pra completar o mapa.</p>
            )}
          </div>

          {/* ── Indicadores Operacionais (antiga aba KPIs, consolidada aqui) ── */}
          {hasEvo && (
            <div className="mb-12">
              <div className="flex items-center gap-3 mb-5">
                <h3 className="text-[1.2rem] font-black text-primary">Indicadores Operacionais</h3>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.18em]">LTV · retenção · risco · base · dado real EVO</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                <SummaryCard label="LTV" value={acqLtv > 0 ? brl(acqLtv) : '—'} icon={TrendingUp} color="accent"
                  sub={`${opLifetimeMeses} meses × ticket`} info="Quanto um aluno gera durante todo o tempo que fica (ticket × meses, derivado do churn real)." />
                <SummaryCard label="Retenção" value={`${opRetencao}%`} icon={Award} color="blue"
                  sub="Adimplentes ÷ ativos" info="% dos alunos ativos que estão em dia." />
                <SummaryCard label="% Evasão" value={`${opEvasao.toFixed(2).replace('.', ',')}%`} icon={Users} color="rose"
                  sub={`${opInativos.toLocaleString('pt-BR')} inativos`} info="% da base que está inativa/saiu." />
                <SummaryCard label="% Inadimplência" value={`${opInadimplencia.toFixed(2).replace('.', ',')}%`} icon={AlertCircle} color="amber"
                  sub="Em aberto ÷ ativos" info="% dos alunos ativos com mensalidade em aberto." />
                <SummaryCard label="% Churn Mensal" value={`${opChurnPct.toFixed(2).replace('.', ',')}%`} icon={Users} color="purple"
                  sub="Cancel. ÷ base" info="Cancelamentos do mês ÷ base ativa. Alimenta o LTV." />
              </div>
            </div>
          )}

          {/* ── Melhor campanha em destaque ── */}
          {(() => {
            const ativas = campaigns.filter(c => c.status === 'ACTIVE');
            if (ativas.length === 0) return null;
            // Score: leads gerados (peso principal). Empate → menor CPL ganha.
            // CPL = spend / leads (calculado se ambos > 0).
            const scored = ativas.map(c => {
              const leads = Number(c.insights?.leads) || 0;
              const spend = Number(c.insights?.spend) || 0;
              const ctr = Number(c.insights?.ctr) || 0;
              const cpl = leads > 0 ? spend / leads : Infinity;
              return { c, leads, spend, ctr, cpl };
            }).sort((a, b) => {
              if (b.leads !== a.leads) return b.leads - a.leads;       // mais leads primeiro
              return a.cpl - b.cpl;                                      // menor custo por lead
            });
            const top = scored[0];
            if (top.leads === 0 && top.ctr === 0) return null;          // nada relevante
            return (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.1 }}
                className="mb-6 p-7 bg-gradient-to-br from-amber-50 via-yellow-50 to-amber-50 border border-amber-200/60 rounded-[2.5rem] shadow-[0_8px_30px_rgba(251,191,36,0.10)]"
              >
                <div className="flex items-start gap-5">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-yellow-500 flex items-center justify-center shadow-lg shadow-amber-300/30 shrink-0">
                    <Trophy size={26} className="text-white" strokeWidth={2.5} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-black text-amber-700 uppercase tracking-[0.2em] mb-1">
                      🏆 Melhor performando
                    </p>
                    <h3 className="text-[1.4rem] font-black text-primary leading-tight tracking-tight mb-1 truncate">
                      {top.c.name}
                    </h3>
                    <p className="text-[12px] font-bold text-slate-500 uppercase tracking-tighter">
                      {top.c.objective.replace(/_/g, ' ')}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5 pt-5 border-t border-amber-200/40">
                  <div>
                    <p className="text-[10px] font-black text-amber-700/70 uppercase tracking-wider mb-1">Leads</p>
                    <p className="text-[1.6rem] font-black text-primary tabular-nums leading-none">
                      {top.leads.toLocaleString('pt-BR')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-amber-700/70 uppercase tracking-wider mb-1">CPL</p>
                    <p className="text-[1.6rem] font-black text-primary tabular-nums leading-none">
                      {top.cpl !== Infinity
                        ? `R$ ${top.cpl.toFixed(2).replace('.', ',')}`
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-amber-700/70 uppercase tracking-wider mb-1">CTR</p>
                    <p className="text-[1.6rem] font-black text-primary tabular-nums leading-none">
                      {top.ctr.toFixed(2)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] font-black text-amber-700/70 uppercase tracking-wider mb-1">Investido</p>
                    <p className="text-[1.6rem] font-black text-primary tabular-nums leading-none">
                      R$ {top.spend.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })()}

          {/* Campaigns Table */}
          <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
            <div className="px-6 sm:px-8 py-6 border-b border-slate-50 flex flex-col gap-4">
              {/* Linha 1: título + contador + ordenação */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <h3 className="text-[1.2rem] font-black text-primary">Campanhas</h3>
                  {campaigns.length > 0 && (
                    <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 text-[11px] font-black tabular-nums">
                      {ativasCount} ativas · {campaigns.length} total
                    </span>
                  )}
                </div>
                <label className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider hidden sm:block">Ordenar por</span>
                  <select
                    value={sortBy}
                    onChange={e => setSortBy(e.target.value as typeof sortBy)}
                    className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-[12px] font-black text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 cursor-pointer"
                  >
                    <option value="leads">Mais leads</option>
                    <option value="cpl">Menor CPL</option>
                    <option value="spend">Maior investimento</option>
                    <option value="ctr">Maior CTR</option>
                  </select>
                </label>
              </div>

              {/* Linha 2: busca + filtro de status */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="relative flex-1 min-w-[180px]">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    value={campaignSearch}
                    onChange={e => setCampaignSearch(e.target.value)}
                    placeholder="Buscar campanha ou objetivo…"
                    className="w-full pl-9 pr-9 py-2.5 bg-slate-50 border border-slate-100 rounded-xl text-[13px] font-bold text-primary placeholder:text-slate-400 placeholder:font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  />
                  {campaignSearch && (
                    <button
                      type="button"
                      onClick={() => setCampaignSearch('')}
                      aria-label="Limpar busca"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-slate-400 hover:text-primary hover:bg-slate-200/60 transition-colors"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="flex bg-slate-100 p-1 rounded-xl shrink-0" role="group" aria-label="Filtrar por status">
                  {([
                    { id: 'todas' as const,    label: 'Todas' },
                    { id: 'ativas' as const,   label: 'Ativas' },
                    { id: 'pausadas' as const, label: 'Pausadas' },
                  ]).map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => setStatusFilter(opt.id)}
                      aria-pressed={statusFilter === opt.id}
                      className={`px-3.5 py-1.5 rounded-lg text-[11px] font-black transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                        statusFilter === opt.id ? 'bg-white text-primary shadow-sm' : 'text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50/50">
                    <th className="px-8 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Campanha</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Status</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Investido</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Leads</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">CPL</th>
                    <th className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">CTR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {campaignsView.map((campaign, idx) => (
                    <motion.tr
                      key={campaign.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(idx * 0.03, 0.35) }}
                      className="group hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-8 py-5">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-black text-primary group-hover:text-accent transition-colors">
                            {campaign.name}
                          </span>
                          <span className="text-[11px] font-bold text-slate-400 uppercase tracking-tighter">
                            {campaign.objective.replace(/_/g, ' ')}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex justify-center">
                          <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${
                            campaign.status === 'ACTIVE' 
                              ? 'bg-emerald-50 text-emerald-600' 
                              : 'bg-slate-100 text-slate-500'
                          }`}>
                            {campaign.status === 'ACTIVE' ? 'Ativa' : 'Pausada'}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-5 text-right font-black text-primary text-[14px]">
                        R$ {Number(campaign.insights?.spend || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="px-6 py-5 text-right font-bold text-slate-600 text-[13px]">
                        {Number(campaign.insights?.leads || 0).toLocaleString('pt-BR')}
                      </td>
                      <td className="px-6 py-5 text-right text-[13px]">
                        {(() => {
                          const cpl = cplOf(campaign);
                          if (cpl === Infinity) return <span className="font-bold text-slate-300">—</span>;
                          // Verde = abaixo (ou igual) da média (melhor); vermelho = acima.
                          const tone = avgCpl > 0 && cpl > avgCpl ? 'text-rose-600' : 'text-emerald-600';
                          return <span className={`font-black tabular-nums ${tone}`}>R$ {cpl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
                        })()}
                      </td>
                      <td className="px-6 py-5 text-right font-bold text-slate-400 text-[13px] tabular-nums">
                        {Number(campaign.insights?.ctr || 0).toFixed(2)}%
                      </td>
                    </motion.tr>
                  ))}
                  {campaignsView.length === 0 && !isLoading && (
                    <tr>
                      <td colSpan={6} className="px-8 py-16 text-center">
                        {campaigns.length === 0 ? (
                          <p className="text-slate-400 font-bold">Nenhuma campanha encontrada para esta conta.</p>
                        ) : (
                          <div className="flex flex-col items-center gap-3">
                            <p className="text-slate-400 font-bold">Nenhuma campanha bate com o filtro.</p>
                            <button
                              onClick={() => { setCampaignSearch(''); setStatusFilter('todas'); }}
                              className="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-[12px] font-black hover:bg-slate-200 transition-colors"
                            >
                              Limpar filtros
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Integration Note */}
          <div className="mt-12 p-8 bg-gradient-to-br from-primary to-[#3a0f06] rounded-[3rem] text-white relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -mr-32 -mt-32 blur-3xl" />
            <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
              <div className="flex-1">
                <h3 className="text-[1.8rem] font-black mb-2 tracking-tight">Vincular com KPIs Financeiros</h3>
                <p className="text-white/70 font-semibold leading-relaxed max-w-xl">
                  Os dados de investimento mkt desta tela são enviados automaticamente para a aba de KPIs. 
                  Isso permite o cálculo real do CAC e LTV/CAC baseado no seu gasto atual em Ads.
                </p>
              </div>
              <div className="flex gap-4 shrink-0">
                <div className="px-6 py-4 bg-white/10 backdrop-blur-md rounded-2xl border border-white/10 text-center">
                  <p className="text-white/40 text-[10px] font-black uppercase tracking-widest mb-1">{dateFrom && dateTo ? 'Gasto período' : 'Gasto 30d'}</p>
                  <p className="text-[1.5rem] font-black text-accent">R$ {totals.spend.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                </div>
                <div className="px-6 py-4 bg-white/10 backdrop-blur-md rounded-2xl border border-white/10 text-center">
                  <p className="text-white/40 text-[10px] font-black uppercase tracking-widest mb-1">Custo / Lead</p>
                  <p className="text-[1.5rem] font-black text-accent">{totals.leads > 0 ? `R$ ${avgCpl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</p>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Esqueleto de carregamento — espelha o layout real (cards + faixa + tabela). */
function CampaignsSkeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-live="polite">
      <div className="h-2.5 w-32 bg-slate-100 rounded-full mb-4" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="p-6 bg-white rounded-[2rem] border border-slate-100 shadow-sm">
            <div className="w-12 h-12 bg-slate-100 rounded-2xl mb-4" />
            <div className="h-2.5 w-20 bg-slate-100 rounded-full mb-3" />
            <div className="h-7 w-28 bg-slate-100 rounded-lg mb-2" />
            <div className="h-2 w-24 bg-slate-100 rounded-full" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="px-5 py-4 bg-white rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-slate-100 shrink-0" />
            <div className="flex-1">
              <div className="h-2 w-14 bg-slate-100 rounded-full mb-2" />
              <div className="h-4 w-16 bg-slate-100 rounded" />
            </div>
          </div>
        ))}
      </div>
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-8 py-6 border-b border-slate-50">
          <div className="h-4 w-44 bg-slate-100 rounded" />
        </div>
        <div className="divide-y divide-slate-50">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-8 py-5 flex items-center justify-between gap-6">
              <div className="h-4 flex-1 max-w-[40%] bg-slate-100 rounded" />
              <div className="h-4 w-16 bg-slate-100 rounded" />
              <div className="h-4 w-12 bg-slate-100 rounded" />
              <div className="h-4 w-12 bg-slate-100 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Etapa do Mapa de Aquisição (Investido → Leads → Alunos → Faturamento). */
function AcqStage({ icon: Icon, color, label, value, sub, badge }: {
  icon: LucideIcon; color: string; label: string; value: string; sub?: string; badge?: string;
}) {
  return (
    <div className="flex-1 min-w-[150px] p-6 bg-white rounded-[2rem] border border-slate-100 shadow-[0_4px_20px_rgba(0,0,0,0.03)] relative">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: `${color}1a` }}>
        <Icon size={22} style={{ color }} strokeWidth={2.5} />
      </div>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.15em] mb-1.5">{label}</p>
      <p className="text-[1.7rem] font-black tracking-tighter leading-none" style={{ color }}>{value}</p>
      {sub && <p className="text-[11px] font-bold text-slate-400 mt-2">{sub}</p>}
      {badge && (
        <span className="absolute top-5 right-5 text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full bg-slate-50 text-slate-500 border border-slate-100">{badge}</span>
      )}
    </div>
  );
}

interface SummaryCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  color: 'accent' | 'blue' | 'purple' | 'amber' | 'rose' | 'primary';
  sub?: string;
  info?: string;
}

function SummaryCard({ label, value, icon: Icon, color, sub, info }: SummaryCardProps) {
  const colors: Record<SummaryCardProps['color'], { bg: string; text: string; icon: string }> = {
    accent:  { bg: 'bg-accent/10', text: 'text-accent', icon: 'text-accent' },
    blue:    { bg: 'bg-blue-50',   text: 'text-blue-600', icon: 'text-blue-500' },
    purple:  { bg: 'bg-purple-50', text: 'text-purple-600', icon: 'text-purple-500' },
    amber:   { bg: 'bg-amber-50',  text: 'text-amber-600', icon: 'text-amber-500' },
    rose:    { bg: 'bg-rose-50',   text: 'text-rose-500', icon: 'text-rose-400' },
    primary: { bg: 'bg-primary/5', text: 'text-primary', icon: 'text-primary' },
  };
  const c = colors[color] || colors.accent;

  return (
    <div className="p-6 bg-white rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
      <div className={`w-12 h-12 ${c.bg} rounded-2xl flex items-center justify-center mb-4`}>
        <Icon size={22} className={c.icon} />
      </div>
      <div className="flex items-center gap-1.5 mb-1">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
        {info && <InfoTooltip text={info} label={`O que é: ${label}`} />}
      </div>
      <p className={`text-[1.5rem] lg:text-[1.8rem] font-black ${c.text} tracking-tighter leading-none mb-2 whitespace-nowrap`}>{value}</p>
      <p className="text-[11px] font-bold text-slate-400">{sub}</p>
    </div>
  );
}

interface MiniStatProps {
  label: string;
  value: string;
  icon: LucideIcon;
  info?: string;
}

/** Métrica secundária compacta (alcance/saúde do anúncio). */
function MiniStat({ label, value, icon: Icon, info }: MiniStatProps) {
  return (
    <div className="px-5 py-4 bg-white rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center shrink-0">
        <Icon size={16} className="text-slate-400" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
          {info && <InfoTooltip text={info} label={`O que é: ${label}`} />}
        </div>
        <p className="text-[1.05rem] font-black text-slate-700 tracking-tighter leading-tight truncate">{value}</p>
      </div>
    </div>
  );
}
