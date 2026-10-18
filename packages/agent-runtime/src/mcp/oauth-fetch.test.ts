import { describe, expect, it } from "vitest";
import { humanizeOAuthError, normalizingFetch } from "./oauth-fetch.js";
import { startMcpOAuth } from "./oauth-provider.js";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Imita uma Response de outro realm: mesmo formato, mas `instanceof Response` falha. */
function foreign(body: string, status: number) {
	return {
		status,
		statusText: "",
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		arrayBuffer: async () => new TextEncoder().encode(body).buffer,
	};
}

function serverFetch(register: (body: unknown) => unknown, wrap: (r: Response) => unknown = (r) => r) {
	const calls: { url: string; body?: unknown }[] = [];
	const fn = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body });
		if (url.endsWith("/mcp") && !url.includes("well-known")) {
			return wrap(new Response("authentication required", { status: 401, headers: { "www-authenticate": 'Bearer scope="a:read a:write", resource_metadata="https://srv.test/.well-known/oauth-protected-resource"' } }));
		}
		if (url.includes("oauth-protected-resource")) return wrap(json({ resource: "https://srv.test/mcp", authorization_servers: ["https://srv.test"], scopes_supported: ["a:read", "a:write"] }));
		if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
			return wrap(json({ issuer: "https://srv.test", authorization_endpoint: "https://srv.test/authorize", token_endpoint: "https://srv.test/token", registration_endpoint: "https://srv.test/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] }));
		}
		if (url.endsWith("/register")) return wrap(register(body) as Response);
		return wrap(new Response("not found", { status: 404 }));
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const run = (fetchFn: typeof fetch, secrets = {}) =>
	startMcpOAuth({ record: { id: "c1", url: "https://srv.test/mcp" }, secrets, client: {}, state: "st", redirectUrl: "https://agent.example.com/v1/mcp/oauth/callback", persist: async () => {}, fetchFn });

describe("normalizingFetch", () => {
	it("converte respostas de outro realm em Response global", async () => {
		const res = await normalizingFetch((async () => foreign('{"error":"x"}', 400)) as never)("https://x.test");
		expect(res instanceof Response).toBe(true);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "x" });
	});
});

describe("startMcpOAuth", () => {
	it("registra o cliente público com PKCE, escopos do servidor e redirect exato", async () => {
		const { fn, calls } = serverFetch((b) => json({ ...(b as object), client_id: "cid" }, 201));
		const start = await run(fn);
		expect(start.status).toBe("redirect");
		const reg = calls.find((c) => c.url.endsWith("/register"))?.body as Record<string, unknown>;
		expect(reg).toMatchObject({
			client_name: "Atlas",
			redirect_uris: ["https://agent.example.com/v1/mcp/oauth/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: "a:read a:write",
		});
		const url = new URL((start as { authorizationUrl: string }).authorizationUrl);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("resource")).toBe("https://srv.test/mcp");
		expect(url.searchParams.get("scope")).toBe("a:read a:write");
		expect(url.searchParams.get("client_id")).toBe("cid");
	});

	it("não vaza [object Response] quando o fetch devolve Response de outro realm", async () => {
		const { fn } = serverFetch(() => json({ error: "invalid_client_metadata", error_description: "bad" }, 400));
		const foreignFn = (async (input: string | URL, init?: RequestInit) => {
			const r = (await fn(input, init)) as Response;
			return foreign(await r.text(), r.status);
		}) as unknown as typeof fetch;
		const err = await run(foreignFn).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).not.toContain("[object");
		expect((err as Error).message).toContain("invalid_client_metadata");
	});
});

describe("humanizeOAuthError", () => {
	it("redirect_uri recusado (caso Bling): explica a allowlist do servidor", async () => {
		const { fn } = serverFetch(() => json({ error: "invalid_redirect_uri", error_description: 'invalid redirect_uri "https://agent.example.com/v1/mcp/oauth/callback": must be https on an allowed client host' }, 400));
		const err = (await run(fn).catch((e: Error) => e)) as Error;
		expect(err.message).toContain("agent.example.com");
		expect(err.message).toContain("liberados previamente pelo provedor");
		expect(err.message).not.toContain("[object");
	});
	it("nunca mostra [object Response]", () => {
		const m = humanizeOAuthError(new Error('Invalid OAuth error response: SyntaxError: Unexpected token \'o\', "[object Response]" is not valid JSON. Raw body: [object Response]'));
		expect(m).not.toContain("[object");
	});
	it("explica limite de tentativas e registro dinâmico", () => {
		expect(humanizeOAuthError(new Error("too many registration attempts"))).toContain("limitou");
		expect(humanizeOAuthError(new Error("Incompatible auth server: does not support dynamic client registration"))).toContain("registro dinâmico");
	});
});
