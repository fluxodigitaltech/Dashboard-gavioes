
import { Search, Bell, User } from 'lucide-react';

export const TopNavbar = () => {
    return (
        <nav className="h-16 bg-white border-b border-slate-100 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto h-full px-4 flex items-center justify-between">
                <div className="flex items-center gap-8">
                    <img src="/src/assets/gb_encurtado.png" alt="Gaviões" className="h-6" />
                    <div className="hidden md:flex items-center gap-6">
                        <a href="#" className="text-sm font-semibold text-slate-800 border-b-2 border-primary pb-5 mt-5">Painel</a>
                        <a href="#" className="text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors">Unidades</a>
                        <a href="#" className="text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors">Financeiro</a>
                        <a href="#" className="text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors">Membros</a>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <div className="relative hidden sm:block">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                        <input
                            type="text"
                            placeholder="Buscar unidades ou membros..."
                            className="pl-9 pr-4 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary w-64"
                        />
                    </div>
                    <button className="p-2 text-slate-500 hover:bg-slate-50 rounded-full">
                        <Bell size={20} />
                    </button>
                    <div className="w-8 h-8 rounded-full overflow-hidden border border-slate-200 cursor-pointer">
                        <div className="w-full h-full bg-slate-100 flex items-center justify-center text-slate-500">
                            <User size={16} />
                        </div>
                    </div>
                </div>
            </div>
        </nav>
    );
};
