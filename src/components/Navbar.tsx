
import { Search, Bell, User } from 'lucide-react';

export const Navbar = () => {
    return (
        <nav className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-8 sticky top-0 z-10 w-[calc(100%-16rem)] ml-64">
            <div className="relative w-96">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                    type="text"
                    placeholder="Pesquisar..."
                    className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                />
            </div>

            <div className="flex items-center gap-6">
                <button className="relative p-2 text-slate-500 hover:bg-slate-100 rounded-full transition-all">
                    <Bell size={22} />
                    <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
                </button>

                <div className="flex items-center gap-3 pl-6 border-l border-slate-200">
                    <div className="text-right">
                        <p className="text-sm font-bold text-slate-800">Admin User</p>
                        <p className="text-xs text-slate-500">Administrador</p>
                    </div>
                    <div className="w-10 h-10 bg-slate-200 rounded-full flex items-center justify-center text-slate-600">
                        <User size={20} />
                    </div>
                </div>
            </div>
        </nav>
    );
};
