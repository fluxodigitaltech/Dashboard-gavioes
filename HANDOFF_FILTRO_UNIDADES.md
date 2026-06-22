# Handoff — Filtro de unidades / "Todos" e histórico por card

> **Para quem pega isto agora:** leia o TL;DR, depois a Parte B (é onde o bug está).
> A Parte A já está **pronta e no ar**; a Parte B é a que **falta**.

Data: 2026-06-15 · Autor: Claude (sessão anterior)

---

## TL;DR

Existem **DOIS sistemas diferentes** envolvidos. No começo eles foram confundidos:

| # | Sistema | Pasta | O que tem a ver |
|---|---|---|---|
| **A** | SaaS de IA (FastAPI + Next) | `C:\dev\IA` | Painel interno de **conversas/leads** (Visão Geral). Aqui foi feita a restrição de unidades por usuário. **FEITO.** |
| **B** | Dashboard financeiro/membros (React + NocoDB/EVO) | `C:\dev\dashboard-gavioes` | É o **painel real** com os cards **Ativos / Adimplentes / Faturamento / Vendas / % Inadimplência / % Evasão** e navegação por mês. **O bug do usuário está AQUI.** |

O usuário relata (no sistema **B**):
> "Sem definir as unidades já vem todo o histórico de cada card. Quando mostro **Todos** eu filtro lá e funciona. Só falta **funcionar quando a pessoa está limitada a 2-3 unidades** — aí, em meses anteriores, **Ativos / Inadimplente / Evasão zeram**, enquanto **Vendas / Adimplente aparecem**."

---

## Parte A — `C:\dev\IA` (FEITO, commitado e pushado)

Restrição de unidades por usuário no SaaS de IA. Commit **`d63bccd`** na `main` (já pushado → deploy de prod roda a migration via `scripts/migrate.sh`).

Arquivos:
- `alembic/versions/uu01_usuario_unidade.py` — tabela `usuario_unidade` (vazio = vê todas; com linhas = só essas). Revisa `bill01_planos`.
- `src/services/db_queries.py` — `listar_unidades_permitidas_do_usuario`, `definir_unidades_do_usuario`, `usuario_pode_ver_unidade`.
- `src/api/routers/dashboard.py` — helper `_unidades_permitidas_do_tenant` + filtro em `/dashboard/unidades`, `/dashboard/metrics/empresa` (o "Todos"), `/dashboard/metrics`, `/dashboard/conversations`.
- `src/api/routers/auth.py` — `GET/PUT /auth/usuarios/{id}/unidades` + `unidade_ids` em `listar_usuarios`.
- `frontend/src/app/admin/page.tsx` — modal 👁 "Unidades visíveis" no Painel Master.
- `src/tests/test_usuario_unidade.py` — 8 testes (passando).

Verificação: `ruff` limpo, `pytest` 428 passed (as 11 falhas são `ModuleNotFoundError: openpyxl`, ambiente local sem a dep — passam no CI). `tsc --noEmit` limpo.

Pendência: a migration **não** foi rodada localmente (sem Docker na máquina); ela aplica sozinha no deploy. Em dev: `docker exec ia-dev-api alembic upgrade head`.

> **Importante:** essa restrição do sistema A **NÃO** controla o dashboard B. São bancos/apps separados. Se a intenção for que a restrição do A governe o painel B, isso seria um trabalho NOVO (trazer os cards de membros para dentro do app A) — não é o que está pedido agora.

---

## Parte B — `C:\dev\dashboard-gavioes` (BUG ABERTO — é aqui que falta mexer)

### Como os dados funcionam (mapa)

- **Mês corrente:** dados **ao vivo** da EVO (`src/services/evoApi.ts` → `BranchStats` por unidade). Cards somam por unidade selecionada.
- **Meses passados (histórico):** vêm de `gb_evo_history` (NocoDB) + do mini-backend `/api/history` (server `server/index.mjs`). A EVO só devolve o estado ATUAL — passado é snapshot mensal.
- Schema de `EvoHistoryRow` (em `src/services/nocodbApi.ts` ~linha 916): `branch_name`, `snapshot_month` (`YYYY-MM`), `active_members`, `adimplentes`, `inadimplentes`, `faturamento_adimplentes`, `vendas_qtd`, `vendas_valor`. **NÃO tem campo de evasão/cancelamento.**
- `aggregateHistoryByMonth(rows, branchNames)` (`nocodbApi.ts` ~linha 1003): soma as linhas por mês, **filtrando por `branch_name ∈ branchNames`**. É **função pura** — fácil de testar sem rede.
- `fetchAllEvoHistoryMonthly` (~linha 1036): faz **merge** de `/api/history` (membros: ativos/adimp/inadimp/faturamento) com `gb_evo_history` (vendas), chaveado por `branch_name|snapshot_month`.

### Onde o valor de cada card é decidido — `src/screens/DashboardScreen.tsx`

- L90: `isAllUnits = selectedUnits.length === 0 || selectedUnits.length >= allUnitNames.length`
- L92: `activeUnitNames = isAllUnits ? allUnitNames : selectedUnits`
- L567-573: `histMonth = dateTo.slice(0,7)`; `isPastPeriod` = mês selecionado < mês atual.
- L578: `histByMonth = aggregateHistoryByMonth(historyRows, activeUnitNames)` ← **filtra histórico pelas unidades em escopo (por NOME)**.
- L587-589: `histAgg = histByMonth.get(histMonth)`; `isHistMode = isPastPeriod`; `histMissing = isPastPeriod && !histAgg`.
- L592: `ativos = isHistMode ? histAgg?.active_members ?? 0 : ...`
- L593: `adimp  = isHistMode ? histAgg?.adimplentes ?? 0 : ...`
- L644: `inad   = isHistMode ? histAgg?.inadimplentes ?? 0 : ...`
- L600-609: **vendas** em mês passado usa `vendasRange` (intervalo de datas, ao vivo por unidade) — **não** usa `histAgg`.

### Causa-raiz (diagnóstico)

Em **mês passado**, `ativos/adimp/inad` vêm TODOS do mesmo `histAgg`, que só existe se `aggregateHistoryByMonth` casar o **`branch_name`** do histórico com os **nomes em `activeUnitNames`**. Quando o usuário está restrito (ou seleciona 2-3 unidades), `activeUnitNames` = subconjunto de nomes; se esses nomes **não baterem exatamente** com `branch_name` na `gb_evo_history`/`/api/history` (caixa, acento, espaço no fim, abreviação), o filtro devolve **vazio → histAgg null → cards de estoque zeram**. Vendas continua funcionando porque vem de **outra fonte** (`vendasRange`, ao vivo, com seu próprio `byUnit`).

> **Evidência de dado sujo:** na planilha-fonte da EVO (vista no importador do sistema A) os nomes de filial vêm **com espaço no fim** (`"ALTO DO IPIRANGA "`, `"BE FREE "`). Basta o histórico ter sido gravado com um nome e a unidade ao vivo expor outro (ex.: sem espaço, ou caixa diferente) para o `Set(branchNames)` não casar.

**Por que "Todos" funciona e 2-3 unidades não:** com `isAllUnits=true`, `activeUnitNames = allUnitNames` (todos) — então `aggregateHistoryByMonth` casa por inclusão ampla e/ou o caminho de exibição cai no total global; ao restringir, o casamento exato por nome falha para as unidades cujo `branch_name` diverge.

**% Evasão** é caso à parte: **não existe no schema de `gb_evo_history`** (só ativos/adimp/inadimp/faturamento/vendas). Logo, em mês passado a evasão não tem fonte histórica e tende a **zerar sempre** (ver como o card de evasão é montado — provavelmente usa `cancelamentosMes`, que é ao vivo). Precisa de uma fonte histórica de evasão/cancelamentos por unidade×mês, ou cálculo derivado (ativos do mês N-1 que sumiram em N).

### Hipóteses, em ordem de probabilidade

1. **Mismatch de `branch_name`** entre histórico (`/api/history` + `gb_evo_history`) e os nomes em `selectedUnits`/`allUnitNames` (vindos da EVO ao vivo). ⇐ **principal.** Sintoma bate: estoque (histAgg) zera, vendas (fonte própria) não.
2. **`adimplente` aparece mas `ativos`/`inadimplente` zeram** no MESMO `histAgg`: indica que as linhas históricas daquelas unidades têm `adimplentes` preenchido porém `active_members`/`inadimplentes` = 0 — ou seja, **dado incompleto na origem** (`/api/history` no `server/index.mjs`, ou no seed `scripts/seed-history.mjs`). Verificar o que `/api/history` devolve por unidade.
3. **Evasão** sem fonte histórica (confirmado pelo schema) → item separado, precisa de dado novo.

### Próximos passos (precisam de acesso em runtime — NocoDB/EVO/`/api/history`)

> O sandbox **não alcança** o NocoDB nem o backend `/api/history`. Rodar isto numa máquina com o `.env` do projeto (`VITE_NOCODB_TOKEN`, server local de `/api/history`).

1. **Comparar strings de unidade:** logar/printar `allUnitNames` e `selectedUnits` (DashboardScreen) e os `branch_name` distintos retornados por `fetchAllEvoHistoryMonthly()`. Procurar diferença de caixa/acento/espaço/abreviação. (Reproduz a hipótese 1.)
2. **Inspecionar `/api/history`** (`server/index.mjs`): conferir se devolve `active_members` e `inadimplentes` por unidade×mês ou se vêm 0/ausentes (hipótese 2).
3. **Correção provável (hipótese 1):** normalizar o casamento de nomes — `trim()` + casefold + remover acento — tanto em `aggregateHistoryByMonth` (comparar por chave normalizada, não igualdade crua) quanto na escrita do histórico (`scripts/seed-history.mjs` / `server/index.mjs`). Ideal: padronizar `branch_name` na ORIGEM e normalizar na leitura por segurança.
4. **Evasão histórica:** adicionar campo (ex.: `cancelamentos`/`evasao`) ao schema `gb_evo_history` + popular no seed, OU derivar evasão de `active_members[N-1] → N`. Sem isso, % Evasão fica 0 em qualquer mês passado.
5. **Teste:** `aggregateHistoryByMonth` é pura — escrever teste com `branch_name` "sujo" (espaço/caixa) provando que o filtro normalizado casa.

### Arquivos-chave (sistema B)

- `src/screens/DashboardScreen.tsx` — montagem dos cards e modo histórico (L90-92, L560-660).
- `src/services/nocodbApi.ts` — `aggregateHistoryByMonth` (~1003), `fetchAllEvoHistoryMonthly` (~1036), schema `EvoHistoryRow` (~916).
- `src/hooks/useEvoHistory.ts` — carrega o histórico (cache de módulo).
- `src/lib/scopeData.ts` — `scopeDashboardData` (recorta/soma por unidade no mês corrente; usado em PDF e escopo).
- `src/services/evoApi.ts` — `BranchStats` (dados ao vivo por unidade).
- `server/index.mjs` — backend `/api/history`.
- `scripts/seed-history.mjs` — popula `gb_evo_history`.
- `src/screens/AdminUsuariosScreen.tsx` + `nocodbApi.ts` (`getAllowedUnits`, `getAllowedUnitsForPage`) — restrição de unidades por usuário **deste** sistema (NocoDB, campo `allowed_units` / matriz `cell_permissions`). **É aqui que se "libera 2-3 unidades" para a pessoa neste painel** — não confundir com a tabela `usuario_unidade` do sistema A.

### O que JÁ foi descartado / confirmado

- ✅ O painel **não está** no `C:\dev\IA` (busca exaustiva por todas as strings: "Modo TV", "Faturamento", "Adimplentes", "% Evasão", "Editar Layout"). Está em `dashboard-gavioes`.
- ✅ Sistema A e B são **separados** (bancos e apps distintos); a tabela `usuario_unidade` (A) não afeta o painel B.
- ⚠️ A correção **não** pôde ser aplicada na sessão anterior porque exige inspecionar dados em runtime (NocoDB cloud + `/api/history`) — inacessíveis do sandbox.

---

## Checklist do que falta (sistema B)

- [ ] Reproduzir com print/log: `activeUnitNames` vs `branch_name` do histórico (achar o mismatch).
- [ ] Normalizar casamento de nome em `aggregateHistoryByMonth` (trim + casefold + sem acento) e padronizar na origem.
- [ ] Conferir `/api/history` devolve `active_members`/`inadimplentes` por unidade×mês.
- [ ] Resolver **% Evasão** em meses passados (novo campo histórico ou cálculo derivado).
- [ ] Teste unitário de `aggregateHistoryByMonth` com nomes "sujos".
- [ ] Validar com usuário restrito a 2-3 unidades, em mês passado, que todos os cards batem com o "Todos" filtrado manualmente.
