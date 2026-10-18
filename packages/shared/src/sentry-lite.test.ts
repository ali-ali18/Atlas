import { describe, expect, it, vi } from "vitest";
import { buildLiteEvent, captureLite, parseSentryDsn } from "./sentry-lite.js";

describe("sentry-lite", () => {
	it("lê o DSN e recusa lixo/vazio", () => {
		expect(parseSentryDsn("https://abc123@o1.ingest.sentry.io/4507")).toEqual({ publicKey: "abc123", endpoint: "https://o1.ingest.sentry.io/api/4507/envelope/" });
		expect(parseSentryDsn("")).toBeNull();
		expect(parseSentryDsn(undefined)).toBeNull();
		expect(parseSentryDsn("not a url")).toBeNull();
		expect(parseSentryDsn("https://o1.ingest.sentry.io/4507")).toBeNull();
	});

	it("sem DSN não envia nada", () => {
		const fetchImpl = vi.fn();
		expect(captureLite({ error: new Error("x"), service: "web-server", env: {} }, fetchImpl as never)).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("com DSN envia o envelope com release = commit e sem segredos", () => {
		const fetchImpl = vi.fn().mockResolvedValue({});
		const ok = captureLite(
			{ error: new Error("falhou ?secret=hunter2 com Bearer abcdefghijklmnop"), service: "web-server", url: "https://app/x?token=zzz", env: { SENTRY_DSN: "https://k@o1.ingest.sentry.io/9", ATLAS_COMMIT: "abc1234" } },
			fetchImpl as never,
		);
		expect(ok).toBe(true);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("https://o1.ingest.sentry.io/api/9/envelope/?sentry_version=7&sentry_key=k");
		const body = (init as { body: string }).body;
		expect(body).toContain('"release":"abc1234"');
		expect(body).not.toMatch(/hunter2|abcdefghijklmnop|token=zzz/);
	});

	it("evento tem tags de serviço e passa pelo scrub", () => {
		const event = buildLiteEvent({ error: "oops sk-or-v1-abcdefghijklmnop123", service: "web-client", env: { NODE_ENV: "production" } }, new Date(0), "id1");
		expect(event.tags).toMatchObject({ service: "web-client" });
		expect(JSON.stringify(event)).not.toContain("abcdefghijklmnop123");
	});
});
