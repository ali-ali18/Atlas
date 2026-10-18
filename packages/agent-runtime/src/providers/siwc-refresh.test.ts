import { describe, expect, it, vi } from "vitest";
import { createSiwcAccessTokens } from "./siwc-refresh.js";
import { openSecrets, sealSecrets } from "../secrets/secret-box.js";
import type {
	SiwcSecrets,
	SiwcStore,
	ProviderConnectionRecord,
} from "./siwc-store.js";
const key = Buffer.alloc(32, 7),
	now = 1_800_000_000_000;
function fixture() {
	let row: ProviderConnectionRecord = {
		id: "fixture",
		userId: "a",
		provider: "chatgpt",
		status: "connected",
		accountEmail: null,
		secretsEnc: sealSecrets(
			{
				clientId: "oaiapp_fixture",
				hostId: "urn:uuid:fixture",
				accessToken: "fixture-old-access",
				refreshToken: "fixture-old-refresh",
			},
			key,
		),
		scopes: ["chatgpt.tokens.use.direct"],
		accessExpiresAt: new Date(now + 30_000),
		lastError: null,
		lastLimitAt: null,
		oauthStateHash: null,
		createdAt: new Date(now),
		updatedAt: new Date(now),
	};
	let tail: Promise<unknown> = Promise.resolve(),
		failCommit = false;
	const store: SiwcStore = {
		get: async () => row,
		ownerEmail: async () => "owner@example.com",
		findState: async () => null,
		lock: async (_id, operation) => {
			const wait = tail;
			let release!: () => void;
			tail = new Promise((resolve) => {
				release = resolve;
			});
			await wait;
			const before = { ...row };
			try {
				const result = await operation({
					get: async () => row,
					update: async (data) => {
						for (const [field, value] of Object.entries(data))
							Reflect.set(row, field, value);
					},
				});
				if (failCommit) {
					failCommit = false;
					row = before;
					throw new Error("fixture-private-token in driver error");
				}
				return result;
			} catch (error) {
				row = before;
				throw error;
			} finally {
				release();
			}
		},
	};
	const fetcher = vi.fn<typeof fetch>(
		async () =>
			new Response(
				JSON.stringify({
					access_token: "fixture-new-access",
					refresh_token: "fixture-new-refresh",
					scope: "chatgpt.tokens.use.direct",
					expires_in: 3600,
				}),
			),
	);
	const deps = {
		store,
		fetcher,
		now: () => now,
		key: () => key,
		authorize: async (id: string) => {
			if (id !== "a") throw new Error("not_found");
		},
		identity: (s: SiwcSecrets) => ({ hostId: s.hostId, clientId: s.clientId }),
		tokensData: (
			s: SiwcSecrets,
			t: { access_token: string; refresh_token: string },
		) => ({ ...s, accessToken: t.access_token, refreshToken: t.refresh_token }),
	};
	const access = createSiwcAccessTokens(deps);
	return {
		access,
		deps,
		fetcher,
		row: () => row,
		fail: () => {
			failCommit = true;
		},
		secrets: () => openSecrets<SiwcSecrets>(row.secretsEnc, key),
	};
}
describe("refresh transacional", () => {
	it("2xx com corpo perdido pode ter rotacionado e exige login novo", async () => {
		const f = fixture();
		f.fetcher.mockResolvedValue(new Response("invalid-json", { status: 200 }));
		await expect(f.access.getAccessToken("a")).rejects.toMatchObject({
			code: "needs_login",
		});
		expect(f.row().status).toBe("needs_login");
		expect(f.secrets().refreshToken).toBeUndefined();
	});

	it("access válido só lê banco sem lock ou endpoint", async () => {
		const f = fixture();
		f.row().accessExpiresAt = new Date(now + 3_600_000);
		const locked = vi.spyOn(f.deps.store, "lock");
		await expect(f.access.getAccessToken("a")).resolves.toBe(
			"fixture-old-access",
		);
		expect(locked).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	});

	it("single-flight e lock entre processos usam somente um par rotativo", async () => {
		const f = fixture(),
			second = createSiwcAccessTokens(f.deps);
		const results = await Promise.all([
			f.access.getAccessToken("a"),
			f.access.getAccessToken("a"),
			second.getAccessToken("a"),
		]);
		expect(results).toEqual(Array(3).fill("fixture-new-access"));
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(f.secrets().refreshToken).toBe("fixture-new-refresh");
	});
	it("falha de COMMIT depois de rotacionar limpa tokens em nova transação", async () => {
		const f = fixture();
		f.fail();
		await expect(f.access.getAccessToken("a")).rejects.toMatchObject({
			code: "needs_login",
		});
		expect(f.row().status).toBe("needs_login");
		expect(f.secrets().refreshToken).toBeUndefined();
		expect(f.secrets().accessToken).toBeUndefined();
	});
	it("fatal é lançado após commit da limpeza, sem rollback", async () => {
		const f = fixture();
		f.fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					error: "refresh_token_reused",
					error_description: "fixture-private-token",
				}),
				{ status: 400 },
			),
		);
		await expect(f.access.getAccessToken("a")).rejects.toMatchObject({
			code: "needs_login",
		});
		expect(f.row().status).toBe("needs_login");
		expect(f.secrets().refreshToken).toBeUndefined();
	});
	it("401 não herda token normal em voo e força uma renovação", async () => {
		const f = fixture();
		f.row().accessExpiresAt = new Date(now + 3_600_000);
		const normal = f.access.getAccessToken("a"),
			forced = f.access.getAccessToken("a", {
				force: true,
				previousAccessToken: "fixture-old-access",
			});
		await expect(normal).resolves.toBe("fixture-old-access");
		await expect(forced).resolves.toBe("fixture-new-access");
		expect(f.fetcher).toHaveBeenCalledTimes(1);
	});
});
