// Janela deslizante (sliding window log) em memória.
// Cada chave guarda os timestamps das tentativas recentes; limpeza periódica remove chaves inativas.
export function createRateLimiter({ limit, windowMs, sweepMs = 60_000 }) {
  const hits = new Map();

  const sweep = (now = Date.now()) => {
    for (const [key, stamps] of hits) {
      const fresh = stamps.filter((time) => time > now - windowMs);
      if (fresh.length) hits.set(key, fresh);
      else hits.delete(key);
    }
  };

  const timer = setInterval(() => sweep(), sweepMs);
  timer.unref();

  function hit(key, now = Date.now()) {
    const fresh = (hits.get(key) ?? []).filter((time) => time > now - windowMs);
    if (fresh.length >= limit) {
      hits.set(key, fresh);
      const retryAfter = Math.max(1, Math.ceil((fresh[0] + windowMs - now) / 1000));
      return { allowed: false, retryAfter, remaining: 0 };
    }
    fresh.push(now);
    hits.set(key, fresh);
    return { allowed: true, retryAfter: 0, remaining: limit - fresh.length };
  }

  return {
    hit,
    sweep,
    size: () => hits.size,
    close: () => clearInterval(timer),
  };
}
