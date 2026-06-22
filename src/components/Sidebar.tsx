import { LayoutDashboard, Users, FileText, Settings, LogOut, BarChart2, Bell, type LucideIcon } from 'lucide-react';

const SidebarItem = ({ icon: Icon, label, active = false }: { icon: LucideIcon, label: string, active?: boolean }) => (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-all ${active ? 'bg-primary text-white shadow-lg' : 'text-slate-500 hover:bg-slate-100'}`}>
        <Icon size={20} />
        <span className="font-medium">{label}</span>
    </div>
);

export const Sidebar = () => {
    return (
        <div className="w-64 h-screen bg-white border-r border-slate-200 flex flex-col p-4 fixed left-0 top-0">
            <div className="flex items-center gap-2 px-2 mb-8">
                <img src="/src/assets/gb_encurtado.png" alt="Gaviões" className="h-8" />
                <span className="text-xl font-bold text-slate-800">Gaviões</span>
            </div>

            <div className="flex flex-col gap-2 flex-1">
                <SidebarItem icon={LayoutDashboard} label="Dashboard" active />
                <SidebarItem icon={Users} label="Usuários" />
                <SidebarItem icon={FileText} label="Relatórios" />
                <SidebarItem icon={BarChart2} label="Estatísticas" />
                <SidebarItem icon={Bell} label="Notificações" />
            </div>

            <div className="pt-4 border-t border-slate-100 flex flex-col gap-2">
                <SidebarItem icon={Settings} label="Configurações" />
                <SidebarItem icon={LogOut} label="Sair" />
            </div>
        </div>
    );
};
