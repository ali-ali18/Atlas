import { describe, expect, it, vi } from "vitest";
import type { ApiAuth } from "@workspace/shared";
import { ApiOAuthError, buildAuthorizeUrl, detectPkceSupport, exchangeAuthorizationCode, newPkce, refreshAccessToken, revokeTokens } from "./oauth.js";
import { apiSecretValues } from "./secrets.js";
import { jsonResponse, publicLookup } from "./fixtures.js";

const auth: ApiAuth = {
	kind: "oauth2",
	authorizeUrl: "https://www.bling.test/Api/v3/oauth/authorize",
	tokenUrl: "https://www.bling.test/Api/v3/oauth/token",
	scopes: ["pedidos.read", "produtos.read"],
};
const secrets = { oauth: { clientId: "client-id-123456", clientSecret: "client-secret-ABCDEF", codeVerifier: "verifier-value-0123456789" } };

function fetchSeq(...responses: Array<Response | ((url: string, init: RequestInit) => Response)>) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const queue = [...responses];
	const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init ?? {} });
		const next = queue.shift() ?? new Response("{}", { status: 404 });
		return typeof next === "function" ? next(url, init ?? {}) : next;
	});
	return { deps: { fetchFn, lookupFn: publicLookup, now: () => 1_000 }, calls };
}

describe("autorização", () => {
	it("monta a URL com state, redirect exato e PKCE só quando pedido", () => {
		const url = new URL(buildAuthorizeUrl({ auth, clientId: "client-id-123456", redirectUri: "https://atlas.test/v1/mcp/oauth/callback", state: "st4te" }));
		expect(url.origin + url.pathname).toBe(auth.authorizeUrl);
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("redirect_uri")).toBe("https://atlas.test/v1/mcp/oauth/callback");
		expect(url.searchParams.get("state")).toBe("st4te");
		expect(url.searchParams.has("code_challenge")).toBe(false);
		const pkce = newPkce();
		const withPkce = new URL(buildAuthorizeUrl({ auth, clientId: "c", redirectUri: "https://atlas.test/cb", state: "s", challenge: pkce.challenge }));
		expect(withPkce.searchParams.get("code_challenge_method")).toBe("S256");
		expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
	});

	it("detecta PKCE pelos metadados do servidor e assume que não há quando falha", async () => {
		const yes = fetchSeq(jsonResponse({ code_challenge_methods_supported: ["S256"] }));
		expect(await detectPkceSupport(auth, yes.deps)).toBe(true);
		expect(yes.calls[0]!.url).toBe("https://www.bling.test/.well-known/oauth-authorization-server");
		const no = fetchSeq(new Response("nf", { status: 404 }), new Response("nf", { status: 404 }));
		expect(await detectPkceSupport(auth, no.deps)).toBe(false);
	});
});

describe("troca de código e refresh", () => {
	it("troca o código com Basic e devolve tokens com expiração", async () => {
		const { deps, calls } = fetchSeq(jsonResponse({ access_token: "access-token-001", refresh_token: "refresh-token-001", expires_in: 21600 }));
		const tokens = await exchangeAuthorizationCode({ auth, secrets, code: "the-code", redirectUri: "https://atlas.test/cb", deps });
		expect(tokens).toMatchObject({ access_token: "access-token-001", refresh_token: "refresh-token-001", expires_at: 1_000 + 21_600_000 });
		const body = String(calls[0]!.init.body);
		expect(body).toContain("grant_type=authorization_code");
		expect(body).toContain("code=the-code");
		expect(body).toContain("code_verifier=verifier-value-0123456789");
		expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
	});

	it("cai para credenciais no corpo quando o provedor recusa Basic", async () => {
		const { deps, calls } = fetchSeq(new Response('{"error":"invalid_client"}', { status: 401 }), jsonResponse({ access_token: "access-token-002", expires_in: 60 }));
		await exchangeAuthorizationCode({ auth, secrets, code: "c", redirectUri: "https://atlas.test/cb", deps });
		expect(calls).toHaveLength(2);
		expect(String(calls[1]!.init.body)).toContain("client_secret=client-secret-ABCDEF");
	});

	it("refresh mantém o refresh token antigo quando o provedor não manda outro", async () => {
		const { deps } = fetchSeq(jsonResponse({ access_token: "access-token-003", expires_in: 3600 }));
		const tokens = await refreshAccessToken({ auth, secrets: { oauth: { ...secrets.oauth, tokens: { access_token: "old-access-token", refresh_token: "keep-this-refresh" } } }, deps });
		expect(tokens.refresh_token).toBe("keep-this-refresh");
	});

	it("recusa do provedor vira erro que pede novo login, sem vazar segredo", async () => {
		const { deps } = fetchSeq(jsonResponse({ error: "invalid_grant", error_description: "bad code the-code client-secret-ABCDEF" }, { status: 400 }), jsonResponse({}, { status: 400 }));
		const error = await exchangeAuthorizationCode({ auth, secrets, code: "the-code", redirectUri: "https://atlas.test/cb", deps }).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ApiOAuthError);
		expect((error as ApiOAuthError).needsLogin).toBe(true);
		expect((error as Error).message).not.toContain("client-secret-ABCDEF");
		expect((error as Error).message).not.toContain("the-code");
	});

	it("o host do provedor também passa pelo guard SSRF", async () => {
		const evil: ApiAuth = { ...auth, tokenUrl: "https://10.0.0.5/token" };
		const { deps } = fetchSeq();
		await expect(exchangeAuthorizationCode({ auth: evil, secrets, code: "c", redirectUri: "https://atlas.test/cb", deps })).rejects.toThrow();
		expect(deps.fetchFn).not.toHaveBeenCalled();
	});
});

describe("revogação e valores sensíveis", () => {
	it("revoga só quando a spec declara o endpoint; sem ele, não chama nada", async () => {
		const withTokens = { oauth: { ...secrets.oauth, tokens: { access_token: "access-token-004", refresh_token: "refresh-token-004" } } };
		const none = fetchSeq();
		expect(await revokeTokens({ auth, secrets: withTokens, deps: none.deps })).toBe(false);
		expect(none.deps.fetchFn).not.toHaveBeenCalled();
		const declared = fetchSeq(new Response(null, { status: 200 }));
		expect(await revokeTokens({ auth: { ...auth, revokeUrl: "https://www.bling.test/oauth/revoke" }, secrets: withTokens, deps: declared.deps })).toBe(true);
		expect(String(declared.calls[0]!.init.body)).toContain("token=refresh-token-004");
	});

	it("lista tudo que precisa ser redigido (inclusive a forma codificada e o Basic)", () => {
		const values = apiSecretValues({ apiKey: "key/with+chars-12345", oauth: { ...secrets.oauth, tokens: { access_token: "access-token-005" } } });
		expect(values).toEqual(expect.arrayContaining(["key/with+chars-12345", encodeURIComponent("key/with+chars-12345"), "client-secret-ABCDEF", "access-token-005", Buffer.from("client-id-123456:client-secret-ABCDEF").toString("base64")]));
	});
});
