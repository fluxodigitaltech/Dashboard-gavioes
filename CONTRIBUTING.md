# 🤝 Guia de Contribuição

Obrigado por contribuir com este projeto da **Fluxo Digital Tech**! Para manter o padrão, siga as diretrizes abaixo.

---

## 📝 Conventional Commits

Use sempre o padrão [Conventional Commits](https://www.conventionalcommits.org/):

| Tipo | Quando usar |
|------|-------------|
| `feat` | Nova funcionalidade |
| `fix` | Correção de bug |
| `docs` | Apenas documentação |
| `style` | Formatação, ponto e vírgula etc. (sem mudança de lógica) |
| `refactor` | Refatoração sem nova feature ou bugfix |
| `perf` | Melhoria de performance |
| `test` | Adição ou ajuste de testes |
| `build` | Mudanças no sistema de build/dependências |
| `ci` | Mudanças em CI/CD |
| `chore` | Tarefas de manutenção |
| `revert` | Reverter um commit |

**Exemplos:**

```
feat: adiciona integração com WhatsApp Cloud API
fix(auth): corrige expiração do token JWT
docs: atualiza README com novos endpoints
refactor: extrai service de envio de e-mail
chore: atualiza dependências
```

---

## 🌿 Branches

- `main` — produção. **Protegida**, recebe só PRs aprovados com CI verde.
- `develop` — integração (opcional).
- `feat/<nome>` — nova funcionalidade.
- `fix/<nome>` — correção de bug.
- `hotfix/<nome>` — correção urgente em produção.
- `docs/<nome>` — só documentação.

Use **kebab-case** nos nomes de arquivos e branches.

---

## 🛡️ Branch Protection (main)

A branch `main` é protegida. **Não tente push direto.** O fluxo é sempre:

1. Crie uma branch a partir da `main`.
2. Faça seus commits seguindo Conventional Commits.
3. Abra um **Pull Request** para `main`.
4. Aguarde:
   - ✅ CI verde (lint, validate-json, gitleaks).
   - ✅ Conventional Commits Check no título do PR.
   - ✅ Pelo menos 1 aprovação na revisão.
   - ✅ Conversas resolvidas.
5. Faça merge usando **Squash and merge** ou **Rebase and merge** (mantém histórico linear).

Detalhes completos em [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md).

---

## 🔄 Fluxo de Pull Request

```bash
# 1. Atualizar a main local
git switch main
git pull origin main

# 2. Criar branch
git switch -c feat/minha-feature

# 3. Trabalhar e commitar
git add .
git commit -m "feat: descrição clara do que foi feito"

# 4. Push
git push origin feat/minha-feature

# 5. Abrir PR no GitHub usando o template
```

### Antes de abrir o PR

- [ ] CI local passou (`npm test`, `npm run lint`, etc., se aplicável).
- [ ] Não há credenciais ou `.env` no diff.
- [ ] CHANGELOG.md atualizado (se for mudança visível).
- [ ] README atualizado (se mudou comportamento ou setup).

---

## 🔐 Segurança

- **Nunca** comite `.env`, chaves, tokens ou credenciais.
- Use `.env.example` como referência das variáveis necessárias.
- O scanner **gitleaks** roda automaticamente — PRs com segredos serão bloqueados.
- Vulnerabilidades: ver [SECURITY.md](SECURITY.md).

---

## 🐛 Reportando bugs

Use o template de **Bug Report** em Issues. Inclua:

- Versão / commit afetado.
- Passos para reproduzir.
- Comportamento esperado vs. observado.
- Logs e screenshots quando relevante.

---

## ✨ Sugerindo features

Use o template de **Feature Request** em Issues. Descreva:

- Problema que a feature resolve.
- Solução proposta.
- Alternativas consideradas.
- Impacto esperado.

---

## 📐 Padrões de código

- **Arquivos**: kebab-case (`meu-arquivo.js`).
- **Variáveis/funções**: camelCase.
- **Classes**: PascalCase.
- **Constantes**: UPPER_SNAKE_CASE.
- **Indentação**: 2 spaces (4 para Python) — definido em `.editorconfig`.

---

## 🙋 Dúvidas

Abra uma issue com label `question` ou entre em contato:

- 🌍 [fluxodigitaltech.com.br](https://fluxodigitaltech.com.br)
- ✉️ [fluxodigitaltech@gmail.com](mailto:fluxodigitaltech@gmail.com)

---

> Construído para escalar negócios com **automação, IA e estratégia**.
