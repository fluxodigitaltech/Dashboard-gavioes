#!/usr/bin/env python3
"""
Interface gráfica (tkinter) p/ puxar os agregadores da base de prospects da EVO.

Sistema à parte — não depende do app React/Vite. Só biblioteca padrão do Python.

Como abrir:
    python3 tools/agregadores_gui.py

Preencha DNS + token + período, clique em "Puxar agregadores", veja a tabela
e clique em "Exportar planilha (CSV)".
"""

import base64
import csv
import json
import threading
import time
import urllib.error
import urllib.request
from datetime import date

import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# ─── Config / lógica de busca ──────────────────────────────────────────────────
EVO_BASE = "https://evo-integracao-api.w12app.com.br"
TAKE = 50
THROTTLE_S = 0.7
SAFETY_PAGES = 400
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
    return str(s)[:10] if s else ""


def buscar_prospects(dns, token, campo, inicio, fim, log):
    auth = base64.b64encode(f"{dns}:{token}".encode()).decode()
    start_iso, end_iso = f"{inicio}T00:00:00", f"{fim}T23:59:59"
    if campo == "conversion":
        date_params = f"conversionDateStart={start_iso}&conversionDateEnd={end_iso}"
    else:
        date_params = f"registerDateStart={start_iso}&registerDateEnd={end_iso}"

    todos, skip = [], 0
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
            if e.code == 429:
                log("Limite de requisições (429) — aguardando 3s…")
                time.sleep(3)
                continue
            corpo = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"Erro da EVO HTTP {e.code}: {corpo}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"Falha de conexão com a EVO: {e.reason}")

        arr = data if isinstance(data, list) else (
            data.get("prospects") or data.get("data") or data.get("result") or []
        )
        todos.extend(arr)
        log(f"Página {page + 1}: +{len(arr)} (total {len(todos)})")
        if len(arr) < TAKE:
            break
        skip += TAKE
        time.sleep(THROTTLE_S)
    return todos


COLS = ["Nome", "Plataforma", "Unidade", "GympassID", "SignupType",
        "mktChannel", "Telefone", "Email", "Registro", "Conversao"]


def linha_de(p):
    return [
        nome(p), plataforma(p), p.get("branchName") or p.get("idBranch") or "",
        p.get("gympassId") or "", p.get("signupType") or "", p.get("mktChannel") or "",
        p.get("cellphone") or "", p.get("email") or "",
        fmt_data(p.get("registerDate")), fmt_data(p.get("conversionDate")),
    ]


# ─── Interface ─────────────────────────────────────────────────────────────────
VERDE = "#0F3C23"
VERDE_CLARO = "#E8F5EC"
CINZA = "#64748B"


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Puxar Agregadores — EVO")
        self.geometry("1080x680")
        self.configure(bg="#F4F7F5")
        self.linhas = []  # resultado atual (lista de dicts de prospect)

        self._estilos()
        self._cabecalho()
        self._form()
        self._resumo()
        self._tabela()
        self._rodape_status()

    def _estilos(self):
        st = ttk.Style(self)
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("TFrame", background="#F4F7F5")
        st.configure("Card.TFrame", background="white")
        st.configure("TLabel", background="#F4F7F5", foreground="#0F172A", font=("Segoe UI", 10))
        st.configure("Hint.TLabel", background="#F4F7F5", foreground=CINZA, font=("Segoe UI", 9))
        st.configure("H1.TLabel", background="#F4F7F5", foreground=VERDE, font=("Segoe UI", 20, "bold"))
        st.configure("Stat.TLabel", background="white", foreground=VERDE, font=("Segoe UI", 16, "bold"))
        st.configure("StatL.TLabel", background="white", foreground=CINZA, font=("Segoe UI", 8, "bold"))
        st.configure("Accent.TButton", font=("Segoe UI", 10, "bold"))
        st.configure("Treeview", rowheight=26, font=("Segoe UI", 9))
        st.configure("Treeview.Heading", font=("Segoe UI", 9, "bold"))

    def _cabecalho(self):
        top = ttk.Frame(self, padding=(20, 16, 20, 4))
        top.pack(fill="x")
        ttk.Label(top, text="Puxar Agregadores — EVO", style="H1.TLabel").pack(anchor="w")
        ttk.Label(top, text="Busca a base de prospects (oportunidades) e isola os membros "
                            "vindos de agregadores (Gympass/Wellhub, TotalPass, etc.).",
                  style="Hint.TLabel").pack(anchor="w")

    def _form(self):
        f = ttk.Frame(self, padding=(20, 8))
        f.pack(fill="x")

        hoje = date.today()
        self.var_dns = tk.StringVar(value="gavioes")
        self.var_token = tk.StringVar()
        self.var_inicio = tk.StringVar(value=str(hoje.replace(day=1)))
        self.var_fim = tk.StringVar(value=str(hoje))
        self.var_campo = tk.StringVar(value="register")
        self.var_todos = tk.BooleanVar(value=False)

        def campo(lbl, var, col, width=16, show=None):
            cell = ttk.Frame(f)
            cell.grid(row=0, column=col, padx=(0, 12), sticky="w")
            ttk.Label(cell, text=lbl, style="Hint.TLabel").pack(anchor="w")
            e = ttk.Entry(cell, textvariable=var, width=width, show=show)
            e.pack()
            return e

        campo("DNS", self.var_dns, 0, 12)
        self.entry_token = campo("Token", self.var_token, 1, 26, show="•")
        # botão mostrar/ocultar token
        self.var_ver = tk.BooleanVar(value=False)
        ttk.Checkbutton(f, text="ver", variable=self.var_ver,
                        command=self._toggle_token).grid(row=0, column=2, sticky="w", padx=(0, 12))

        cell = ttk.Frame(f); cell.grid(row=0, column=3, padx=(0, 12), sticky="w")
        ttk.Label(cell, text="Filtrar por", style="Hint.TLabel").pack(anchor="w")
        ttk.Combobox(cell, textvariable=self.var_campo, width=14, state="readonly",
                     values=["register", "conversion"]).pack()

        campo("Início (AAAA-MM-DD)", self.var_inicio, 4, 14)
        campo("Fim (AAAA-MM-DD)", self.var_fim, 5, 14)

        # linha de ações
        a = ttk.Frame(self, padding=(20, 4, 20, 8))
        a.pack(fill="x")
        self.btn_run = ttk.Button(a, text="Puxar agregadores", style="Accent.TButton", command=self._run)
        self.btn_run.pack(side="left")
        self.btn_export = ttk.Button(a, text="Exportar planilha (CSV)", command=self._export, state="disabled")
        self.btn_export.pack(side="left", padx=8)
        ttk.Checkbutton(a, text="Mostrar todos os prospects (não só agregadores)",
                        variable=self.var_todos, command=self._redraw).pack(side="left", padx=8)

    def _toggle_token(self):
        self.entry_token.config(show="" if self.var_ver.get() else "•")

    def _resumo(self):
        self.resumo = ttk.Frame(self, padding=(20, 0))
        self.resumo.pack(fill="x")

    def _tabela(self):
        wrap = ttk.Frame(self, padding=(20, 8))
        wrap.pack(fill="both", expand=True)
        self.tree = ttk.Treeview(wrap, columns=COLS, show="headings", selectmode="browse")
        larguras = {"Nome": 180, "Plataforma": 130, "Unidade": 110, "GympassID": 110,
                    "SignupType": 110, "mktChannel": 110, "Telefone": 110, "Email": 180,
                    "Registro": 90, "Conversao": 90}
        for c in COLS:
            self.tree.heading(c, text=c)
            self.tree.column(c, width=larguras.get(c, 100), anchor="w")
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        hsb = ttk.Scrollbar(wrap, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb.grid(row=0, column=1, sticky="ns")
        hsb.grid(row=1, column=0, sticky="ew")
        wrap.rowconfigure(0, weight=1)
        wrap.columnconfigure(0, weight=1)

    def _rodape_status(self):
        self.var_status = tk.StringVar(value="Pronto. Preencha o token e o período.")
        bar = ttk.Frame(self, padding=(20, 4, 20, 10))
        bar.pack(fill="x")
        ttk.Label(bar, textvariable=self.var_status, style="Hint.TLabel").pack(anchor="w")

    # ─── Ações ─────────────────────────────────────────────────────────────────
    def _status(self, msg):
        self.var_status.set(msg)
        self.update_idletasks()

    def _run(self):
        token = self.var_token.get().strip()
        if not token:
            messagebox.showwarning("Token", "Cole o token da unidade.")
            return
        ini, fim = self.var_inicio.get().strip(), self.var_fim.get().strip()
        if not ini or not fim:
            messagebox.showwarning("Período", "Informe início e fim (AAAA-MM-DD).")
            return
        self.btn_run.config(state="disabled")
        self.btn_export.config(state="disabled")
        self._status("Buscando…")
        threading.Thread(
            target=self._worker,
            args=(self.var_dns.get().strip(), token, self.var_campo.get(), ini, fim),
            daemon=True,
        ).start()

    def _worker(self, dns, token, campo, ini, fim):
        try:
            prospects = buscar_prospects(dns, token, campo, ini, fim,
                                         lambda m: self.after(0, self._status, m))
        except Exception as e:  # noqa: BLE001 — qualquer falha vira mensagem na UI
            self.after(0, self._erro, str(e))
            return
        self.after(0, self._ok, prospects)

    def _erro(self, msg):
        self.btn_run.config(state="normal")
        self._status("Erro.")
        messagebox.showerror("Erro ao puxar da EVO", msg)

    def _ok(self, prospects):
        self.prospects = prospects
        self.btn_run.config(state="normal")
        agg = [p for p in prospects if eh_agregador(p)]
        self._status(f"Concluído — {len(prospects)} prospects, {len(agg)} via agregadores.")
        self._redraw()

    def _redraw(self):
        prospects = getattr(self, "prospects", [])
        agg = [p for p in prospects if eh_agregador(p)]
        self.linhas = prospects if self.var_todos.get() else agg

        # resumo (cards)
        for w in self.resumo.winfo_children():
            w.destroy()
        por_plat = {}
        for p in agg:
            k = plataforma(p)
            por_plat[k] = por_plat.get(k, 0) + 1
        cards = [("Prospects no período", len(prospects)), ("Via agregadores", len(agg))]
        cards += sorted(por_plat.items(), key=lambda x: -x[1])
        for lbl, n in cards:
            c = tk.Frame(self.resumo, bg="white", highlightbackground="#E5EAE7",
                         highlightthickness=1, padx=16, pady=8)
            c.pack(side="left", padx=(0, 10), pady=4)
            tk.Label(c, text=str(n), bg="white", fg=VERDE,
                     font=("Segoe UI", 16, "bold")).pack(anchor="w")
            tk.Label(c, text=lbl.upper(), bg="white", fg=CINZA,
                     font=("Segoe UI", 8, "bold")).pack(anchor="w")

        # tabela
        self.tree.delete(*self.tree.get_children())
        for p in self.linhas:
            self.tree.insert("", "end", values=linha_de(p))
        self.btn_export.config(state="normal" if self.linhas else "disabled")

    def _export(self):
        if not self.linhas:
            return
        nome_pad = f"agregadores_{self.var_inicio.get()}_{self.var_fim.get()}.csv"
        caminho = filedialog.asksaveasfilename(
            defaultextension=".csv", initialfile=nome_pad,
            filetypes=[("CSV (Excel / Sheets)", "*.csv")])
        if not caminho:
            return
        with open(caminho, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(COLS)
            for p in self.linhas:
                w.writerow(linha_de(p))
        self._status(f"Planilha salva: {caminho} ({len(self.linhas)} linhas)")
        messagebox.showinfo("Planilha gerada", f"Salvo em:\n{caminho}\n\n{len(self.linhas)} linhas.")


if __name__ == "__main__":
    App().mainloop()
