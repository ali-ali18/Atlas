import { describe, expect, it, vi } from "vitest";
import { loadDevSandboxConfig, type DevSandboxConfig } from "./config.js";
import { buildDevContainerSpec, createDockerDevProvider, missingEnvCacheMount } from "./docker-provider.js";
import {
	computeEnvCacheKey,
	decideEnvCache,
	ENV_CACHE_LABEL,
	ENV_CACHE_MOUNT,
	envCacheId,
	envCacheVolumeName,
	hashEnvVars,
	parseEnvCacheInspect,
	parseEnvCacheMeta,
	selectEnvCacheEvictions,
} from "./env-cache.js";
import { sweepEnvCachesOnce } from "./reaper.js";

const SECRET = "valor-super-secreto-123";
const base = { userId: "u1", repo: "Octo/Hello", installCommand: "pnpm install", lockHash: "lock-a", runtime: "2 v22 x64", env: { API_KEY: SECRET } };
const DAY = 24 * 60 * 60_000;
const config: DevSandboxConfig = { ...loadDevSandboxConfig({ DEV_SANDBOX_ENABLED: "true" }), connectMode: "network", networkMode: "atlas-sandbox" };

describe("chave do cache", () => {
	it("é estável e muda com lockfile, comando, runtime e segredos", () => {
		const a = computeEnvCacheKey(base);
		expect(computeEnvCacheKey({ ...base })).toEqual(a);
		expect(computeEnvCacheKey({ ...base, lockHash: "lock-b" }).key).not.toBe(a.key);
		expect(computeEnvCacheKey({ ...base, installCommand: "pnpm install --frozen-lockfile" }).key).not.toBe(a.key);
		expect(computeEnvCacheKey({ ...base, runtime: "3 v22 x64" }).key).not.toBe(a.key);
		expect(computeEnvCacheKey({ ...base, env: { API_KEY: "outro" } }).key).not.toBe(a.key);
		expect(computeEnvCacheKey({ ...base, env: { API_KEY: SECRET, EXTRA: "1" } }).key).not.toBe(a.key);
		expect(computeEnvCacheKey({ ...base, installCommand: "  pnpm install " }).key).toBe(a.key);
	});
	it("lockfile só muda a parte lock; segredo só muda a parte env", () => {
		const a = computeEnvCacheKey(base).parts;
		const lock = computeEnvCacheKey({ ...base, lockHash: "x" }).parts;
		expect(lock.lock).not.toBe(a.lock);
		expect([lock.install, lock.runtime, lock.env]).toEqual([a.install, a.runtime, a.env]);
		const env = computeEnvCacheKey({ ...base, env: { API_KEY: "y" } }).parts;
		expect(env.env).not.toBe(a.env);
		expect([env.install, env.lock, env.runtime]).toEqual([a.install, a.lock, a.runtime]);
	});
	it("ordem das variáveis não importa; o hash é salgado por usuário+repo", () => {
		expect(hashEnvVars({ A: "1", B: "2" }, "s")).toBe(hashEnvVars({ B: "2", A: "1" }, "s"));
		expect(hashEnvVars({ A: "1" }, "s1")).not.toBe(hashEnvVars({ A: "1" }, "s2"));
	});
	it("nenhum valor de segredo aparece na chave, nas partes, no nome do volume ou nos rótulos", () => {
		const { key, parts } = computeEnvCacheKey(base);
		const spec = buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "small", token: "t", envCacheRepo: base.repo });
		const visible = JSON.stringify({ key, parts, volume: envCacheVolumeName("u1", base.repo), labels: spec.Labels, binds: spec.HostConfig?.Binds, name: spec.name });
		expect(visible).not.toContain(SECRET);
		expect(visible).not.toContain("API_KEY");
	});
	it("volume é por usuário + repo (sem diferença de caixa) e nunca compartilhado entre usuários", () => {
		expect(envCacheVolumeName("u1", "Octo/Hello")).toBe(envCacheVolumeName("u1", "octo/hello"));
		expect(envCacheVolumeName("u1", "octo/hello")).not.toBe(envCacheVolumeName("u2", "octo/hello"));
		expect(envCacheVolumeName("u1", "octo/hello")).not.toBe(envCacheVolumeName("u1", "octo/other"));
	});
});

describe("decisão de reuso", () => {
	const current = computeEnvCacheKey(base);
	const saved = (patch: Partial<Parameters<typeof computeEnvCacheKey>[0]> = {}) => {
		const k = computeEnvCacheKey({ ...base, ...patch });
		return { key: k.key, parts: k.parts, savedAt: 1 };
	};
	it("desligado ou volume indisponível: off", () => {
		expect(decideEnvCache({ enabled: false, available: true, saved: saved(), current }).action).toBe("off");
		expect(decideEnvCache({ enabled: true, available: false, saved: saved(), current }).action).toBe("off");
	});
	it("sem cache salvo: miss (instala e salva)", () => {
		expect(decideEnvCache({ enabled: true, available: true, saved: null, current })).toEqual({ action: "miss", restore: false, clear: false, save: true });
	});
	it("mesma chave: hit (restaura, não salva de novo)", () => {
		expect(decideEnvCache({ enabled: true, available: true, saved: saved(), current })).toEqual({ action: "hit", restore: true, clear: false, save: false });
	});
	it("lockfile mudou: stale (restaura e instala por cima)", () => {
		expect(decideEnvCache({ enabled: true, available: true, saved: saved({ lockHash: "antigo" }), current })).toEqual({ action: "stale", restore: true, clear: false, save: true });
	});
	it("comando, segredos ou runtime mudaram: rebuild (descarta)", () => {
		for (const patch of [{ installCommand: "npm ci" }, { env: { API_KEY: "x" } }, { runtime: "1 v20 x64" }]) {
			expect(decideEnvCache({ enabled: true, available: true, saved: saved(patch), current })).toEqual({ action: "rebuild", restore: false, clear: true, save: true });
		}
	});
	it("comando e lockfile mudaram juntos: rebuild vence", () => {
		expect(decideEnvCache({ enabled: true, available: true, saved: saved({ installCommand: "npm ci", lockHash: "z" }), current }).action).toBe("rebuild");
	});
	it("metadados inválidos viram null", () => {
		expect(parseEnvCacheMeta("")).toBeNull();
		expect(parseEnvCacheMeta("{nao json")).toBeNull();
		expect(parseEnvCacheMeta(JSON.stringify({ key: "k" }))).toBeNull();
		expect(parseEnvCacheMeta(JSON.stringify(saved()))?.key).toBe(current.key);
	});
});

describe("expiração e teto (LRU)", () => {
	const now = 100 * DAY;
	const GB = 1024 ** 3;
	it("remove o que está sem uso há mais de 7 dias e poupa o recente", () => {
		const out = selectEnvCacheEvictions(
			[
				{ name: "velho", usedAtMs: now - 8 * DAY, sizeBytes: GB },
				{ name: "limite", usedAtMs: now - 7 * DAY, sizeBytes: GB },
				{ name: "novo", usedAtMs: now - DAY, sizeBytes: GB },
			],
			{ now, maxAgeMs: 7 * DAY, maxBytes: 20 * GB },
		);
		expect(out).toEqual([{ name: "velho", reason: "expired" }]);
	});
	it("acima do teto remove os menos usados recentemente até caber", () => {
		const out = selectEnvCacheEvictions(
			[
				{ name: "c", usedAtMs: now - 1 * DAY, sizeBytes: 8 * GB },
				{ name: "a", usedAtMs: now - 5 * DAY, sizeBytes: 8 * GB },
				{ name: "b", usedAtMs: now - 3 * DAY, sizeBytes: 8 * GB },
			],
			{ now, maxAgeMs: 7 * DAY, maxBytes: 20 * GB },
		);
		expect(out).toEqual([{ name: "a", reason: "over-limit" }]);
		const more = selectEnvCacheEvictions(
			[
				{ name: "c", usedAtMs: now - 1 * DAY, sizeBytes: 15 * GB },
				{ name: "a", usedAtMs: now - 5 * DAY, sizeBytes: 8 * GB },
				{ name: "b", usedAtMs: now - 3 * DAY, sizeBytes: 8 * GB },
			],
			{ now, maxAgeMs: 7 * DAY, maxBytes: 20 * GB },
		);
		expect(more.map((item) => item.name)).toEqual(["a", "b"]);
	});
	it("expirados não contam para o teto; em uso nunca são removidos", () => {
		const out = selectEnvCacheEvictions(
			[
				{ name: "velho", usedAtMs: now - 30 * DAY, sizeBytes: 30 * GB },
				{ name: "ativo", usedAtMs: now - 30 * DAY, sizeBytes: 10 * GB, inUse: true },
				{ name: "novo", usedAtMs: now - DAY, sizeBytes: 5 * GB },
			],
			{ now, maxAgeMs: 7 * DAY, maxBytes: 20 * GB },
		);
		expect(out).toEqual([{ name: "velho", reason: "expired" }]);
	});
	it("lê a saída do container auxiliar", () => {
		expect(parseEnvCacheInspect("1700000000 2048\n")).toEqual({ usedAtMs: 1_700_000_000_000, sizeBytes: 2048 * 1024 });
		expect(parseEnvCacheInspect("lixo")).toBeNull();
	});
});

describe("config", () => {
	it("cache ligado por padrão, 20 GB e 7 dias", () => {
		const c = loadDevSandboxConfig({});
		expect(c.cacheEnabled).toBe(true);
		expect(c.cacheMaxBytes).toBe(20 * 1024 ** 3);
		expect(c.cacheMaxAgeMs).toBe(7 * DAY);
	});
	it("DEV_SANDBOX_CACHE=off desliga; teto e dias são configuráveis e valores inválidos voltam ao padrão", () => {
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CACHE: "off" }).cacheEnabled).toBe(false);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CACHE: "ON" }).cacheEnabled).toBe(true);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CACHE_MAX_GB: "5" }).cacheMaxBytes).toBe(5 * 1024 ** 3);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CACHE_MAX_GB: "abc" }).cacheMaxBytes).toBe(20 * 1024 ** 3);
		expect(loadDevSandboxConfig({ DEV_SANDBOX_CACHE_MAX_AGE_DAYS: "2" }).cacheMaxAgeMs).toBe(2 * DAY);
	});
});

describe("especificação do container", () => {
	it("monta o volume do ambiente em /envcache e rotula só com o hash", () => {
		const spec = buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "small", token: "t", envCacheRepo: "octo/hello" });
		expect(spec.HostConfig?.Binds).toContain(`${envCacheVolumeName("u1", "octo/hello")}:${ENV_CACHE_MOUNT}`);
		expect(spec.Labels?.[ENV_CACHE_LABEL]).toBe(envCacheId("u1", "octo/hello"));
		expect(JSON.stringify(spec.Labels)).not.toContain("octo/hello");
	});
	it("sem repositório ou com cache desligado não monta nada", () => {
		expect(buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "small", token: "t" }).HostConfig?.Binds).toHaveLength(2);
		const off = { ...config, cacheEnabled: false };
		const spec = buildDevContainerSpec(off, { sessionId: "s1", userId: "u1", tier: "small", token: "t", envCacheRepo: "octo/hello" });
		expect(spec.HostConfig?.Binds).toHaveLength(2);
		expect(spec.Labels?.[ENV_CACHE_LABEL]).toBeUndefined();
	});
	it("o volume de outro usuário não é montado", () => {
		const a = buildDevContainerSpec(config, { sessionId: "s1", userId: "u1", tier: "small", token: "t", envCacheRepo: "octo/hello" });
		const b = buildDevContainerSpec(config, { sessionId: "s2", userId: "u2", tier: "small", token: "t", envCacheRepo: "octo/hello" });
		expect(a.HostConfig?.Binds?.[2]).not.toBe(b.HostConfig?.Binds?.[2]);
	});
	it("container parado criado sem o volume é recriado; com o volume, não", () => {
		const volume = envCacheVolumeName("u1", "octo/hello");
		expect(missingEnvCacheMount(config, "u1", "octo/hello", ["ws:/workspace"])).toBe(true);
		expect(missingEnvCacheMount(config, "u1", "octo/hello", [`${volume}:/envcache`])).toBe(false);
		expect(missingEnvCacheMount(config, "u1", undefined, [])).toBe(false);
		expect(missingEnvCacheMount({ ...config, cacheEnabled: false }, "u1", "octo/hello", [])).toBe(false);
	});
});

function fakeDocker(volumes: Array<{ Name: string; CreatedAt?: string }>, stats: Record<string, string>, runningLabels: string[] = []) {
	const wiped: string[] = [];
	const removed: string[] = [];
	const docker = {
		listVolumes: vi.fn(async () => ({ Volumes: volumes })),
		listContainers: vi.fn(async () => runningLabels.map((id) => ({ Labels: { [ENV_CACHE_LABEL]: id } }))),
		createContainer: vi.fn(async (opts: { Cmd: string[]; HostConfig: { Binds: string[] } }) => {
			const mounted = opts.HostConfig.Binds[0]!.split(":")[0]!;
			const isWipe = opts.Cmd[0]!.includes("rm -rf");
			return {
				start: vi.fn(async () => {
					if (isWipe) wiped.push(mounted);
				}),
				wait: vi.fn(async () => ({ StatusCode: 0 })),
				logs: vi.fn(async () => {
					const text = Buffer.from(stats[mounted] ?? "0 0");
					const header = Buffer.alloc(8);
					header[0] = 1;
					header.writeUInt32BE(text.length, 4);
					return Buffer.concat([header, text]);
				}),
				remove: vi.fn(async () => undefined),
			};
		}),
		getVolume: vi.fn((name: string) => ({
			inspect: vi.fn(async () => {
				if (!volumes.some((v) => v.Name === name)) throw Object.assign(new Error("no"), { statusCode: 404 });
				return {};
			}),
			remove: vi.fn(async () => {
				removed.push(name);
			}),
		})),
	};
	return { docker, wiped, removed };
}

describe("provedor: limpeza e varredura dos caches", () => {
	const GB = 1024 ** 3;
	const kib = (bytes: number) => Math.floor(bytes / 1024);
	const nowSec = () => Math.floor(Date.now() / 1000);
	const name = (id: string) => `atlas-dev-envcache-${id}`;

	it("limpar apaga o conteúdo do volume do usuário+repo; sem volume devolve false", async () => {
		const volume = envCacheVolumeName("u1", "octo/hello");
		const f = fakeDocker([{ Name: volume }], {});
		const provider = createDockerDevProvider(config, { docker: f.docker as never });
		expect(await provider.clearEnvCache!("u1", "octo/hello")).toBe(true);
		expect(f.wiped).toEqual([volume]);
		expect(await provider.clearEnvCache!("u2", "octo/hello")).toBe(false);
		expect(f.wiped).toEqual([volume]);
	});
	it("com o cache desligado, limpar não faz nada", async () => {
		const f = fakeDocker([], {});
		const provider = createDockerDevProvider({ ...config, cacheEnabled: false }, { docker: f.docker as never });
		expect(await provider.clearEnvCache!("u1", "octo/hello")).toBe(false);
		expect(f.docker.createContainer).not.toHaveBeenCalled();
	});
	it("varredura expira os sem uso há 7 dias e aplica o teto em LRU, poupando os em uso", async () => {
		const f = fakeDocker(
			[{ Name: name("old") }, { Name: name("a") }, { Name: name("b") }, { Name: name("busy") }, { Name: "outro-volume" }],
			{
				[name("old")]: `${nowSec() - 9 * 86400} ${kib(GB)}`,
				[name("a")]: `${nowSec() - 3 * 86400} ${kib(12 * GB)}`,
				[name("b")]: `${nowSec() - 1 * 86400} ${kib(12 * GB)}`,
				[name("busy")]: `${nowSec() - 20 * 86400} ${kib(GB)}`,
			},
			["busy"],
		);
		const provider = createDockerDevProvider({ ...config, cacheMaxBytes: 20 * GB }, { docker: f.docker as never });
		const result = await provider.sweepEnvCaches!();
		expect(result.evicted).toEqual([
			{ name: name("old"), reason: "expired" },
			{ name: name("a"), reason: "over-limit" },
		]);
		expect([...f.wiped].sort()).toEqual([name("a"), name("old")]);
		expect(result.totalBytes).toBe(13 * GB);
	});
	it("sweepEnvCachesOnce nunca lança", async () => {
		const log = vi.fn();
		const failing = {
			sweepEnvCaches: async () => {
				throw new Error("docker fora");
			},
		} as never;
		expect(await sweepEnvCachesOnce(failing, log)).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("docker fora"));
	});
});
