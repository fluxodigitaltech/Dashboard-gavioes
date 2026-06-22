# REGRA CONGELADA — Conversão Lead → Aluno (v2 FINAL · 11/06/2026)

v2 substitui a v1. Esta é a régua DEFINITIVA — nenhuma mudança entra sem nova
versão deste arquivo. Número de referência certificado na ativação:
**junho/2026 = 8 matrículas** (2 de conversas de junho + 6 de meses anteriores).

## O que conta como "lead" pra conversão
TODA conversa do Fluxo (com OU sem etiqueta de anúncio — Instagram/orgânico
incluídos). A etiqueta anuncio/* filtra só a LISTA da aba, não o cruzamento.
"Todo mundo que virou venda conta como lead."

## Fontes (NocoDB é a verdade; EVO é só sincronizador)
Leads (todas as conversas, acumula SEM apagar) · Membros (importação mensal)
· VendasEvo (1 linha/matrícula, com TELEFONE do aluno buscado na EVO)
· LeadConversoes (fatos, append-only).

## Match (ordem fixa; primeira que casar vence)
1. VENDA por TELEFONE (últimos 8 dígitos) — sale_date >= data da conversa → VIROU.
2. VENDA por NOME completo (≥2 palavras) — idem.
3. MEMBROS por TELEFONE → decide pela **DataCadastro** (entrada REAL do aluno):
   cadastro >= conversa → VIROU · cadastro < conversa → JÁ ERA ALUNO.
4. MEMBROS por NOME completo — idem.
Sem match → conversa em aberto (não conta em nada).

## Atribuição
Conversão conta no MÊS DA MATRÍCULA. Conversa de qualquer mês anterior pode
converter no mês atual (janela = todos os meses importados).

## Números na tela
- Card "Viraram alunos" (mês X) = matrículas em X de conversas de QUALQUER mês.
  Texto mostra a quebra deste mês × anteriores.
- Chip "Viraram (desta lista)" = só os leads ETIQUETADOS do mês listado.
- Taxa de conversão = matrículas no mês ÷ leads de anúncio do mês.

## CONTRATO DE CONFIABILIDADE
1. LeadConversoes é APPEND-ONLY → o número NUNCA diminui. Diminuiu sem alguém
   apagar linhas da tabela? É BUG — reportar imediatamente.
2. Scan/sync nunca bloqueiam requisição; durante o scan a tela mostra "—" e
   "conferindo vendas…", nunca um zero falso.
3. Auditoria nominal permanente: /api/leads-360?month=YYYY-MM
   (vendasNoMes = vendasQueCasaram + vendasSemLead, sempre fechando).
