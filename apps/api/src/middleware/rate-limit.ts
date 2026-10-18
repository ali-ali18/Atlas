import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";

/** Fixed window per peer address. Reverse proxies should preserve the peer boundary. */
export function rateLimitByIp(maxRequests: number, windowMs: number): MiddlewareHandler {
	const buckets = new Map<string, { count: number; resetAt: number }>();
	let nextCleanup = Date.now() + windowMs;

	return async (c, next) => {
		const now = Date.now();
		if (now >= nextCleanup) {
			for (const [address, bucket] of buckets) {
				if (bucket.resetAt <= now) buckets.delete(address);
			}
			nextCleanup = now + windowMs;
		}
		const address = getConnInfo(c).remote.address ?? "unknown";
		let bucket = buckets.get(address);
		if (!bucket || bucket.resetAt <= now) {
			if (!bucket && buckets.size >= 10_000) {
				return c.json({ error: "rate_limit_exceeded" }, 429);
			}
			bucket = { count: 0, resetAt: now + windowMs };
			buckets.set(address, bucket);
		}
		if (bucket.count >= maxRequests) {
			c.header("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
			return c.json({ error: "rate_limit_exceeded" }, 429);
		}
		bucket.count += 1;
		await next();
	};
}
