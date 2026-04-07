const hits = new Map<string, { count: number; reset: number }>();

export function rateLimit(maxPerMinute: number) {
  return async function (c: any, next: any) {
    const ip = c.req.header("cf-connecting-ip") 
      ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() 
      ?? "unknown";
    const now = Date.now();
    const window = 60_000;

    const entry = hits.get(ip);
    if (!entry || now > entry.reset) {
      hits.set(ip, { count: 1, reset: now + window });
    } else {
      entry.count++;
      if (entry.count > maxPerMinute) {
        return c.json({ error: "Too many requests" }, 429);
      }
    }

    await next();
  };
}
