import type { LucideIcon } from 'lucide-react';

interface CircularKPIProps {
    label: string;
    value: string;
    subValue?: string;
    progress: number;
    icon: LucideIcon;
    indicatorColor?: string;
    iconColor?: string;
    subValueColor?: string;
    isLoading?: boolean;
}

export const CircularKPI = ({
    label,
    value,
    subValue,
    progress,
    icon: Icon,
    indicatorColor = "#141414",
    iconColor = "#141414",
    subValueColor,
    isLoading = false,
}: CircularKPIProps) => {
    const radius = 30;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (progress / 100) * circumference;

    const trendColor = subValueColor || (subValue?.includes('↑') || subValue?.includes('+') ? '#10B981' : '#F43F5E');

    return (
        <div
            className={`card-base card-pad group relative overflow-hidden ${isLoading ? 'animate-pulse' : ''}`}
        >
            {/* Top accent gradient bar — discreto, alinhado com UnitCard */}
            <div
                aria-hidden="true"
                className="absolute top-0 left-6 right-6 h-1 rounded-b-full bg-gradient-to-r from-[#141414] to-[#fc3000]"
            />

            <div className="flex items-center gap-6 relative z-10">
                <div className="relative w-24 h-24 flex items-center justify-center shrink-0">
                    <svg className="w-full h-full -rotate-90" aria-hidden="true">
                        <circle
                            cx="48"
                            cy="48"
                            r={radius}
                            fill="transparent"
                            stroke="#F1F5F9"
                            strokeWidth="5"
                        />
                        <circle
                            cx="48"
                            cy="48"
                            r={radius}
                            fill="transparent"
                            stroke={indicatorColor}
                            strokeWidth="5"
                            strokeDasharray={circumference}
                            strokeDashoffset={offset}
                            strokeLinecap="round"
                        />
                    </svg>
                    <div className="absolute flex items-center justify-center" style={{ color: iconColor }}>
                        <Icon size={26} strokeWidth={2.5} aria-hidden="true" />
                    </div>
                </div>
                <div className="min-w-0 flex flex-col gap-1.5">
                    <p className="card-eyebrow whitespace-nowrap">{label}</p>
                    <h3 className="card-value text-slate-900">{value}</h3>
                    {subValue && (
                        <p
                            className="text-[11px] font-bold tracking-tight card-meta-slot:not-applicable"
                            style={{ color: trendColor, minHeight: 0 }}
                        >
                            {subValue}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};
