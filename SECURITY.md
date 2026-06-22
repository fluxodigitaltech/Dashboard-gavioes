# 🔐 Política de Segurança

## Versões suportadas

Apenas a versão mais recente da branch `main` recebe correções de segurança.

| Versão | Suporte |
|---|---|
| Latest `main` | ✅ |
| Versões anteriores | ❌ |

---

## 🐛 Reportando uma vulnerabilidade

Se você encontrar uma vulnerabilidade neste projeto, **não abra uma issue pública**. Em vez disso:

1. Envie um e-mail para **fluxodigitaltech@gmail.com** com:
   - Descrição do problema
   - Passos para reproduzir
   - Impacto potencial
   - (Opcional) Sugestão de correção
2. Aguarde confirmação em até **72 horas**.
3. Trabalharemos em uma correção em coordenação com você.
4. Após a correção, divulgaremos publicamente com créditos (se desejado).

---

## 🛡️ Controles de segurança ativos

Este template já vem com camadas automatizadas de segurança:

| Controle | Onde | O que faz |
|---|---|---|
| **gitleaks** | `.github/workflows/gitleaks.yml` | Bloqueia commits/PRs com credenciais vazadas |
| **Dependabot** | `.github/dependabot.yml` | Atualiza dependências vulneráveis automaticamente |
| **CI / lint** | `.github/workflows/ci.yml` | Valida JSON e padrão de PR antes do merge |
| **Branch protection** | Settings → Branches | Impede push direto/force push e exige CI verde |
| **Conventional Commits** | `amannn/action-semantic-pull-request` | Padroniza mensagens e facilita auditoria |

📖 Veja o guia completo em [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md).

---

## 🔒 Branch Protection (obrigatório em produção)

Toda branch `main` **deve** ter as seguintes proteções ativas:

- ✅ Require pull request before merging
- ✅ Require approvals (mínimo 1)
- ✅ Require status checks to pass (`lint`, `validate-json`, `gitleaks`)
- ✅ Require branches to be up to date before merging
- ✅ Require conversation resolution before merging
- ✅ Require linear history
- ❌ Allow force pushes — **DESATIVADO**
- ❌ Allow deletions — **DESATIVADO**

Sem essas proteções, qualquer credencial vazada pode chegar à `main` mesmo com gitleaks ativo (via force push), e o histórico pode ser reescrito sem auditoria.

---

## ✅ Boas práticas para colaboradores

- **Nunca** commite credenciais, tokens, chaves de API ou arquivos `.env`.
- Use `.env.example` para documentar variáveis de ambiente.
- Antes de cada push, revise o diff: `git diff --staged`.
- Configure pre-commit hooks (ex.: `gitleaks`, `detect-secrets`) sempre que possível.
- Mantenha dependências atualizadas (`npm audit`, `pip-audit`, Dependabot).
- Use **2FA** na sua conta GitHub.
- Use **GPG/SSH signing** em commits quando possível.

---

## 🚨 O que fazer se uma credencial foi commitada

Mesmo com gitleaks rodando, se algo escapar:

1. **Revogue imediatamente** a credencial no provedor (não basta remover do código).
2. Gere uma nova credencial e atualize onde for necessário.
3. Limpe o histórico do Git com [`git filter-repo`](https://github.com/newren/git-filter-repo) ou [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/).
4. Force push (em coordenação com a equipe) para reescrever o histórico remoto.
5. Considere tornar o repositório **privado** se ele continha dados sensíveis.

> ⚠️ Lembre-se: revogar a credencial é o passo **mais importante**. Limpar o histórico não desfaz vazamentos já clonados.

---

## 📞 Contato de segurança

- ✉️ **fluxodigitaltech@gmail.com**
- 🌍 [fluxodigitaltech.com.br](https://fluxodigitaltech.com.br)

---

> 🔐 Segurança é processo, não produto. Mantenha as camadas ativas e o time treinado.
