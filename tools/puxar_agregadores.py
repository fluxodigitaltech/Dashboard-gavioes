#!/usr/bin/env python3
"""
Puxa os agregadores (Gympass/Wellhub, TotalPass, etc.) da base de prospects da EVO
e gera uma planilha CSV (abre direto no Excel / Google Sheets).

Sistema à parte — não depende do app React/Vite. Só biblioteca padrão do Python.

Uso simples (vai perguntar o que faltar):
    python3 tools/puxar_agregadores.py

Uso com tudo na linha:
    python3 tools/puxar_agregadores.py \
        --token SEU_TOKEN --inicio 2026-06-01 --fim 2026-06-17

Outras opções:
    --dns gavioes           (padrão: gavioes)
    --campo register        (register = data de registro | conversion = data de conversão)
    --todos                 (inclui TODOS os prospects, não só agregadores)
    --saida caminho.csv     (padrão: agregadores_INICIO_FIM.csv)
"""

import argparse
import base64
import csv
import getpass
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date

EVO_BASE = "https://evo-integracao-api.w12app.com.br"
TAKE = 50            # máximo permitido pelo endpoint /api/v1/prospects
THROTTLE_S = 0.7     # ritmo anti-429 (EVO bloqueia acima de ~3 req/s)
SAFETY_PAGES = 400   # teto de páginas (400 * 50 = 20 mil prospects)

# Palavras que marcam um prospect como vindo de agregador.
AGG_KEYWORDS = [
    "gympass", "wellhub", "totalpass", "total pass",
    "benefit", "flash", "vidalink", "agregador", "convenio", "convênio",
]


def plataforma(p):
    if p.get("gympassId"):
        return "Gympass / Wellhub"
    t = ((p.get("signupType") or "") + " " + (p.get("mktChannel") or "")).lower()
    if "gympass" in t or "wellhub" in t:
        return "Gympass / Wellhub"
    if "totalpass" in t or "total pass" in t:
        return "TotalPass"
    if "benefit" in t:
        return "Benefit Club"
    if "flash" in t:
        return "Flash Benefícios"
    if "vidalink" in t:
        return "Vidalink"
    return p.get("signupType") or p.get("mktChannel") or "Outro"


def eh_agregador(p):
    gid = p.get("gympassId")
    if gid and str(gid).strip():
        return True
    t = ((p.get("signupType") or "") + " " + (p.get("mktChannel") or "")).lower()
    return any(k in t for k in AGG_KEYWORDS)


def nome(p):
    n = " ".join(x for x in [p.get("firstName"), p.get("lastName")] if x).strip()
    return n or p.get("registerName") or "—"


def fmt_data(s):
    if not s:
        return ""
    return str(s)[:10]  # YYYY-MM-DD


def buscar_prospects(dns, token, campo, inicio, fim):
    auth = base64.b64encode(f"{dns}:{token}".encode()).decode()
    start_iso = f"{inicio}T00:00:00"
    end_iso = f"{fim}T23:59:59"
    if campo == "conversion":
        date_params = f"conversionDateStart={start_iso}&conversionDateEnd={end_iso}"
    else:
        date_params = f"registerDateStart={start_iso}&registerDateEnd={end_iso}"

    todos = []
    skip = 0
    for page in range(SAFETY_PAGES):
        url = f"{EVO_BASE}/api/v1/prospects?{date_params}&take={TAKE}&skip={skip}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:  # rate limit → espera e tenta de novo a mesma página
                print("  429 (limite de requisições) — aguardando 3s…", file=sys.stderr)
                time.sleep(3)
                continue
            corpo = e.read().decode("utf-8", "replace")[:300]
            raise SystemExit(f"Erro da EVO HTTP {e.code}: {corpo}")
        except urllib.error.URLError as e:
            raise SystemExit(f"Falha de conexão com a EVO: {e.reason}")

        arr = data if isinstance(data, list) else (
            data.get("prospects") or data.get("data") or data.get("result") or []
        )
        todos.extend(arr)
        print(f"  página {page + 1}: +{len(arr)}  (total {len(todos)})", file=sys.stderr)
        if len(arr) < TAKE:
            break
        skip += TAKE
        time.sleep(THROTTLE_S)
    return todos


def main():
    ap = argparse.ArgumentParser(description="Puxa agregadores da base de prospects da EVO → CSV.")
    ap.add_argument("--dns", default="gavioes")
    ap.add_argument("--token")
    ap.add_argument("--inicio", help="data início YYYY-MM-DD")
    ap.add_argument("--fim", help="data fim YYYY-MM-DD")
    ap.add_argument("--campo", choices=["register", "conversion"], default="register")
    ap.add_argument("--todos", action="store_true", help="inclui não-agregadores também")
    ap.add_argument("--saida")
    args = ap.parse_args()

    # pergunta o que faltar
    token = args.token or getpass.getpass("Token da unidade: ").strip()
    if not token:
        raise SystemExit("Token é obrigatório.")
    hoje = date.today()
    inicio = args.inicio or input(f"Data início [{hoje.replace(day=1)}]: ").strip() or str(hoje.replace(day=1))
    fim = args.fim or input(f"Data fim [{hoje}]: ").strip() or str(hoje)

    print(f"\nBuscando prospects de {inicio} a {fim} (DNS={args.dns}, por data de "
          f"{'conversão' if args.campo == 'conversion' else 'registro'})…", file=sys.stderr)
    prospects = buscar_prospects(args.dns, token, args.campo, inicio, fim)
    agregadores = [p for p in prospects if eh_agregador(p)]
    linhas = prospects if args.todos else agregadores

    # resumo por plataforma
    por_plat = {}
    for p in agregadores:
        k = plataforma(p)
        por_plat[k] = por_plat.get(k, 0) + 1

    print(f"\n  Prospects no período: {len(prospects)}", file=sys.stderr)
    print(f"  Via agregadores:      {len(agregadores)}", file=sys.stderr)
    for k, n in sorted(por_plat.items(), key=lambda x: -x[1]):
        print(f"     - {k}: {n}", file=sys.stderr)

    saida = args.saida or f"agregadores_{inicio}_{fim}.csv"
    cols = ["Nome", "Plataforma", "Unidade", "GympassID", "SignupType",
            "mktChannel", "Telefone", "Email", "Registro", "Conversao"]
    # utf-8-sig (BOM) p/ acento sair certo no Excel
    with open(saida, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for p in linhas:
            w.writerow([
                nome(p), plataforma(p), p.get("branchName") or p.get("idBranch") or "",
                p.get("gympassId") or "", p.get("signupType") or "", p.get("mktChannel") or "",
                p.get("cellphone") or "", p.get("email") or "",
                fmt_data(p.get("registerDate")), fmt_data(p.get("conversionDate")),
            ])

    print(f"\n✅ Planilha gerada: {saida}  ({len(linhas)} linhas)", file=sys.stderr)


if __name__ == "__main__":
    main()
