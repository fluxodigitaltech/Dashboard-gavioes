import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Save, Trash2, RefreshCw, Activity, TrendingUp, DollarSign, ExternalLink } from 'lucide-react';

// Modelo de repasse: cada agregador (Wellhub, Totalpass, Gurupass, GoGood) rende
// um valor POR CHECK-IN. A contagem de check-ins é puxada manualmente do EVO
// (Gerencial → Agregadores) e o dash calcula a receita = check-ins × repasse.
interface Agregador {
  id: string;
  nome: string;
  unidade: string;
  checkins: number;            // check-ins no período (contagem do EVO)
  repassePorCheckin: number;   // R$ por check-in
  status: 'ativo' | 'inativo' | 'negociacao';
  observacao: string;
}

const STATUS_OPTS = [
  { value: 'ativo',       label: 'Ativo',        color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  { value: 'inativo',     label: 'Inativo',      color: 'text-slate-400 bg-slate-50 border-slate-200' },
  { value: 'negociacao',  label: 'Em Negociação', color: 'text-amber-600 bg-amber-50 border-amber-200' },
];

const UNIDADES = ['Todas', 'Gaviões'];

// Valores de repasse (média por tier — edite conforme o mix real da unidade).
const SAMPLE: Agregador[] = [
  { id: 'wellhub',  nome: 'Wellhub (Gympass)', unidade: 'Todas', checkins: 0, repassePorCheckin: 15.50, status: 'ativo', observacao: 'Tiers: Basic+ R$11,03 · Silver R$15,50 · Silver+ R$20,20 · teto ~13/mês · 1º check-in (experimental) sem repasse' },
  { id: 'totalpass', nome: 'Totalpass',         unidade: 'Todas', checkins: 0, repassePorCheckin: 12.50, status: 'ativo', observacao: 'Tiers: TP1+ R$11,10 · TP2 R$12,50 · TP3 R$15,50 · teto ~13/mês' },
  { id: 'gurupass', nome: 'Gurupass',           unidade: 'Todas', checkins: 0, repassePorCheckin: 0,     status: 'ativo', observacao: 'Definir valor de repasse por check-in' },
  { id: 'gogood',   nome: 'GoGood',             unidade: 'Todas', checkins: 0, repassePorCheckin: 0,     status: 'ativo', observacao: 'Definir valor de repasse por check-in' },
];

const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function receitaDe(a: Agregador) { return (a.checkins || 0) * (a.repassePorCheckin || 0); }

export function AgregadoresScreen() {
  const LS_KEY = 'gb_agregadores_v2'; // v2: modelo check-ins × repasse
  const load = (): Agregador[] => {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : SAMPLE; } catch { return SAMPLE; }
  };

  const [items, setItems]           = useState<Agregador[]>(load);
  const [editing, setEditing]       = useState<Agregador | null>(null);
  const [filterUnit, setFilterUnit] = useState('Todas');
  const [isSaving, setIsSaving]     = useState(false);
  const [showForm, setShowForm]     = useState(false);

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

  const handleDelete = (id: string) => save(items.filter(i => i.id !== id));

  const handleNew = () => {
    setEditing({ id: genId(), nome: '', unidade: 'Todas', checkins: 0, repassePorCheckin: 0, status: 'ativo', observacao: '' });
    setShowForm(true);
  };

  const resetPadrao = () => {
    if (confirm('Restaurar os 4 agregadores padrão (Wellhub, Totalpass, Gurupass, GoGood) com os valores de repasse? Isso substitui a lista atual.')) {
      save(SAMPLE);
    }
  };

  const filtered = filterUnit === 'Todas' ? items : items.filter(i => i.unidade === filterUnit || i.unidade === 'Todas');

  const ativos        = filtered.filter(i => i.status === 'ativo');
  const totalCheckins = ativos.reduce((s, i) => s + (i.checkins || 0), 0);
  const totalReceita  = ativos.reduce((s, i) => s + receitaDe(i), 0);
  const ticketMedio   = totalCheckins > 0 ? totalReceita / totalCheckins : 0;

  return (
    <div className="max-w-7xl mx-auto px-6 py-10">

      {/* Header */}
      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.5 }} className="mb-12">
        <span className="text-[11px] uppercase font-black text-primary tracking-[0.2em] mb-3 block">Parcerias & Benefícios</span>
        <h1 className="text-[3.5rem] font-black text-primary leading-none tracking-tighter mb-4">
          Agregadores <span className="text-accent">& Receita</span>
        </h1>
        <p className="text-slate-400 text-[16px] font-semibold max-w-2xl">
          Receita gerada por check-ins de Wellhub, Totalpass, Gurupass e GoGood. Puxe a contagem de check-ins no EVO
          (Gerencial → Agregadores) e informe aqui — o dash calcula a receita pelo repasse por check-in.
        </p>
      </motion.div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        {[
          { label: 'Receita de Agregadores', value: brl(totalReceita),                       icon: DollarSign, color: 'text-accent',  bg: 'bg-[#fdefea]', big: true },
          { label: 'Check-ins no período',   value: totalCheckins.toLocaleString('pt-BR'),    icon: Activity,   color: 'text-primary', bg: 'bg-[#fde7e2]' },
          { label: 'Ticket médio / check-in', value: brl(ticketMedio),                        icon: TrendingUp, color: 'text-primary', bg: 'bg-slate-100' },
        ].map(({ label, value, icon: Icon, color, bg, big }) => (
          <motion.div
            key={label}
            initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
            className={`bg-white rounded-[2.5rem] border p-8 flex items-center gap-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)] ${big ? 'border-accent/30 ring-1 ring-accent/10' : 'border-slate-100'}`}
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
        <div className="ml-auto flex gap-3">
          <button
            onClick={resetPadrao}
            className="flex items-center gap-2 px-5 py-3.5 border border-slate-200 text-slate-500 rounded-2xl text-[13px] font-black uppercase tracking-widest hover:bg-slate-50 transition-all"
          >
            <RefreshCw size={15} /> Padrão
          </button>
          <button
            onClick={handleNew}
            className="flex items-center gap-2 px-6 py-3.5 bg-primary text-white rounded-2xl text-[13px] font-black uppercase tracking-widest hover:bg-primary/90 transition-all shadow-lg shadow-primary/20"
          >
            <Plus size={16} /> Novo Agregador
          </button>
        </div>
      </motion.div>

      {/* Table */}
      <motion.div
        initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.2 }}
        className="bg-white rounded-[2.5rem] border border-slate-100 overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.04)]"
      >
        <div className="overflow-x-auto">
        <div className="min-w-[820px]">
        <div className="bg-[#fafafa] px-8 py-5 grid grid-cols-[2fr_1fr_1.3fr_1.3fr_1fr_auto] gap-4 border-b border-slate-100">
          {['Agregador', 'Check-ins', 'Repasse / check-in', 'Receita', 'Status', ''].map(h => (
            <span key={h} className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{h}</span>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="py-20 text-center">
            <ExternalLink size={40} className="mx-auto text-slate-200 mb-4" />
            <p className="text-slate-400 font-bold text-[15px]">Nenhum agregador cadastrado</p>
            <p className="text-slate-300 text-[13px] mt-1">Clique em "Padrão" para carregar os 4, ou "Novo Agregador"</p>
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
                  className="px-8 py-5 grid grid-cols-[2fr_1fr_1.3fr_1.3fr_1fr_auto] gap-4 items-center hover:bg-[#fafafa] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-[#fde7e2] rounded-2xl flex items-center justify-center shrink-0">
                      <span className="text-[11px] font-black text-primary">{(item.nome || '??').slice(0, 2).toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <span className="font-black text-[14px] text-[#0F172A] block truncate">{item.nome || '—'}</span>
                      <span className="font-bold text-[11px] text-slate-400">{item.unidade}</span>
                    </div>
                  </div>
                  <span className="font-black text-[13px] text-primary">{(item.checkins || 0).toLocaleString('pt-BR')}</span>
                  <span className="font-bold text-[13px] text-slate-500">{brl(item.repassePorCheckin || 0)}</span>
                  <span className="font-black text-[14px] text-accent">{brl(receitaDe(item))}</span>
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
                <h3 className="text-[1.8rem] font-black text-primary tracking-tight">
                  {receitaDe(editing) > 0 ? brl(receitaDe(editing)) : 'Configurar Parceiro'}
                </h3>
                {receitaDe(editing) > 0 && (
                  <p className="text-[12px] font-bold text-slate-400 mt-1">{editing.checkins} check-ins × {brl(editing.repassePorCheckin)}</p>
                )}
              </div>

              <div className="px-10 py-8 space-y-5">
                <div>
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Agregador</label>
                  <input
                    type="text" value={editing.nome} placeholder="Ex: Wellhub (Gympass)"
                    onChange={e => setEditing({ ...editing, nome: e.target.value })}
                    className="w-full px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  {[
                    { label: 'Check-ins', field: 'checkins', suffix: '', step: '1' },
                    { label: 'Repasse/check-in', field: 'repassePorCheckin', suffix: 'R$', step: '0.01' },
                  ].map(({ label, field, suffix, step }) => (
                    <div key={field}>
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">{label}</label>
                      <div className="relative">
                        {suffix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-black text-slate-400">{suffix}</span>}
                        <input
                          type="number" step={step} value={Number((editing as unknown as Record<string, unknown>)[field] ?? 0)}
                          onChange={e => setEditing({ ...editing, [field]: Math.max(0, Number(e.target.value)) })}
                          className={`w-full ${suffix ? 'pl-7' : 'pl-4'} pr-3 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-black text-primary focus:outline-none focus:ring-2 focus:ring-accent/30`}
                        />
                      </div>
                    </div>
                  ))}
                  <div>
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Unidade</label>
                    <select
                      value={editing.unidade}
                      onChange={e => setEditing({ ...editing, unidade: e.target.value })}
                      className="w-full px-3 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-[13px] font-black text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                    >
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
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
                  <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest block mb-2">Observações (tiers, teto, condições)</label>
                  <textarea
                    value={editing.observacao} rows={2}
                    onChange={e => setEditing({ ...editing, observacao: e.target.value })}
                    placeholder="Ex: tiers de repasse, teto por membro, regra de 1º check-in..."
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
