export function jitterReconnectDelay(baseDelayMs, jitterRatio, randomValue = Math.random()) {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError('Relay reconnect delay must be a non-negative finite number.');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError('Relay reconnect jitter ratio must be between 0 and 1.');
  }
  const boundedRandom = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0;
  // Jitter only downward so randomization never extends the bounded recovery window.
  return Math.max(0, Math.round(baseDelayMs * (1 - jitterRatio * boundedRandom)));
}

export function remainingReconnectBudget(startedAtMs, nowMs, budgetMs) {
  if (![startedAtMs, nowMs, budgetMs].every(Number.isFinite) || budgetMs < 0) {
    throw new TypeError('Relay reconnect budget timestamps must be finite and the budget non-negative.');
  }
  return Math.max(0, Math.trunc(budgetMs - Math.max(0, nowMs - startedAtMs)));
}
