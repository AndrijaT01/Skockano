const crypto = require('crypto');

function setSecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
}

function attachRequestId(req, res, next) {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

function createMemoryRateLimiter({ windowMs, max, keyGenerator, skip } = {}) {
  const hits = new Map();
  const ttl = Number(windowMs) || 15 * 60 * 1000;
  const limit = Number(max) || 100;
  const getKey = typeof keyGenerator === 'function' ? keyGenerator : (req) => req.ip || req.socket?.remoteAddress || 'unknown';
  const shouldSkip = typeof skip === 'function' ? skip : () => false;

  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of hits.entries()) {
      if (!value || value.resetAt <= now) hits.delete(key);
    }
  }, Math.min(ttl, 60 * 1000)).unref?.();

  return function rateLimiter(req, res, next) {
    if (shouldSkip(req)) return next();
    const now = Date.now();
    const key = getKey(req);
    const current = hits.get(key);
    let bucket = current;
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + ttl };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, limit - bucket.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
      return res.status(429).json({
        error: 'Previše zahteva. Pokušaj ponovo malo kasnije.',
        requestId: req.requestId,
      });
    }
    next();
  };
}

module.exports = { setSecurityHeaders, attachRequestId, createMemoryRateLimiter };
