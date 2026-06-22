import type { DashboardData } from '../App';
import type { BranchStats } from '../services/evoApi';

// ─── Recorta um DashboardData pra um subconjunto de unidades ──────────────────
// Reaproveitado pra (a) RBAC por página e (b) o filtro de unidades do Painel
// (inclusive multi-seleção e PDF). Recalcula TODOS os totais a partir das
// unidades selecionadas — fonte única de verdade pra "dados escopados".
//
// Mora aqui (e não no App.tsx) porque o App só pode exportar componentes pro
// Fast Refresh funcionar (regra react-refresh/only-export-components).
export function scopeDashboardData(data: DashboardData, unitNames: string[]): DashboardData {
  const allowedSet = new Set(unitNames);
  const filteredUnits = data.units.filter(u => allowedSet.has(u.name));
  const sum = (fn: (b: BranchStats) => number | undefined) =>
    filteredUnits.reduce((s, b) => s + (fn(b) ?? 0), 0);
  const totalActive = sum(b => b.activeMembers);
  const totalAdimplentes = sum(b => b.adimplentesMembers);
  return {
    ...data,
    units: filteredUnits,
    totalActiveMembers:          totalActive,
    totalAdimplentesMembers:     totalAdimplentes,
    totalInadimplentesMembers:   sum(b => b.inadimplentesMembers),
    totalVipMembers:             sum(b => b.vipMembers),
    totalFaturamentoAdimplentes: sum(b => b.faturamentoAdimplentes),
    totalVendasMesValor:         sum(b => b.vendasMesValor),
    totalVendasMesQtd:           sum(b => b.vendasMesQtd),
    totalActiveMembersPrev:           sum(b => b.activeMembersPrev),
    totalAdimplentesMembersPrev:      sum(b => b.adimplentesMembersPrev),
    totalInadimplentesMembersPrev:    sum(b => b.inadimplentesMembersPrev),
    totalFaturamentoAdimplentesPrev:  sum(b => b.faturamentoAdimplentesPrev),
    totalFaturamentoInadimplentesPrev:sum(b => b.faturamentoInadimplentesPrev),
    totalVendasMesValorPrev:          sum(b => b.vendasMesValorPrev),
    totalVendasMesQtdPrev:            sum(b => b.vendasMesQtdPrev),
    totalActiveMembers1y:            filteredUnits.filter(b => b.has1yData).reduce((s, b) => s + (b.activeMembers1y ?? 0), 0),
    totalAdimplentesMembers1y:       filteredUnits.filter(b => b.has1yData).reduce((s, b) => s + (b.adimplentesMembers1y ?? 0), 0),
    totalVipMembers1y:               filteredUnits.filter(b => b.has1yData).reduce((s, b) => s + (b.vipMembers1y ?? 0), 0),
    totalFaturamentoAdimplentes1y:   filteredUnits.filter(b => b.has1yData).reduce((s, b) => s + (b.faturamentoAdimplentes1y ?? 0), 0),
    totalFaturamentoInadimplentes1y: filteredUnits.filter(b => b.has1yData).reduce((s, b) => s + (b.faturamentoInadimplentes1y ?? 0), 0),
    has1yDataAny:                    filteredUnits.some(b => b.has1yData),
    totalVendasMesValor1y:         filteredUnits.filter(b => b.has1yVendas).reduce((s, b) => s + (b.vendasMesValor1y ?? 0), 0),
    totalVendasMesQtd1y:           filteredUnits.filter(b => b.has1yVendas).reduce((s, b) => s + (b.vendasMesQtd1y ?? 0), 0),
    has1yVendasAny:                filteredUnits.some(b => b.has1yVendas),
    totalCancelamentosMes:         sum(b => b.cancelamentosMes),
    cancelamentosMesAllComplete:   filteredUnits.every(b => b.cancelamentosMesComplete !== false),
    totalInactiveMembers:        sum(b => b.inactiveMembers),
    retentionRate: totalActive > 0 ? Math.round((totalAdimplentes / totalActive) * 100) : 0,
  };
}
