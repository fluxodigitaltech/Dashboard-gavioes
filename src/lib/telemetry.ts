/**
 * Funil único de erros. Hoje só loga no console; é o ÚNICO ponto a tocar quando
 * for plugar observabilidade (Sentry/LogRocket): basta inicializar o SDK e
 * encaminhar `captureError` aqui — o resto do app já chama este helper.
 *
 * Uso: captureError(err, { scope: 'fetchBranchStats', branch: name }).
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  const ctx = context ? ` ${JSON.stringify(context)}` : '';
  console.error(`[telemetry]${ctx}`, error);
  // TODO(observabilidade): if (sentryEnabled) Sentry.captureException(error, { extra: context });
}
