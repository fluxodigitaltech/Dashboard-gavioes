# 🛡️ Branch Protection — Guia de Configuração

Este documento descreve as regras de proteção de branch recomendadas para qualquer projeto baseado neste template. Aplicar essas regras é **manual** e deve ser feito em **Settings → Branches → Add branch ruleset** (ou **Add classic branch protection rule**) logo após criar o repositório.

---

## 🎯 Por que proteger a `main`?

A branch `main` representa o estado de produção. Sem proteção, qualquer pessoa com acesso pode:

- Fazer `force push` e reescrever o histórico (perdendo commits).
- Deletar a branch acidentalmente.
- Subir código quebrado direto sem revisão.
- Ignorar o CI e mergear PRs com falhas.

Branch protection elimina esses riscos com regras automáticas.

---

## ✅ Regras recomendadas (mínimo obrigatório)

Aplicar à branch `main` (e `develop` se existir):

| # | Regra | Valor | Motivo |
|---|---|---|---|
| 1 | **Require a pull request before merging** | ✔️ Ativo | Nada vai direto pra main sem PR |
| 2 | **Require approvals** | 1 (ou mais) | Revisão obrigatória antes do merge |
| 3 | **Dismiss stale pull request approvals when new commits are pushed** | ✔️ Ativo | Re-aprovação após mudanças |
| 4 | **Require status checks to pass before merging** | ✔️ Ativo | CI obrigatório |
| 5 | **Require branches to be up to date before merging** | ✔️ Ativo | Evita merge com base desatualizada |
| 6 | **Status checks obrigatórios** | `lint`, `validate-json`, `gitleaks` | Quality gates do template |
| 7 | **Require conversation resolution before merging** | ✔️ Ativo | Sem PR com comentários abertos |
| 8 | **Require linear history** | ✔️ Ativo | Histórico limpo, sem merge commits desnecessários |
| 9 | **Do not allow bypassing the above settings** | ✔️ Ativo | Regra vale até para admins |
| 10 | **Restrict who can push to matching branches** | ✔️ Ativo | Só mantenedores autorizados |
| 11 | **Allow force pushes** | ❌ Desativado | Proibir reescrita de histórico |
| 12 | **Allow deletions** | ❌ Desativado | Proibir deletar a branch |

---

## 🌟 Recomendado (opcional, mas ideal)

| Regra | Quando usar |
|---|---|
| **Require signed commits** | Quando há requisito de auditoria/compliance. Exige GPG ou SSH signing. |
| **Require deployments to succeed before merging** | Quando há ambientes de staging/preview. |
| **Lock branch (read-only)** | Para branches de release antigas que não devem mais receber commits. |
| **CodeQL / Dependency review** | Para projetos com código de aplicação (não só assets). |

---

## 📋 Como aplicar (passo a passo)

1. Vá ao seu repositório → **Settings**.
2. No menu lateral, clique em **Branches**.
3. Em **Branch protection rules** (ou **Branch rulesets** no novo modelo), clique em **Add rule** / **New ruleset**.
4. Em **Branch name pattern**, digite `main`.
5. Marque cada uma das regras da tabela acima.
6. Em **Status checks**, busque por:
   - `lint`
   - `validate-json`
   - `gitleaks`
   - `Conventional Commits Check` (em PRs)
7. Clique em **Create** / **Save changes**.
8. Repita para a branch `develop` se aplicável.

---

## 🚀 Workflow esperado após proteção

```bash
# Criar branch a partir da main
git switch -c feat/minha-feature

# Trabalhar e commitar (Conventional Commits)
git add .
git commit -m "feat: adiciona X"
git push origin feat/minha-feature

# Abrir Pull Request no GitHub
# Aguardar CI verde + aprovação
# Mergear via "Squash and merge" ou "Rebase and merge"
```

`main` jamais recebe commits diretos. **Sempre via PR.**

---

## 🔗 Referências

- [GitHub Docs — About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Docs — Available branch protection settings](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#about-branch-protection-settings)
- [GitHub Docs — Repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets-for-a-repository)

---

> 🛡️ Aplicar essas regras leva 2 minutos e elimina 90% dos acidentes em produção.
