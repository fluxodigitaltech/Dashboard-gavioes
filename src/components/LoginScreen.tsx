import React, { useState } from 'react';
import { Mail, Lock, Eye, ArrowRight, Shield, HelpCircle, LayoutGrid, Users, Activity } from 'lucide-react';
import { motion } from 'framer-motion';
import gbElement from '../assets/gb_element-2.png';
import gavioesLogotipoNeg from '../assets/gavioes-logotipo.png';
import { loginWithNocoDB, changeOwnPassword, saveSession, type GbUser } from '../services/nocodbApi';

interface LoginScreenProps {
    onLogin: (user: GbUser) => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLogin }) => {
    const [showPassword, setShowPassword] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    // Modo "trocar minha senha" — alternável na própria tela de login.
    const [mode, setMode] = useState<'login' | 'change'>('login');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [changeSuccess, setChangeSuccess] = useState(false);

    function switchMode(next: 'login' | 'change') {
        setMode(next);
        setError('');
        setChangeSuccess(false);
        setPassword('');
        setNewPassword('');
        setConfirmPassword('');
    }

    async function handleChangePassword(e: React.FormEvent) {
        e.preventDefault();
        setError('');
        if (newPassword.length < 6) { setError('A nova senha precisa de pelo menos 6 caracteres.'); return; }
        if (newPassword !== confirmPassword) { setError('A nova senha e a confirmação não conferem.'); return; }
        setLoading(true);
        try {
            await changeOwnPassword(email.trim(), password, newPassword);
            setChangeSuccess(true);
            setPassword(''); setNewPassword(''); setConfirmPassword('');
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Não foi possível trocar a senha.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="min-h-screen bg-[#F8F9FA] font-manrope selection:bg-accent selection:text-white flex flex-col items-center justify-center relative overflow-hidden">
            {/* Background Decorative Element (gb_element-2.png) */}
            <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{
                    opacity: 0.04,
                    scale: 1,
                    y: [0, -20, 0],
                    rotate: [-15, -13, -15]
                }}
                transition={{
                    opacity: { duration: 1.5 },
                    scale: { duration: 1.5 },
                    y: { duration: 6, repeat: Infinity, ease: "easeInOut" },
                    rotate: { duration: 8, repeat: Infinity, ease: "easeInOut" }
                }}
                className="absolute inset-0 pointer-events-none flex items-center justify-center translate-x-[-20%]"
            >
                <img
                    src={gbElement}
                    alt=""
                    className="w-[120%] object-contain"
                />
            </motion.div>

            {/* Decorative Circles — escondidos em mobile pra não destruir performance de scroll */}
            <div aria-hidden="true" className="hidden sm:block absolute top-[-10%] left-[-5%] w-[600px] h-[600px] rounded-full bg-[#fc3000]/5 blur-[100px]" />
            <div aria-hidden="true" className="hidden sm:block absolute bottom-[-15%] right-[-5%] w-[800px] h-[800px] rounded-full bg-[#141414]/5 blur-[120px]" />
            <div aria-hidden="true" className="hidden md:block absolute top-[20%] right-[10%] w-[400px] h-[400px] rounded-full border-[100px] border-[#fc3000]/3 opacity-50" />
            <div aria-hidden="true" className="hidden md:block absolute top-[50%] left-[20%] w-[1200px] h-[1200px] rounded-full border-[150px] border-slate-100 opacity-30 -translate-y-1/2" />

            <div className="max-w-[1240px] w-full px-4 sm:px-6 grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-20 items-center relative z-10 safe-x">
                {/* Left Section: Corporate Internal Context */}
                <motion.div
                    initial={{ x: -40, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                >
                    <div className="mb-8 sm:mb-12">
                        <h1 className="text-[2.75rem] sm:text-[3.5rem] lg:text-[4.5rem] font-black text-primary leading-[0.95] tracking-tighter mb-6 sm:mb-8">
                            Gestão <br />
                            <span className="text-accent underline decoration-accent/20">Corporativa</span>
                        </h1>
                        <p className="text-slate-500 text-[15px] sm:text-[18px] font-semibold max-w-sm leading-relaxed">
                            Painel Interno de Gestão de Unidades, Membros e Performance Gaviões. Acesse para gerenciar o ecossistema de saúde e bem-estar.
                        </p>
                    </div>

                    <div className="flex gap-4">
                        <div className="w-[64px] h-[64px] rounded-2xl bg-white flex items-center justify-center text-primary shadow-sm border border-slate-100">
                            <LayoutGrid size={28} />
                        </div>
                        <div className="w-[64px] h-[64px] rounded-2xl bg-white flex items-center justify-center text-primary shadow-sm border border-slate-100">
                            <Users size={28} />
                        </div>
                        <div className="w-[64px] h-[64px] rounded-2xl bg-white flex items-center justify-center text-primary shadow-sm border border-slate-100">
                            <Activity size={28} />
                        </div>
                    </div>
                </motion.div>

                {/* Right Section: Glassmorphism Login Card (Corporate Edition) */}
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.7, ease: "easeOut", delay: 0.2 }}
                    className="flex justify-center lg:justify-end"
                >
                    <div className="w-full max-w-[480px]">
                        <div className="bg-white/70 backdrop-blur-[32px] rounded-[2rem] sm:rounded-[3rem] p-6 sm:p-10 lg:p-12 border border-white shadow-[0_40px_80px_-20px_rgba(0,0,0,0.08)] relative overflow-hidden">
                            {/* Top Accent Bar */}
                            <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-primary via-accent to-primary" />

                            <div className="flex justify-center mb-12">
                                <img
                                    src={gavioesLogotipoNeg}
                                    alt="Gaviões Admin"
                                    className="h-[48px] object-contain"
                                    style={{ filter: 'brightness(0) saturate(100%) invert(14%) sepia(55%) saturate(600%) hue-rotate(105deg) brightness(90%) contrast(95%)' }}
                                />
                            </div>

                            <div className="text-center mb-10">
                                <h2 className="text-[26px] font-black text-primary tracking-tight">{mode === 'change' ? 'Trocar minha senha' : 'Sistema Interno'}</h2>
                                <p className="text-slate-400 font-bold text-[13px] uppercase tracking-widest mt-2">{mode === 'change' ? 'Informe sua senha atual e a nova' : 'Acesso Restrito ao Dashboard'}</p>
                            </div>

                            {mode === 'login' ? (
                            <form className="space-y-6" onSubmit={async (e) => {
                                e.preventDefault();
                                setError('');
                                setLoading(true);
                                try {
                                    const user = await loginWithNocoDB(email, password);
                                    saveSession(user);
                                    onLogin(user);
                                } catch (err: unknown) {
                                    setError(err instanceof Error ? err.message : 'Erro ao autenticar.');
                                } finally {
                                    setLoading(false);
                                }
                            }}>
                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Identificação</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40 group-focus-within:text-accent transition-colors">
                                            <Mail size={18} strokeWidth={2.5} />
                                        </div>
                                        <input
                                            type="email"
                                            placeholder="seu@gavioes.com.br"
                                            value={email}
                                            onChange={e => setEmail(e.target.value)}
                                            required
                                            autoComplete="username"
                                            inputMode="email"
                                            className="w-full h-16 pl-14 pr-6 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all outline-none"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Senha Corporativa</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40">
                                            <Lock size={18} strokeWidth={2.5} />
                                        </div>
                                        <input
                                            type={showPassword ? "text" : "password"}
                                            placeholder="••••••••"
                                            value={password}
                                            onChange={e => setPassword(e.target.value)}
                                            required
                                            autoComplete="current-password"
                                            className="w-full h-16 pl-14 pr-14 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all outline-none"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            aria-label={showPassword ? 'Esconder senha' : 'Mostrar senha'}
                                            aria-pressed={showPassword}
                                            className="absolute right-6 top-1/2 -translate-y-1/2 text-primary/40 hover:text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
                                        >
                                            <Eye size={18} strokeWidth={2.5} aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>

                                {error && (
                                    <div className="px-5 py-3 bg-rose-50 border border-rose-100 rounded-2xl text-[13px] font-bold text-rose-600">
                                        {error}
                                    </div>
                                )}

                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full h-16 bg-primary text-white rounded-2xl text-[14px] font-black flex items-center justify-center gap-3 shadow-[0_15px_30px_-5px_rgba(15,60,35,0.3)] hover:scale-[1.02] active:scale-95 transition-all group disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
                                >
                                    {loading ? 'VERIFICANDO...' : (<>ACESSAR DASHBOARD <ArrowRight size={18} strokeWidth={3} className="group-hover:translate-x-1 transition-transform" /></>)}
                                </button>
                            </form>
                            ) : changeSuccess ? (
                                <div className="text-center py-2">
                                    <div className="w-14 h-14 mx-auto rounded-2xl bg-emerald-50 flex items-center justify-center mb-5">
                                        <Shield size={26} className="text-emerald-600" />
                                    </div>
                                    <h3 className="text-[18px] font-black text-primary mb-2">Senha alterada!</h3>
                                    <p className="text-slate-400 font-bold text-[13px] mb-7">Já pode entrar com a sua nova senha.</p>
                                    <button
                                        type="button"
                                        onClick={() => switchMode('login')}
                                        className="w-full h-14 bg-primary text-white rounded-2xl text-[13px] font-black flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-95 transition-all"
                                    >
                                        Ir para o login <ArrowRight size={16} strokeWidth={3} />
                                    </button>
                                </div>
                            ) : (
                            <form className="space-y-5" onSubmit={handleChangePassword}>
                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Identificação</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40"><Mail size={18} strokeWidth={2.5} /></div>
                                        <input
                                            type="email" placeholder="seu@gavioes.com.br" value={email}
                                            onChange={e => setEmail(e.target.value)} required autoComplete="username" inputMode="email"
                                            className="w-full h-14 pl-14 pr-6 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Senha atual</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40"><Lock size={18} strokeWidth={2.5} /></div>
                                        <input
                                            type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={password}
                                            onChange={e => setPassword(e.target.value)} required autoComplete="current-password"
                                            className="w-full h-14 pl-14 pr-14 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all"
                                        />
                                        <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Esconder senha' : 'Mostrar senha'} className="absolute right-6 top-1/2 -translate-y-1/2 text-primary/40 hover:text-primary transition-colors">
                                            <Eye size={18} strokeWidth={2.5} aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Nova senha</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40"><Lock size={18} strokeWidth={2.5} /></div>
                                        <input
                                            type={showPassword ? 'text' : 'password'} placeholder="mínimo 6 caracteres" value={newPassword}
                                            onChange={e => setNewPassword(e.target.value)} required autoComplete="new-password"
                                            className="w-full h-14 pl-14 pr-6 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[12px] font-black text-primary uppercase tracking-[0.2em] pl-1">Confirmar nova senha</label>
                                    <div className="relative">
                                        <div className="absolute left-6 top-1/2 -translate-y-1/2 text-primary/40"><Lock size={18} strokeWidth={2.5} /></div>
                                        <input
                                            type={showPassword ? 'text' : 'password'} placeholder="repita a nova senha" value={confirmPassword}
                                            onChange={e => setConfirmPassword(e.target.value)} required autoComplete="new-password"
                                            className="w-full h-14 pl-14 pr-6 bg-[#F8FAFB] border border-slate-100/50 rounded-2xl text-[14px] font-bold focus:outline-none focus:ring-2 focus:ring-accent/20 focus:bg-white transition-all"
                                        />
                                    </div>
                                </div>

                                {error && (
                                    <div className="px-5 py-3 bg-rose-50 border border-rose-100 rounded-2xl text-[13px] font-bold text-rose-600">
                                        {error}
                                    </div>
                                )}

                                <button
                                    type="submit" disabled={loading}
                                    className="w-full h-16 bg-primary text-white rounded-2xl text-[14px] font-black flex items-center justify-center gap-3 shadow-[0_15px_30px_-5px_rgba(15,60,35,0.3)] hover:scale-[1.02] active:scale-95 transition-all group disabled:opacity-60 disabled:cursor-not-allowed disabled:scale-100"
                                >
                                    {loading ? 'SALVANDO...' : (<>TROCAR SENHA <ArrowRight size={18} strokeWidth={3} className="group-hover:translate-x-1 transition-transform" /></>)}
                                </button>
                            </form>
                            )}

                            <div className="mt-12 pt-10 border-t border-slate-50 text-center">
                                {mode === 'login' ? (
                                    <button type="button" onClick={() => switchMode('change')} className="text-accent text-[12px] font-black uppercase tracking-widest hover:underline">
                                        Trocar minha senha
                                    </button>
                                ) : (
                                    <button type="button" onClick={() => switchMode('login')} className="text-primary text-[12px] font-black uppercase tracking-widest hover:underline">
                                        ← Voltar para o login
                                    </button>
                                )}
                                <p className="text-slate-400 text-[12px] font-bold italic mt-4">Não tem permissão? Solicite seu acesso com o time interno</p>
                            </div>
                        </div>

                        <div className="mt-8 flex justify-center gap-8 text-[11px] font-black text-slate-500 uppercase tracking-[0.2em]">
                            <div className="flex items-center gap-2">
                                <Shield size={14} className="text-accent" /> CONEXÃO SEGURA
                            </div>
                            <div className="flex items-center gap-2">
                                <HelpCircle size={14} /> SUPORTE TI
                            </div>
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Footer — relativo em mobile pra não sobrepor o card; absoluto em sm+ */}
            <footer className="relative sm:absolute sm:bottom-10 w-full text-center text-[11px] font-black text-slate-400 uppercase tracking-[0.3em] px-6 mt-10 sm:mt-0 safe-bottom">
                © 2024 Academia Gaviões 24h  •  Gestão Interna
            </footer>
        </div>
    );
};
