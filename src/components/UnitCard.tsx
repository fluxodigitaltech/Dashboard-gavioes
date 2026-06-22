import { motion } from 'framer-motion';
import { MapPin, AlertCircle } from 'lucide-react';
import { type BranchStats } from '../services/evoApi';

interface UnitCardProps {
    unit: BranchStats;
    onDetailsClick?: () => void;
}

export const UnitCard = ({ unit, onDetailsClick }: UnitCardProps) => {
    const total = (unit.activeMembers + unit.inactiveMembers) || 1;
    const retentionPct = Math.round((unit.activeMembers / total) * 100);
    const inactivePct  = Math.round((unit.inactiveMembers / total) * 100);

    return (
        <motion.button
            type="button"
            layout
            onClick={onDetailsClick}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ y: -2 }}
            aria-label={`Detalhes da unidade ${unit.name}`}
            className="card-base card-interactive card-pad group relative cursor-pointer overflow-hidden text-left w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
        >
            {/* Top accent line — cor reflete a taxa de retenção real */}
            <div
                aria-hidden="true"
                className={`absolute top-0 left-6 right-6 h-1 rounded-b-full transition-colors duration-500 ${
                    retentionPct >= 80 ? 'bg-accent' : retentionPct >= 60 ? 'bg-amber-400' : 'bg-rose-400'
                }`}
            />

            {/* Subtle "gb" no canto */}
            <div className="absolute top-5 right-5 text-[12px] font-black text-slate-100 uppercase pointer-events-none group-hover:text-slate-200 transition-colors" aria-hidden="true">gb</div>

            <div className="relative z-10">
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-1.5">
                        <h4 className="font-black text-primary text-[1.4rem] leading-none tracking-tight">
                            {unit.name}
                        </h4>
                        {unit.hasError && <AlertCircle size={14} className="text-rose-500" aria-label="Falha ao carregar dados" />}
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-500 card-eyebrow">
                        <MapPin size={10} className="text-slate-400" aria-hidden="true" />
                        {unit.location}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-6 mb-6">
                    <div>
                        <p className="card-eyebrow mb-2">Ativos</p>
                        <p className="card-value text-primary">
                            {unit.hasError ? '—' : unit.activeMembers.toLocaleString('pt-BR')}
                        </p>
                    </div>
                    <div>
                        <p className="card-eyebrow mb-2">Inativos</p>
                        <p className={`card-value ${inactivePct > 30 ? 'text-rose-500' : 'text-amber-500'}`}>
                            {unit.hasError ? '—' : unit.inactiveMembers.toLocaleString('pt-BR')}
                        </p>
                    </div>
                </div>

                <span
                    className="block w-full py-3 rounded-xl bg-slate-50 text-slate-500 text-[11px] font-black uppercase tracking-[0.15em] text-center group-hover:bg-primary group-hover:text-white group-hover:shadow-md group-hover:shadow-primary/20 transition-all duration-300 border border-slate-100"
                >
                    Ver Detalhes da Unidade
                </span>
            </div>
        </motion.button>
    );
};
