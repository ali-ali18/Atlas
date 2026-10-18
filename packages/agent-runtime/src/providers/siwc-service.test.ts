import { describe, expect, it, vi } from "vitest";
import { createChatgptAuthService } from "./siwc-service.js";
import { openSecrets, sealSecrets } from "../secrets/secret-box.js";
import type {
	SiwcSecrets,
	SiwcStore,
	ProviderConnectionRecord,
	ProviderConnectionUpdate,
} from "./siwc-store.js";
const key = Buffer.alloc(32, 9);
const env = {
	ATLAS_OWNER_EMAIL: "owner@example.com",
	ATLAS_PROVIDER_CHATGPT_ENABLED: "true",
	CONNECTOR_ENCRYPTION_KEY: key.toString("base64"),
};
const now = 1_800_000_000_000;
function fixture() {
	const rows = new Map<string, ProviderConnectionRecord>();
	let tail: Promise<unknown> = Promise.resolve();
	const store: SiwcStore = {
		get: async (id) => rows.get(id) ?? null,
		ownerEmail: async (id) =>
			id === "a" ? "owner@example.com" : "other@example.com",
		findState: async (hash) =>
			[...rows.values()].find((row) => row.oauthStateHash === hash) ?? null,
		lock: async (id, operation) => {
			const previous = tail;
			let release!: () => void;
			tail = new Promise((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				if (!rows.has(id))
					rows.set(id, {
						id: `provider-${id}`,
						userId: id,
						provider: "chatgpt",
						status: "disconnected",
						secretsEnc: null,
						oauthStateHash: null,
						accountEmail: null,
						scopes: [],
						accessExpiresAt: null,
						lastError: null,
						lastLimitAt: null,
						createdAt: new Date(now),
						updatedAt: new Date(now),
					});
				return await operation({
					get: async () => rows.get(id) ?? null,
					update: async (data) => {
						const row = rows.get(id)!;
						// Mock only applies fields written by the service (Prisma atomic scalar updates aren't used here).
						for (const [field, value] of Object.entries(data))
							Reflect.set(row, field, value);
						row.updatedAt = new Date(row.updatedAt.getTime() + 1);
					},
				});
			} finally {
				release();
			}
		},
	};
	const tokens = (
		access = "fixture-access-new",
		refresh = "fixture-refresh-new",
	) => ({
		access_token: access,
		refresh_token: refresh,
		id_token: "fixture-id-token",
		scope: "openid chatgpt.tokens.use.direct",
		expires_in: 3600,
	});
	const fetcher = vi.fn<typeof fetch>(
		async () => new Response(JSON.stringify(tokens())),
	);
	const deps = {
		store,
		env,
		fetch: fetcher,
		now: () => now,
		verifyIdToken: async () => ({
			sub: "fixture-sub",
			email: "account@example.com",
		}),
	};
	const service = createChatgptAuthService(deps);
	async function login() {
		const url = new URL((await service.connect("a")).authorizeUrl);
		await service.callback(
			new URLSearchParams({
				state: url.searchParams.get("state")!,
				code: "fixture-code",
				client_id: "oaiapp_fixture",
			}),
		);
		fetcher.mockClear();
		return url;
	}
	function expire() {
		rows.get("a")!.accessExpiresAt = new Date(now + 30_000);
	}
	function saved() {
		return openSecrets<SiwcSecrets>(rows.get("a")?.secretsEnc, key);
	}
	return { rows, store, fetcher, service, deps, tokens, login, expire, saved };
}
describe("SIWC login e cofre", () => {
	it("usa client dinâmico, PKCE e state hash; callback uma vez sem cookie", async () => {
		const f = fixture(),
			url = await f.login();
		const row = f.rows.get("a")!;
		expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
		expect(row.oauthStateHash).toBeNull();
		expect(row.secretsEnc).not.toContain("fixture-access");
		expect(f.saved().clientId).toBe("oaiapp_fixture");
		expect(f.saved().login).toBeUndefined();
		expect(await f.service.status("a")).toMatchObject({
			status: "connected",
			accountEmail: "account@example.com",
		});
		await expect(
			f.service.callback(
				new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "fixture-code",
				}),
			),
		).rejects.toMatchObject({ code: "invalid_state" });
	});
	it("recusa B em status/connect/disconnect/access e flag off sem acessar A", async () => {
		const f = fixture();
		await f.login();
		const before = f.rows.get("a")!.secretsEnc;
		for (const action of [
			() => f.service.status("b"),
			() => f.service.connect("b"),
			() => f.service.disconnect("b"),
			() => f.service.getAccessToken("b"),
			() => f.service.markNeedsLogin("b"),
		])
			await expect(action()).rejects.toMatchObject({ status: 404 });
		expect(f.rows.get("a")!.secretsEnc).toBe(before);
		const off = createChatgptAuthService({
			...f.deps,
			env: { ...env, ATLAS_PROVIDER_CHATGPT_ENABLED: "false" },
		});
		await expect(off.status("a")).rejects.toMatchObject({ status: 404 });
		await expect(
			createChatgptAuthService({
				...f.deps,
				env: { ...env, CONNECTOR_ENCRYPTION_KEY: "" },
			}).connect("a"),
		).rejects.toMatchObject({ status: 503 });
	});
	it("state errado ou expirado não troca code nem salva token", async () => {
		const f = fixture();
		const url = new URL((await f.service.connect("a")).authorizeUrl);
		await expect(
			f.service.callback(new URLSearchParams()),
		).rejects.toMatchObject({ code: "invalid_state" });
		await expect(
			f.service.callback(new URLSearchParams({ state: "x".repeat(43) })),
		).rejects.toMatchObject({ code: "invalid_state" });
		const late = createChatgptAuthService({
			...f.deps,
			now: () => now + 15 * 60_000 + 1,
		});
		await expect(
			late.callback(new URLSearchParams(url.searchParams)),
		).rejects.toMatchObject({ code: "invalid_state" });
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("erro de nonce ou scope consome state e limpa tokens, sem descrição remota", async () => {
		for (const missingScope of [false, true]) {
			const f = fixture();
			const url = new URL((await f.service.connect("a")).authorizeUrl);
			const service = createChatgptAuthService({
				...f.deps,
				verifyIdToken: async () => {
					throw new Error("fixture-id-token leaked");
				},
			});
			if (missingScope)
				f.fetcher.mockResolvedValue(
					new Response(JSON.stringify({ ...f.tokens(), scope: "openid" })),
				);
			const params = new URLSearchParams({
				state: url.searchParams.get("state")!,
				code: "fixture-code",
				client_id: "oaiapp_fixture",
			});
			await expect(service.callback(params)).rejects.toThrow(
				"Não foi possível",
			);
			expect(f.rows.get("a")!.status).toBe("needs_login");
			expect(f.rows.get("a")!.oauthStateHash).toBeNull();
			expect(f.saved().accessToken).toBeUndefined();
			await expect(service.callback(params)).rejects.toMatchObject({
				code: "invalid_state",
			});
		}
	});
	it("disconnect mantém host/client/subject, remove tokens e state, tolera revogação fora", async () => {
		const f = fixture();
		await f.login();
		const saved = f.saved();
		f.fetcher.mockRejectedValue(new Error("fixture-refresh-new"));
		expect(await f.service.disconnect("a")).toEqual({
			revocationConfirmed: false,
		});
		expect(f.saved()).toEqual({
			hostId: saved.hostId,
			clientId: saved.clientId,
			subject: saved.subject,
		});
		expect((await f.service.status("a")).status).toBe("disconnected");
		const url = new URL((await f.service.connect("a")).authorizeUrl);
		expect(url.searchParams.get("client_id")).toBe(saved.clientId);
		expect(url.searchParams.get("ext_agent_host_id")).toBe(saved.hostId);
	});
});
describe("claim durável do callback", () => {
	it("client e state são persistidos antes de fetch e callback não regrava depois de disconnect", async () => {
		const f = fixture(),
			url = new URL((await f.service.connect("a")).authorizeUrl);
		f.fetcher.mockImplementationOnce(async () => {
			expect(f.rows.get("a")!.oauthStateHash).toBeNull();
			expect(f.saved().clientId).toBe("oaiapp_fixture");
			await f.service.disconnect("a");
			return new Response(JSON.stringify(f.tokens()));
		});
		await expect(
			f.service.callback(
				new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "fixture-code",
					client_id: "oaiapp_fixture",
				}),
			),
		).rejects.toMatchObject({ code: "authorization_cancelled" });
		expect(f.rows.get("a")!.status).toBe("disconnected");
		expect(f.saved().accessToken).toBeUndefined();
	});
	it("concurrent reconnect preserva state novo contra acabamento antigo", async () => {
		const f = fixture(),
			url = new URL((await f.service.connect("a")).authorizeUrl);
		let nextState: string | null = null;
		f.fetcher.mockImplementationOnce(async () => {
			const next = new URL((await f.service.connect("a")).authorizeUrl);
			nextState = next.searchParams.get("state");
			return new Response(JSON.stringify(f.tokens()));
		});
		await expect(
			f.service.callback(
				new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "fixture-code",
					client_id: "oaiapp_fixture",
				}),
			),
		).rejects.toMatchObject({ code: "authorization_cancelled" });
		expect(nextState).not.toBe(url.searchParams.get("state"));
		expect(f.rows.get("a")!.oauthStateHash).not.toBeNull();
		expect(f.saved().login).toBeDefined();
	});
});
describe("refresh rotativo", () => {
	it("N chamadas em processo fazem um refresh e par novo é salvo", async () => {
		const f = fixture();
		await f.login();
		f.expire();
		const tokens = await Promise.all(
			Array.from({ length: 10 }, () => f.service.getAccessToken("a")),
		);
		expect(new Set(tokens)).toEqual(new Set(["fixture-access-new"]));
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(f.saved().refreshToken).toBe("fixture-refresh-new");
	});
	it("dois processos disputam lock e segundo usa access novo sem reusar refresh", async () => {
		const f = fixture();
		await f.login();
		f.expire();
		const second = createChatgptAuthService(f.deps);
		await Promise.all([
			f.service.getAccessToken("a"),
			second.getAccessToken("a"),
		]);
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
	it.each([
		"invalid_grant",
		"invalid_refresh_token",
		"token_expired",
		"refresh_token_reused",
	])("fatal %s comita needs_login sem tokens", async (code) => {
		const f = fixture();
		await f.login();
		f.expire();
		f.fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: code,
					error_description: "fixture-refresh-new fixture-access-new",
				}),
				{ status: 400 },
			),
		);
		await expect(f.service.getAccessToken("a")).rejects.toMatchObject({
			code: "needs_login",
		});
		expect(f.rows.get("a")!.status).toBe("needs_login");
		expect(f.saved().accessToken).toBeUndefined();
		expect(f.saved().refreshToken).toBeUndefined();
		expect(f.saved().clientId).toBe("oaiapp_fixture");
		expect(f.rows.get("a")!.lastError).toBe("needs_login");
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
	it("falha transitória preserva status e segredo; erro não inclui provider body", async () => {
		const f = fixture();
		await f.login();
		f.expire();
		const before = f.rows.get("a")!.secretsEnc;
		f.fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: "fixture-refresh-new",
					error_description: "fixture-access-new",
				}),
				{ status: 503 },
			),
		);
		await expect(f.service.getAccessToken("a")).rejects.toMatchObject({
			code: "token_unavailable",
		});
		expect(f.rows.get("a")!.status).toBe("connected");
		expect(f.rows.get("a")!.secretsEnc).toBe(before);
	});
	it("troca inicial sem refresh_token conecta, usa o access e pede login ao expirar", async () => {
		const f = fixture();
		f.fetcher.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({ access_token: "fixture-access-only", id_token: "fixture-id-token" }),
				),
		);
		await f.login();
		expect(f.saved().refreshToken).toBeUndefined();
		expect(await f.service.status("a")).toMatchObject({ status: "connected" });
		await expect(f.service.getAccessToken("a")).resolves.toBe("fixture-access-only");
		f.expire();
		await expect(f.service.getAccessToken("a")).resolves.toBe("fixture-access-only");
		f.rows.get("a")!.accessExpiresAt = new Date(now - 1);
		await expect(f.service.getAccessToken("a")).rejects.toMatchObject({ code: "needs_login" });
		expect(f.rows.get("a")!.status).toBe("needs_login");
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("resposta sem escopo do plano grava o código específico em lastError", async () => {
		const f = fixture();
		const url = new URL((await f.service.connect("a")).authorizeUrl);
		f.fetcher.mockResolvedValue(
			new Response(JSON.stringify({ ...f.tokens(), scope: "openid" })),
		);
		await expect(
			f.service.callback(
				new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "fixture-code",
					client_id: "oaiapp_fixture",
				}),
			),
		).rejects.toMatchObject({ code: "invalid_token_response:scope_missing_plan" });
		expect(f.rows.get("a")!.lastError).toBe("invalid_token_response:scope_missing_plan");
		expect(await f.service.status("a")).toMatchObject({
			status: "needs_login",
			lastError: "invalid_token_response:scope_missing_plan",
		});
	});
	it("earliest_refresh_at respeitado e access ainda válido usado sem refresh", async () => {
		const f = fixture();
		await f.login();
		f.expire();
		f.rows.get("a")!.secretsEnc = sealSecrets(
			{ ...f.saved(), earliestRefreshAt: now + 60_000 },
			key,
		);
		await expect(f.service.getAccessToken("a")).resolves.toBe(
			"fixture-access-new",
		);
		expect(f.fetcher).not.toHaveBeenCalled();
		await expect(
			f.service.getAccessToken("a", { force: true }),
		).rejects.toMatchObject({ code: "refresh_not_available" });
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("401 força refresh mas chamada com token anterior não renova o par de outro processo", async () => {
		const f = fixture();
		await f.login();
		f.fetcher.mockResolvedValue(
			new Response(
				JSON.stringify(
					f.tokens("fixture-access-rotated", "fixture-refresh-rotated"),
				),
			),
		);
		await expect(
			f.service.getAccessToken("a", {
				force: true,
				previousAccessToken: "fixture-access-new",
			}),
		).resolves.toBe("fixture-access-rotated");
		await expect(
			f.service.getAccessToken("a", {
				force: true,
				previousAccessToken: "fixture-access-new",
			}),
		).resolves.toBe("fixture-access-rotated");
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
});
describe("porta do plano por usuário (conta > env)", () => {
	const off = { ...env, ATLAS_PROVIDER_CHATGPT_ENABLED: "false" };
	const userGate = (enabled: boolean) => async () => ({ enabled, source: "user" as const });

	it("o dono liga pela conta mesmo com o env desligado; sem gate o env decide", async () => {
		const f = fixture();
		const byAccount = createChatgptAuthService({ ...f.deps, env: off, gate: userGate(true) });
		expect((await byAccount.connect("a")).authorizeUrl).toContain("state=");
		expect(await byAccount.status("a")).toMatchObject({ status: "disconnected" });
		await expect(
			createChatgptAuthService({ ...f.deps, env: off }).status("a"),
		).rejects.toMatchObject({ status: 404 });
	});

	it("ligado na conta, quem não é o dono continua recebendo 404", async () => {
		const f = fixture();
		const service = createChatgptAuthService({ ...f.deps, env: off, gate: userGate(true) });
		await expect(service.connect("b")).rejects.toMatchObject({ status: 404 });
		expect(f.rows.has("b")).toBe(false);
	});

	it("desligar o plano mantém a conexão e os tokens, mas bloqueia qualquer uso", async () => {
		const f = fixture();
		await f.login();
		const before = f.rows.get("a")!.secretsEnc;
		const disabled = createChatgptAuthService({ ...f.deps, gate: userGate(false) });
		for (const action of [
			() => disabled.status("a"),
			() => disabled.connect("a"),
			() => disabled.getAccessToken("a"),
		])
			await expect(action()).rejects.toMatchObject({ status: 404 });
		expect(f.rows.get("a")!.status).toBe("connected");
		expect(f.rows.get("a")!.secretsEnc).toBe(before);
		expect(f.saved().accessToken).toBe("fixture-access-new");
	});

	it("assertOwner: dono passa com o plano ligado ou não; outro usuário recebe 404 nos dois casos", async () => {
		const f = fixture();
		for (const enabled of [true, false]) {
			const service = createChatgptAuthService({ ...f.deps, gate: userGate(enabled) });
			await expect(service.assertOwner("a")).resolves.toBeUndefined();
			await expect(service.assertOwner("b")).rejects.toMatchObject({ status: 404 });
		}
	});

	it("desconectar da conta remove os tokens mesmo com o plano desligado", async () => {
		const f = fixture();
		await f.login();
		const disabled = createChatgptAuthService({ ...f.deps, gate: userGate(false) });
		f.fetcher.mockRejectedValue(new Error("sem rede"));
		expect(await disabled.disconnect("a")).toEqual({ revocationConfirmed: false });
		expect(f.rows.get("a")!.status).toBe("disconnected");
		expect(f.saved().accessToken).toBeUndefined();
		expect(f.saved().refreshToken).toBeUndefined();
		// Outro usuário não desconecta a conta do dono, nem com o plano desligado.
		await expect(disabled.disconnect("b")).rejects.toMatchObject({ status: 404 });
	});

	it("callback valida state, usuário e plano ligado: desligado depois do connect não grava nada", async () => {
		const f = fixture();
		const url = new URL((await f.service.connect("a")).authorizeUrl);
		const before = f.rows.get("a")!.secretsEnc;
		const disabled = createChatgptAuthService({ ...f.deps, gate: userGate(false) });
		await expect(
			disabled.callback(
				new URLSearchParams({
					state: url.searchParams.get("state")!,
					code: "fixture-code",
					client_id: "oaiapp_fixture",
				}),
			),
		).rejects.toMatchObject({ status: 404 });
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(f.rows.get("a")!.secretsEnc).toBe(before);
		expect(f.rows.get("a")!.status).not.toBe("connected");
		// State inválido segue recusado antes de qualquer consulta de plano.
		await expect(
			createChatgptAuthService({ ...f.deps, gate: userGate(false) }).callback(new URLSearchParams({ state: "x".repeat(43) })),
		).rejects.toMatchObject({ code: "invalid_state" });
	});

	it("o gate recebe o userId do state, não um valor do callback", async () => {
		const f = fixture();
		const url = new URL((await f.service.connect("a")).authorizeUrl);
		const asked: string[] = [];
		const service = createChatgptAuthService({
			...f.deps,
			gate: async (id) => {
				asked.push(id);
				return { enabled: true, source: "user" };
			},
		});
		await service.callback(
			new URLSearchParams({
				state: url.searchParams.get("state")!,
				code: "fixture-code",
				client_id: "oaiapp_fixture",
				userId: "b",
			}),
		);
		expect(asked).toEqual(["a"]);
	});
});


describe("login por código de dispositivo (Codex)", () => {
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const codexTokens = (refresh = "codex-refresh-1") => ({
		access_token: "codex-access-1",
		refresh_token: refresh,
		id_token: "fixture-id-token",
		expires_in: 3600,
	});
	function setup() {
		const f = fixture();
		let clock = now;
		const calls: Array<{ url: string; body: string }> = [];
		let tokenPoll: () => Response = () => json({}, 403);
		let exchange: () => Response = () => json(codexTokens());
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			calls.push({ url, body: String(init?.body ?? "") });
			if (url.endsWith("/deviceauth/usercode"))
				return json({ device_auth_id: "dev-1", user_code: "ABCD-12345", interval: "5" });
			if (url.endsWith("/deviceauth/token")) return tokenPoll();
			if (url === "https://auth.openai.com/oauth/token") return exchange();
			throw new Error(`unexpected ${url}`);
		});
		const service = createChatgptAuthService({
			...f.deps,
			fetch: fetcher,
			now: () => clock,
			verifyIdToken: async () => ({ sub: "fixture-sub", email: "account@example.com", accountId: "acct-123" }),
		});
		return {
			...f,
			service,
			calls,
			fetcher,
			advance: (ms: number) => (clock += ms),
			setPoll: (fn: () => Response) => (tokenPoll = fn),
			setExchange: (fn: () => Response) => (exchange = fn),
		};
	}
	it("start devolve o código e guarda o device_auth_id só no cofre", async () => {
		const f = setup();
		const started = await f.service.startDeviceLogin("a");
		expect(started).toMatchObject({
			userCode: "ABCD-12345",
			verificationUrl: "https://auth.openai.com/codex/device",
			intervalSeconds: 5,
		});
		expect(JSON.stringify(started)).not.toContain("dev-1");
		expect(JSON.parse(f.calls[0]!.body)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
		expect(f.saved().device?.deviceAuthId).toBe("dev-1");
		expect(f.rows.get("a")!.secretsEnc).not.toContain("dev-1");
	});
	it("pendente (403/404) segue aguardando e respeita o intervalo", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		expect(await f.service.pollDeviceLogin("a")).toMatchObject({ status: "pending" });
		const before = f.calls.length;
		expect(await f.service.pollDeviceLogin("a")).toMatchObject({ status: "pending" });
		expect(f.calls.length).toBe(before);
		f.advance(5_000);
		f.setPoll(() => json({}, 404));
		expect(await f.service.pollDeviceLogin("a")).toMatchObject({ status: "pending" });
		expect(f.calls.length).toBe(before + 1);
	});
	it("sucesso troca o código, conecta no fluxo codex e expõe a conta", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		f.setPoll(() => json({ authorization_code: "auth-code", code_verifier: "ver", code_challenge: "chal" }));
		expect(await f.service.pollDeviceLogin("a")).toEqual({ status: "connected" });
		const exchange = f.calls.find((call) => call.url === "https://auth.openai.com/oauth/token")!;
		const form = new URLSearchParams(exchange.body);
		expect(Object.fromEntries(form)).toEqual({
			grant_type: "authorization_code",
			code: "auth-code",
			redirect_uri: "https://auth.openai.com/deviceauth/callback",
			client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
			code_verifier: "ver",
		});
		expect(f.saved()).toMatchObject({ flow: "codex", accountId: "acct-123", accessToken: "codex-access-1", refreshToken: "codex-refresh-1" });
		expect(f.saved().device).toBeUndefined();
		expect(await f.service.status("a")).toMatchObject({ status: "connected", accountEmail: "account@example.com" });
		expect(await f.service.getAccountId("a")).toBe("acct-123");
		expect(await f.service.getAccessToken("a")).toBe("codex-access-1");
		expect(await f.service.pollDeviceLogin("a")).toEqual({ status: "none" });
	});
	it("refresh do fluxo codex usa JSON no endpoint do Codex e mantém a conta", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		f.setPoll(() => json({ authorization_code: "c", code_verifier: "v", code_challenge: "x" }));
		await f.service.pollDeviceLogin("a");
		f.calls.length = 0;
		f.setExchange(() => json({ access_token: "codex-access-2", refresh_token: "codex-refresh-2", expires_in: 3600 }));
		f.advance(3_500_000);
		expect(await f.service.getAccessToken("a")).toBe("codex-access-2");
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]!.url).toBe("https://auth.openai.com/oauth/token");
		expect(JSON.parse(f.calls[0]!.body)).toEqual({
			grant_type: "refresh_token",
			client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
			refresh_token: "codex-refresh-1",
		});
		expect(f.saved()).toMatchObject({ flow: "codex", accountId: "acct-123", accessToken: "codex-access-2", refreshToken: "codex-refresh-2" });
		expect(await f.service.status("a")).toMatchObject({ status: "connected" });
	});
	it("expirado: encerra o fluxo e pede novo código", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		f.advance(15 * 60_000 + 1);
		expect(await f.service.pollDeviceLogin("a")).toEqual({ status: "expired" });
		expect(f.saved().device).toBeUndefined();
		expect(await f.service.pollDeviceLogin("a")).toEqual({ status: "none" });
	});
	it("falha na troca limpa o fluxo sem vazar tokens", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		f.setPoll(() => json({ authorization_code: "c", code_verifier: "v", code_challenge: "x" }));
		f.setExchange(() => json({ error: "invalid_grant", error_description: "secret-detail" }, 400));
		await expect(f.service.pollDeviceLogin("a")).rejects.toMatchObject({ code: "invalid_grant" });
		expect(f.saved().device).toBeUndefined();
		expect((await f.service.status("a")).status).not.toBe("connected");
	});
	it("outro usuário não inicia nem consulta (dono obrigatório)", async () => {
		const f = setup();
		await f.service.startDeviceLogin("a");
		await expect(f.service.startDeviceLogin("b")).rejects.toMatchObject({ status: 404 });
		await expect(f.service.pollDeviceLogin("b")).rejects.toMatchObject({ status: 404 });
		await expect(f.service.getAccountId("b")).rejects.toMatchObject({ status: 404 });
		expect(f.saved().device?.deviceAuthId).toBe("dev-1");
	});
});
