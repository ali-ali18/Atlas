import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { providerErrorMessage } from "@workspace/shared";
import { verifySiwcIdToken, tokenRequest } from "./siwc-protocol.js";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const now = 1_800_000_000_000;
function jwt(
	claims: Record<string, unknown> = {},
	header: Record<string, unknown> = {},
) {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	const prefix = `${part({ alg: "RS256", kid: "fixture-key", ...header })}.${part({ iss: "https://auth.openai.com", aud: "oaiapp_fixture", sub: "fixture-sub", nonce: "fixture-nonce", exp: now / 1000 + 3600, email: "account@example.com", ...claims })}`;
	return `${prefix}.${sign("RSA-SHA256", Buffer.from(prefix), privateKey).toString("base64url")}`;
}
const jwks = () =>
	vi.fn<typeof fetch>(
		async () =>
			new Response(
				JSON.stringify({
					keys: [
						{
							...publicKey.export({ format: "jwk" }),
							kid: "fixture-key",
							alg: "RS256",
							use: "sig",
						},
					],
				}),
			),
	);
describe("OIDC assinatura e claims", () => {
	it("troca de token não segue redirects que poderiam reenviar refresh token", async () => {
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			expect(init?.redirect).toBe("error");
			return new Response(
				JSON.stringify({
					access_token: "fixture-access",
					refresh_token: "fixture-refresh",
					scope: "chatgpt.tokens.use.direct",
					expires_in: 3600,
				}),
			);
		});
		await tokenRequest(
			fetcher,
			new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: "fixture-refresh",
			}),
		);
	});

	it("valida assinatura JWKS fixa, issuer/aud/nonce/exp e subject", async () => {
		await expect(
			verifySiwcIdToken(jwt(), "oaiapp_fixture", "fixture-nonce", jwks(), now),
		).resolves.toEqual({ sub: "fixture-sub", email: "account@example.com" });
	});
	it.each([
		{ iss: "https://attacker.example" },
		{ aud: "oaiapp_other" },
		{ nonce: "cross-nonce" },
		{ exp: now / 1000 },
		{ nbf: now / 1000 + 3600 },
		{ sub: "" },
		{ aud: ["oaiapp_fixture", "other"] },
	])("recusa claims cruzados %j", async (claims) => {
		await expect(
			verifySiwcIdToken(
				jwt(claims),
				"oaiapp_fixture",
				"fixture-nonce",
				jwks(),
				now,
			),
		).rejects.toMatchObject({ code: "invalid_id_token" });
	});
	it("recusa assinatura alterada, alg none, keyid desconhecido sem revelar JWT", async () => {
		for (const token of [
			jwt().slice(0, -30) + "x".repeat(30),
			jwt({}, { alg: "none" }),
			jwt({}, { kid: "other" }),
		]) {
			await expect(
				verifySiwcIdToken(
					token,
					"oaiapp_fixture",
					"fixture-nonce",
					jwks(),
					now,
				),
			).rejects.toThrow("Não foi possível");
		}
	});
	it("corpo inválido e segredos remotos nunca aparecem no erro", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response("fixture-refresh-private-token", { status: 502 }),
		);
		await expect(
			tokenRequest(fetcher, new URLSearchParams()),
		).rejects.toMatchObject({ code: "token_unavailable" });
	});
});

describe("resposta do endpoint de token", () => {
	const reply = (body: unknown) =>
		vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)));
	const exchange = (body: unknown, log = vi.fn()) =>
		tokenRequest(reply(body), new URLSearchParams(), log);
	const base = { access_token: "fixture-access" };

	it("resposta completa no formato real (earliest_refresh_at numérico, Bearer)", async () => {
		const id = jwt();
		const result = await exchange({
			access_token: "fixture-access",
			refresh_token: "fixture-refresh",
			id_token: id,
			token_type: "Bearer",
			expires_in: 3600,
			scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
			earliest_refresh_at: 1_800_000_000,
		});
		expect(result).toMatchObject({
			access_token: "fixture-access",
			refresh_token: "fixture-refresh",
			id_token: id,
			expires_in: 3600,
			earliestRefreshAt: 1_800_000_000_000,
		});
	});
	it("só access_token: expires_in 3600, escopo pedido assumido, sem refresh", async () => {
		const result = await exchange(base);
		expect(result.expires_in).toBe(3600);
		expect(result.scope.split(" ")).toContain("chatgpt.tokens.use.direct");
		expect(result.refresh_token).toBeUndefined();
	});
	it.each([
		["3600", 3600],
		[7200, 7200],
		[5, 60],
		[10_000_000, 30 * 86_400],
		["lixo", 3600],
	])("expires_in %j vira %d", async (expires_in, expected) => {
		expect((await exchange({ ...base, expires_in })).expires_in).toBe(expected);
	});
	it("token_type bearer em qualquer caixa; outro tipo é recusado pelo campo", async () => {
		await expect(exchange({ ...base, token_type: "BEARER" })).resolves.toBeTruthy();
		await expect(exchange({ ...base, token_type: "mac" })).rejects.toMatchObject({
			code: "invalid_token_response:token_type",
		});
	});
	it("scope sem o escopo do plano dá erro específico", async () => {
		await expect(exchange({ ...base, scope: "openid email" })).rejects.toMatchObject({
			code: "invalid_token_response:scope_missing_plan",
		});
		expect(providerErrorMessage("invalid_token_response:scope_missing_plan")).toBe(
			"A conta não concedeu o uso do plano. Conecte de novo e aceite o acesso.",
		);
	});
	it.each([
		["access_token", {}],
		["access_token", { access_token: "" }],
		["access_token", { access_token: 12 }],
		["refresh_token", { ...base, refresh_token: 5 }],
		["id_token", { ...base, id_token: 5 }],
		["id_token_size", { ...base, id_token: "x".repeat(16_385) }],
		["scope", { ...base, scope: 5 }],
	])("recusa com o campo %s", async (field, body) => {
		await expect(exchange(body)).rejects.toMatchObject({
			code: `invalid_token_response:${field}`,
		});
	});
	it("earliest_refresh_at ilegível é ignorado; ISO e string numérica são lidos", async () => {
		expect(
			(await exchange({ ...base, earliest_refresh_at: "amanhã cedo" })).earliestRefreshAt,
		).toBeUndefined();
		expect(
			(await exchange({ ...base, earliest_refresh_at: "2027-01-15T08:00:00Z" })).earliestRefreshAt,
		).toBe(Date.parse("2027-01-15T08:00:00Z"));
		expect(
			(await exchange({ ...base, earliest_refresh_at: "1800000000" })).earliestRefreshAt,
		).toBe(1_800_000_000_000);
	});
	it("log e erro trazem só nomes e tipos, nunca valores de token", async () => {
		const log = vi.fn();
		const error = await exchange(
			{
				access_token: "",
				refresh_token: "fixture-refresh-secret",
				id_token: "fixture-id-secret",
			},
			log,
		).catch((e) => e);
		expect(error.code).toBe("invalid_token_response:access_token");
		const dump = JSON.stringify([log.mock.calls, error.code, error.message]);
		expect(dump).not.toContain("fixture-refresh-secret");
		expect(dump).not.toContain("fixture-id-secret");
		expect(log.mock.calls[0]![1]).toMatchObject({
			field: "access_token",
			refresh_token: "string",
		});
	});
});
