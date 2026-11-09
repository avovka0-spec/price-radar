// Приблизительный расчёт таможенной пошлины для личных посылок (информационный, не юридическая консультация).
// Правило (для ориентировки): при превышении общей стоимости в эквиваленте ~200 EUR применяется пошлина ~14,3%
// от суммы превышения. Конкретные нормы могут меняться.

export const DEFAULT_EUR_RUB = 95;

export function estimateDutyRub(priceRub: number, eurRate = DEFAULT_EUR_RUB): number {
  const p = Number(priceRub) || 0;
  const rate = Number(eurRate) || DEFAULT_EUR_RUB;
  if (p <= 0 || rate <= 0) return 0;
  const thresholdRub = 200 * rate;
  if (p <= thresholdRub) return 0;
  return Math.round((p - thresholdRub) * 0.143);
}
