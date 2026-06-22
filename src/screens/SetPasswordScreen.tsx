import { useState } from 'react';
import { motion } from 'framer-motion';
import { Lock, Eye, EyeOff, CheckCircle2, AlertCircle, ArrowRight, RefreshCw } from 'lucide-react';
import { setPasswordWithToken } from '../services/inviteApi';

/** Página que abre pelo link do e-mail de convite: /definir-senha?token=... */
export function SetPasswordScreen() {
  const token = new URLSearchParams(window.location.search).get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [show, setShow]         = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [doneEmail, setDoneEmail] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!token) { setError('Link inválido — peça um novo convite.'); return; }
    if (password.length < 8) { setError('A senha precisa de pelo menos 8 caracteres.'); return; }
    if (password !== confirm) { setError('As senhas não conferem.'); return; }
    setSaving(true);
    try {
      const { email } = await setPasswordWithToken(token, password);
      setDoneEmail(email);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível definir a senha.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8FAFB] px-4 py-10">
      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4 }}
        className="w-full max-w-md bg-white rounded-[2rem] shadow-[0_20px_60px_rgba(15,60,35,0.08)] overflow-hidden"
      >
        <div className="h-2 bg-gradient-to-r from-[#141414] via-[#141414] to-[#fc3000]" />
        <div className="p-8 sm:p-10">
          <div className="text-[22px] font-black text-[#141414] tracking-tight mb-8">GAVIÕES</div>

          {doneEmail ? (
            // ── Sucesso ──
            <div className="text-center">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-50 flex items-center justify-center mb-5">
                <CheckCircle2 size={28} className="text-emerald-600" />
              </div>
              <h1 className="text-[1.6rem] font-black text-[#0F172A] leading-tight mb-2">Senha definida!</h1>
              <p className="text-[14px] font-semibold text-slate-500 mb-7">
                Tudo certo, <b className="text-slate-700">{doneEmail}</b>. Agora é só entrar com a sua nova senha.
              </p>
              <a
                href="/"
                className="inline-flex items-center justify-center gap-2 w-full h-13 py-4 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[13px] font-black uppercase tracking-wider transition-all"
              >
                Ir para o login <ArrowRight size={16} />
              </a>
            </div>
          ) : (
            // ── Formulário ──
            <>
              <h1 className="text-[1.7rem] font-black text-[#0F172A] leading-tight mb-2">Definir sua senha</h1>
              <p className="text-[14px] font-semibold text-slate-400 mb-7">
                Crie uma senha para acessar o painel.
              </p>

              <div className="space-y-3">
                <div className="relative">
                  <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
                  <input
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Nova senha"
                    className="w-full pl-11 pr-11 py-3.5 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                  <button type="button" onClick={() => setShow(s => !s)} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="relative">
                  <Lock size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-300" />
                  <input
                    type={show ? 'text' : 'password'}
                    value={confirm}
                    onChange={e => setConfirm(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
                    placeholder="Confirmar senha"
                    className="w-full pl-11 pr-4 py-3.5 bg-slate-50 border border-slate-100 rounded-2xl text-[14px] font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  />
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 px-4 py-3 mt-4 bg-rose-50 border border-rose-100 rounded-xl">
                  <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
                  <p className="text-[12px] font-bold text-rose-700">{error}</p>
                </div>
              )}

              <button
                onClick={handleSubmit}
                disabled={saving}
                className="mt-6 w-full flex items-center justify-center gap-2 py-4 bg-primary hover:bg-[#0a0a0a] text-white rounded-2xl text-[13px] font-black uppercase tracking-wider shadow-[0_8px_25px_rgba(15,60,35,0.2)] transition-all disabled:opacity-50"
              >
                {saving ? <><RefreshCw size={16} className="animate-spin" /> Salvando…</> : <>Definir senha e entrar <ArrowRight size={16} /></>}
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
