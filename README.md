# 🚀 Project Template — Fluxo Digital Tech

[![Use this template](https://img.shields.io/badge/use%20this-template-2ea44f?style=for-the-badge&logo=github)](https://github.com/fluxodigitaltech/project-template/generate)
[![CI](https://github.com/fluxodigitaltech/project-template/actions/workflows/ci.yml/badge.svg)](https://github.com/fluxodigitaltech/project-template/actions/workflows/ci.yml)
[![Secret Scan](https://github.com/fluxodigitaltech/project-template/actions/workflows/gitleaks.yml/badge.svg)](https://github.com/fluxodigitaltech/project-template/actions/workflows/gitleaks.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196.svg?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org)
[![Keep a Changelog](https://img.shields.io/badge/Keep%20a%20Changelog-1.1.0-orange.svg)](https://keepachangelog.com/pt-BR/1.1.0/)
[![SemVer](https://img.shields.io/badge/SemVer-2.0.0-blue.svg)](https://semver.org/lang/pt-BR/)

Template oficial da **Fluxo Digital Tech** para iniciar novos projetos com toda a governança, automação e segurança já configuradas.

---

## 📦 Como usar

1. Clique em **`Use this template`** → **`Create a new repository`**.
2. Escolha o nome do novo repositório.
3. Clone localmente:
   ```bash
   git clone https://github.com/fluxodigitaltech/<nome-do-projeto>.git
   cd <nome-do-projeto>
   cp .env.example .env
   ```
4. Edite `README.md`, `CHANGELOG.md` e `.env` com os dados do projeto.
5. Comece a desenvolver seguindo o padrão.

---

## 🧱 O que vem incluído

### 📄 Documentação
- `README.md` — overview do projeto.
- `CHANGELOG.md` — histórico de versões (Keep a Changelog + SemVer).
- `CONTRIBUTING.md` — guia de contribuição com Conventional Commits.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `SECURITY.md` — política de divulgação responsável.
- `LICENSE` — MIT.

### 🤖 Automação (GitHub Actions)
- **CI** (`.github/workflows/ci.yml`) — lint, validação de JSON e checagem de PR title.
- **Secret Scan** (`.github/workflows/gitleaks.yml`) — gitleaks em push/PR e semanalmente.
- **Dependabot** (`.github/dependabot.yml`) — atualizações semanais (Actions, npm, pip, Docker).

### 📋 Templates
- Pull Request (`.github/PULL_REQUEST_TEMPLATE.md`).
- Issue: bug report e feature request (`.github/ISSUE_TEMPLATE/`).

### ⚙️ Configuração
- `.gitignore` — credenciais, node, python, editores.
- `.editorconfig` — formatação consistente entre IDEs.
- `.env.example` — variáveis documentadas.

---

## 📐 Padrões adotados

| Padrão | Especificação |
| --- | --- |
| Commits | [Conventional Commits 1.0.0](https://www.conventionalcommits.org) |
| Versionamento | [Semantic Versioning 2.0.0](https://semver.org) |
| Changelog | [Keep a Changelog 1.1.0](https://keepachangelog.com) |
| Branches | `main` (produção), `feat/*`, `fix/*`, `hotfix/*` |
| Arquivos | kebab-case |
| Segurança | nunca commitar credenciais — usar `.env` e secrets |

### Tipos de commit aceitos

`feat` · `fix` · `docs` · `style` · `refactor` · `perf` · `test` · `build` · `ci` · `chore` · `revert`

---

## 🔐 Segurança

- **Nunca** faça commit de `.env`, chaves, tokens ou credenciais.
- O scanner **gitleaks** roda automaticamente em todo push/PR.
- Reporte vulnerabilidades conforme [SECURITY.md](SECURITY.md).

---

## 🌐 Fluxo Digital Tech

- 🌍 Site — [fluxodigitaltech.com.br](https://fluxodigitaltech.com.br)
- 📸 Instagram — [@fluxodigital.tech](https://instagram.com/fluxodigital.tech)
- ✉️ E-mail — [fluxodigitaltech@gmail.com](mailto:fluxodigitaltech@gmail.com)

---

> Construído para escalar negócios com **automação, IA e estratégia**.
