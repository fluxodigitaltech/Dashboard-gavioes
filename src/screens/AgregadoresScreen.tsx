import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Save, Trash2, RefreshCw, Users, TrendingUp, DollarSign, ExternalLink } from 'lucide-react';

interface Agregador {
  id: string;
  nome: string;
  plataforma: string;
  unidade: string;
  membrosAtivos: number;
  receitaMensal: number;
  percentualRepasse: number;
  status: 'ativo' | 'inativo' | 'negociacao';
  observacao: string;
}

const PLATAFORMAS = ['Gympass / Wellhub', 'TotalPass', 'Benefit Club', 'Flash Benefícios', 'Outro'];
const STATUS_OPTS = [
  { value: 'ativo',       label: 'Ativo',        color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  { value: 'inativo',     label: 'Inativo',      color: 'text-slate-400 bg-slate-50 border-slate-200' },
  { value: 'negociacao',  label: 'Em Negociação', color: 'text-amber-600 bg-amber-50 border-amber-200' },
];

const UNIDADES = ['Todas', 'Gaviões'];

const SAMPLE: Agregador[] = [
  { id: '1', nome: 'Gympass', plataforma: 'Gympass / Wellhub', unidade: 'Todas', membrosAtivos: 0, receitaMensal: 0, percentualRepasse: 70, status: 'ativo', observacao: '' },
  { id: '2', nome: 'TotalPass', plataforma: 'TotalPass', unidade: 'Todas', membrosAtivos: 0, receitaMensal: 0, percentualRepasse: 65, status: 'negociacao', observacao: '' },
];

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export function AgregadoresScreen() {
  const LS_KEY = 'gb_agregadores_v1';
  const load = (): Agregador[] => {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : SAMPLE; } catch { return SAMPLE; }
  };

  const [items, setItems]         = useState<Agregador[]>(load);
  const [editing, setEditing]     = useState<Agregador | null>(null);
  const [filterUnit, setFilterUnit] = useState('Todas');
  const [isSaving, setIsSaving]   = useState(false);
  const [showForm, setShowForm]   = useState(false);

  const save = (list: Agregador[]) => {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    setItems(list);
  };

  const handleSave = async () => {
    if (!editing) return;
    setIsSaving(true);
    await new Promise(r => setTimeout(r, 300));
    const exists = items.some(i => i.id === editing.id);
    const updated = exists ? items.map(i => i.id === editing.id ? editing : i) : [...items, editing];
    save(updated);
    setEditing(null);
    setShowForm(false);
    setIsSaving(false);
  };

  const handleDelete = (id: string) => {
    save(items.filter(i => i.id !== id));
  };

  const handleNew = () => {
    setEditing({ id: genId(), nome: '', plataforma: PLATAFORMAS[0], unidade: 'Todas', membrosAtivos: 0, receitaMensal: 0, percentualRepasse: 70, status: 'ativo', observacao: '' });
    setShowForm(true);
  };

  const filtered = filterUnit === 'Todas' ? items : items.filter(i => i.unidade === filterUnit || i.unidade === 'Todas');

  const totalAtivos  = filtered.filter(i => i.status === 'ativo').reduce((s, i) => s + i.membrosAtivos, 0);
  const totalReceita = filtered.filter(i => i.status === 'ativo').reduce((s, i) => s + i.receitaMensal, 0);
  const totalAtivosCount = filtered.filter(i => i.status === 'ativo').length;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* Header */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="mb-12">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">Parcerias & Benefícios</span>
        <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
          Agregadores <span className="text-accent">& Parceiros</span>
        </h1>
        <p className="text-slate-400 text-[16px] font-semibold max-w-xl">
          Gestão de plataformas parceiras (Gympass, TotalPass, etc.) e membros provenientes dessas parcerias.
        </p>
      </motion.div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        {[
          { label: 'Membros via Agregadores', value: totalAtivos.toLocaleString('pt-BR'), icon: Users,      color: 'text-primary', bg: 'bg-[#fde7e2]' },
          { label: 'Receita Mensal Parceiros', value: `R$ ${totalReceita.toLocaleString('pt-BR')}`, icon: DollarSign, color: 'text-accent',  bg: 'bg-[#fdefea]' },
          { label: 'Plataformas Ativas',       value: totalAtivosCount.toString(),                   icon: TrendingUp,  color: 'text-primary', bg: 'bg-slate-100' },
        ].map(({ label, value, icon: Icon, color, bg }) => (
          <motion.div
            key={label}
            initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
            className="bg-white rounded-[2.5rem] border border-slate-100 p-8 flex items-center gap-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)]"
          >
            <div className={`w-14 h-14 ${bg} rounded-2xl flex items-center justify-center shrink-0`}>
              <Icon size={22} className={color} />
            </div>
            <div>
              <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-[2rem] font-black tracking-tighter ${color}`}>{value}</p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Filters + Actions */}
      <motion.div
        initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }}
        className="flex flex-col sm:flex-row gap-4 mb-8"
      >
        <select
          value={filterUnit}
          onChange={e => setFilterUnit(e.target.value)}
          className="px-5 py-3.5 bg-[#F8FAFB] border border-slate-100 rounded-2xl text-[13px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/20 cursor-pointer"
        >
          {UNIDADES.map(u => <option key={u} value={u}>{u === 'Todas' ? 'Todas as Unidades' : u}</option>)}
        </select>
        <button
          onClick={handleNew}
          className="ml-auto flex items-center gap-2 px-6 py-3.5 bg-primary text-white rounded-2xl text-[13px] font-black uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg shadow-primary/20"
        >
          <Plus size={16} /> Novo Agregador
        </button>
      </motion.div>

      {/* Table */}
      <motion.div
        initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2 }}
        className="bg-white rounded-[2.5rem] border border-slate-100 overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.04)]"
      >
        {/* overflow-x-auto: em telas estreitas a tabela desliza no horizontal em
            vez de espremer as 7 colunas (mesmo padrão de Leads/Comercial). */}
        <div className="overflow-x-auto">
        <div className="min-w-[820px]">
        <div className="bg-[#fafafa] px-8 py-5 grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr_1fr_auto] gap-4 border-b border-slate-100">
          {['Plataforma', 'Nome / Contrato', 'Unidade', 'Membros', 'Receita/Mês', 'Status', ''].map(h => (
            <span key={h} className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{h}</span>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="py-20 text-center">
            <ExternalLink size={40} className="mx-auto text-slate-200 mb-4" />
            <p className="text-slate-400 font-bold text-[15px]">Nenhum agregador cadastrado</p>
            <p className="text-slate-300 text-[13px] mt-1">Clique em "Novo Agregador" para adicionar</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-50">
            {filtered.map((item, idx) => {
              const statusCfg = STATUS_OPTS.find(s => s.value === item.status) ?? STATUS_OPTS[0];
              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: idx * 0.04 }}
                  className="px-8 py-5 grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr_1fr_auto] gap-4 items-center hover:bg-[#fafafa] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#fde7e2] rounded-2xl flex items-center justify-center shrink-0">
                      <span className="text-[11px] font-black text-primary">{item.plataforma.slice(0, 2).toUpperCase()}</span>
                    </div>
                    <span className="font-black text-[14px] text-[#0F172A]">{item.plataforma}</span>
                  </div>
                  <span className="font-bold text-[13px] text-slate-600">{item.nome || '—'}</span>
                  <span className="font-bold text-[13px] text-slate-500">{item.unidade}</span>
                  <span className="font-black text-[13px] text-primary">{item.membrosAtivos.toLocaleString('pt-BR')}</span>
                  <span className="font-black text-[13px] text-primary">R$ {item.receitaMensal.toLocaleString('pt-BR')}</span>
                  <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-[11px] font-black border ${statusCfg.color}`}>
                    {statusCfg.label}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setEditing({ ...item }); setShowForm(true); }}
                      className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-400 hover:bg-primary hover:text-white hover:border-primary transition-all text-[11px] font-black"
                    >✎</button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="w-8 h-8 flex items-center justify-center rounded-xl border border-slate-200 text-slate-400 hover:bg-rose-500 hover:text-white hover:border-rose-500 transition-all"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
        </div>
        </div>
      </motion.div>

      {/* Form Modal */}
      <AnimatePresence>
        {showForm && editing && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={() => { setShowForm(false); setEditing(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }} animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-lg overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="px-10 pt-10 pb-6 border-b border-slate-100">
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400 mb-1">
                  {items.some(i => i.id === editing.id) ? 'Editar' : 'Novo'} Agregador
                </p>
                <h3 className="text-[1.8rem] font-black text-primary tracking-tight">Configurar Parceiro</h3>
              </div>

              <div className="px-10 py-8 space-y-5">
                {[
                  { label: 'Nome do Contrato / Responsável', field: 'nome', type: 'text', placeholder: 'Ex: Gympass - Contrato 2025' },
                ].map(({ label, field, type, placeholder }) => (
                  <div key={field}>
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">{label}</label>
                    <input
                      type={type} value={String((editing as unknown as Record<string, unknown>)[field] ?? '')} placeholder={placeholder}
                      onChange={e => setEditing({ ...editing, [field]: e.target.value })}
                      className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Plataforma</label>
                    <select
                      value={editing.plataforma}
                      onChange={e => setEditing({ ...editing, plataforma: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                    >
                      {PLATAFORMAS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Unidade</label>
                    <select
                      value={editing.unidade}
                      onChange={e => setEditing({ ...editing, unidade: e.target.value })}
                      className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                    >
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  {[
                    { label: 'Membros Ativos', field: 'membrosAtivos', suffix: '' },
                    { label: 'Receita/Mês (R$)', field: 'receitaMensal', suffix: 'R$' },
                    { label: 'Repasse %', field: 'percentualRepasse', suffix: '%' },
                  ].map(({ label, field, suffix }) => (
                    <div key={field}>
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">{label}</label>
                      <div className="relative">
                        {suffix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-black text-slate-400">{suffix}</span>}
                        <input
                          type="number" value={Number((editing as unknown as Record<string, unknown>)[field] ?? 0)}
                          onChange={e => setEditing({ ...editing, [field]: Math.max(0, Number(e.target.value)) })}
                          className={`w-full ${suffix ? 'pl-7' : 'pl-4'} pr-3 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-black text-primary focus:outline-none focus:ring-2 focus:ring-accent/30`}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <div>
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Status</label>
                  <div className="flex gap-3">
                    {STATUS_OPTS.map(s => (
                      <button
                        key={s.value}
                        onClick={() => setEditing({ ...editing, status: s.value as Agregador['status'] })}
                        className={`flex-1 py-2.5 rounded-2xl text-[12px] font-black border transition-all ${editing.status === s.value ? s.color : 'bg-slate-50 border-slate-200 text-slate-400'}`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Observações</label>
                  <textarea
                    value={editing.observacao} rows={2}
                    onChange={e => setEditing({ ...editing, observacao: e.target.value })}
                    placeholder="Contato, condições especiais, data de revisão..."
                    className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-bold text-slate-600 focus:outline-none focus:ring-2 focus:ring-accent/30 resize-none"
                  />
                </div>
              </div>

              <div className="px-10 pb-10 flex gap-4">
                <button
                  onClick={() => { setShowForm(false); setEditing(null); }}
                  className="flex-1 py-3.5 border border-slate-200 rounded-2xl text-[12px] font-black text-slate-500 hover:bg-slate-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleSave} disabled={isSaving}
                  className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-primary text-white rounded-2xl text-[12px] font-black hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  {isSaving ? <><RefreshCw size={14} className="animate-spin" /> Salvando…</> : <><Save size={14} /> Salvar</>}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
