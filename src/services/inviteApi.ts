// ─── Cliente do mini-backend de convites (/api/*) ────────────────────────────
// O backend (server/index.mjs) roda no mesmo domínio; o nginx faz proxy de /api.

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: { error?: string; detail?: string } & Record<string, unknown> = {};
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  if (!res.ok) {
    const msg = data?.error || `Erro ${res.status} ao chamar ${path}`;
    throw new Error(data?.detail ? `${msg} (${data.detail})` : msg);
  }
  return data as T;
}

/** Admin: gera convite e dispara o e-mail pra pessoa definir a senha. */
export async function sendInvite(email: string): Promise<void> {
  await postJson('/api/invite', { email: email.trim().toLowerCase() });
}

/** Convidado: define a senha usando o token recebido por e-mail. */
export async function setPasswordWithToken(token: string, password: string): Promise<{ email: string }> {
  return postJson('/api/set-password', { token, password });
}

/** Saúde do backend de e-mail (usado pra avisar se o SMTP não está configurado). */
export async function inviteHealth(): Promise<{ ok: boolean; smtp?: boolean; noco?: boolean }> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return { ok: false };
    return await res.json();
  } catch {
    return { ok: false };
  }
}
