import { createHash, randomBytes } from "node:crypto";
import { freemem } from "node:os";
import type Docker from "dockerode";
import { createDockerClient, SandboxDockerUnavailableError } from "../docker-manager.js";
import { shouldRecreateForImage } from "../image-staleness.js";
import { decideAdmission } from "./admission.js";
import { createDevClient } from "./client.js";
import { DEV_TIERS, devTierResources, type DevSandboxConfig, type DevTier } from "./config.js";
import {
	createEgressGateway,
	gatewayProxyUrl,
	effectivePolicy,
	ipOnNetwork,
	networkForPolicy,
	wantsInternalNetwork,
	type EgressPolicy,
} from "./egress-network.js";
import {
	ENV_CACHE_INSPECT_SCRIPT,
	ENV_CACHE_LABEL,
	ENV_CACHE_MOUNT,
	ENV_CACHE_VOLUME_PREFIX,
	ENV_CACHE_WIPE_SCRIPT,
	envCacheId,
	envCacheVolumeName,
	parseEnvCacheInspect,
	selectEnvCacheEvictions,
	type EnvCacheEntry,
} from "./env-cache.js";
import type {
	DevContainerInfo,
	DevEndpoint,
	DevEnsureInput,
	DevEnsureResult,
	DevSandboxProvider,
} from "./provider.js";

export const DEV_CONTAINER_PORT = 3090;
export const DEV_LABEL = "atlas.dev-sandbox";
const TOKEN_ENV = "DEV_SANDBOX_TOKEN";

export function devContainerName(sessionId: string): string {
	return `dev-${sessionId}`;
}

/** Volume do workspace da sessão: sobrevive a stop e à recriação do container. */
export function devWorkspaceVolumeName(sessionId: string): string {
	return `atlas-dev-ws-${sessionId}`;
}

/** Caches de dependência (pnpm store, npm, pip) compartilhados entre as sessões de um usuário. */
export function devCacheVolumeName(userId: string): string {
	return `atlas-dev-cache-${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

/** Política inicial de internet como variáveis do container (o servidor a lê ao subir). */
export function egressEnv(
	config: Pick<DevSandboxConfig, "egressMode" | "egressAllowlist"> & Partial<Pick<DevSandboxConfig, "egressEnforce" | "gatewayName">>,
	egress?: DevEnsureInput["egress"],
): string[] {
	const policy = egress ?? { mode: config.egressMode === "allowlist" ? "allowlist" : "full", allowlist: config.egressAllowlist };
	const env = [`DEV_EGRESS_MODE=${policy.mode}`, `DEV_EGRESS_ALLOWLIST=${policy.allowlist.join(",")}`];
	// Com aplicação na rede, os comandos usam o proxy do gateway (o proxy local não tem rota de saída).
	if (config.egressEnforce && config.gatewayName) env.push(`DEV_EGRESS_PROXY_URL=${gatewayProxyUrl({ gatewayName: config.gatewayName })}`);
	return env;
}

/** Parâmetros do `createContainer` (puro, para teste). */
export function buildDevContainerSpec(
	config: DevSandboxConfig,
	input: { sessionId: string; userId: string; tier: DevTier; token: string; egress?: DevEnsureInput["egress"]; envCacheRepo?: string },
): Docker.ContainerCreateOptions {
	const tier = devTierResources(config, input.tier);
	// Cache de dependências do ambiente (por usuário + repo); o rótulo leva só o hash, nunca nomes ou valores.
	const envCache = config.cacheEnabled && input.envCacheRepo ? input.envCacheRepo : undefined;
	const memory = tier.memoryMb * 1024 * 1024;
	return {
		Image: config.image,
		name: devContainerName(input.sessionId),
		Env: [
			`${TOKEN_ENV}=${input.token}`,
			`DEV_SANDBOX_PORT=${DEV_CONTAINER_PORT}`,
			// Aviso de fim de job: o container assina com o próprio token e a API valida pelo token da sessão.
			...(config.callbackUrl ? [`DEV_SANDBOX_SESSION_ID=${input.sessionId}`, `DEV_SANDBOX_CALLBACK_URL=${config.callbackUrl}`] : []),
			...egressEnv(config, input.egress),
		],
		Labels: {
			[DEV_LABEL]: "true",
			[`${DEV_LABEL}.sessionId`]: input.sessionId,
			[`${DEV_LABEL}.userId`]: input.userId,
			[`${DEV_LABEL}.tier`]: input.tier,
			[`${DEV_LABEL}.memoryMb`]: String(tier.memoryMb),
			...(envCache ? { [ENV_CACHE_LABEL]: envCacheId(input.userId, envCache) } : {}),
		},
		ExposedPorts: { [`${DEV_CONTAINER_PORT}/tcp`]: {} },
		HostConfig: {
			Memory: memory,
			// Sem swap: estourar a memória mata o processo em vez de degradar o servidor inteiro.
			MemorySwap: memory,
			NanoCpus: Math.floor(tier.cpus * 1e9),
			PidsLimit: config.pidsLimit,
			NetworkMode: networkForPolicy(config, input.egress),
			Init: true,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			Binds: [
				`${devWorkspaceVolumeName(input.sessionId)}:/workspace`,
				`${devCacheVolumeName(input.userId)}:/cache`,
				...(envCache ? [`${envCacheVolumeName(input.userId, envCache)}:${ENV_CACHE_MOUNT}`] : []),
			],
			// Modo `network`: nada publicado no host; o worker usa o IP interno.
			...(config.connectMode === "network"
				? {}
				: {
						PortBindings: { [`${DEV_CONTAINER_PORT}/tcp`]: [{ HostIp: "127.0.0.1" }] },
						// Linux: host.docker.internal (callback) não existe por padrão.
						ExtraHosts: ["host.docker.internal:host-gateway"],
					}),
		},
	};
}

/** O container parado já foi criado sem o volume de cache que a sessão pede agora? */
export function missingEnvCacheMount(config: Pick<DevSandboxConfig, "cacheEnabled">, userId: string, repo: string | undefined, binds: string[] | undefined): boolean {
	if (!config.cacheEnabled || !repo) return false;
	const volume = envCacheVolumeName(userId, repo);
	return !(binds ?? []).some((bind) => bind.startsWith(`${volume}:`));
}

/** Texto de um stream multiplexado do Docker (cabeçalhos de 8 bytes por quadro). */
function demuxText(buffer: Buffer): string {
	// Sem cabeçalho de quadro (stream 0/1/2 + 3 bytes zero): texto puro.
	if (buffer.length < 8 || buffer[0]! > 2 || buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) return buffer.toString("utf8");
	let out = "";
	let offset = 0;
	while (offset + 8 <= buffer.length) {
		const size = buffer.readUInt32BE(offset + 4);
		out += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
		offset += 8 + size;
	}
	return out || buffer.toString("utf8");
}

type InspectLike = {
	Config?: { Env?: string[] };
	NetworkSettings?: {
		Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
		Networks?: Record<string, { IPAddress?: string } | undefined>;
	};
};

/** Onde o worker alcança o servidor do container (IP na rede compartilhada ou porta publicada). */
export function resolveDevEndpoint(
	config: Pick<DevSandboxConfig, "connectMode" | "networkMode" | "controlHost"> & Partial<Pick<DevSandboxConfig, "internalNetwork">>,
	inspect: InspectLike,
): DevEndpoint | null {
	const token = inspect.Config?.Env?.find((item) => item.startsWith(`${TOKEN_ENV}=`))?.slice(TOKEN_ENV.length + 1);
	if (!token) return null;
	if (config.connectMode === "network") {
		// Container com internet restrita fica só na rede interna; os demais, na rede normal.
		const ip =
			(config.internalNetwork ? ipOnNetwork(inspect, config.internalNetwork) : undefined) ??
			inspect.NetworkSettings?.Networks?.[config.networkMode]?.IPAddress?.trim();
		return ip ? { baseUrl: `http://${ip}:${DEV_CONTAINER_PORT}`, token } : null;
	}
	const port = inspect.NetworkSettings?.Ports?.[`${DEV_CONTAINER_PORT}/tcp`]?.[0]?.HostPort;
	return port ? { baseUrl: `http://${config.controlHost}:${port}`, token } : null;
}

export type DockerDevProviderOptions = {
	docker?: Docker;
	/** Memória disponível do host em MB (injetável em teste). */
	hostFreeMb?: () => number | undefined;
	sleep?: (ms: number) => Promise<void>;
	healthCheck?: (endpoint: DevEndpoint) => Promise<boolean>;
};

// Admissão + start precisam ser atômicos dentro do processo (dois starts
// simultâneos não podem passar juntos pela mesma folga de memória).
let admissionChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
	const run = admissionChain.then(fn, fn);
	admissionChain = run.catch(() => undefined);
	return run;
}

export function createDockerDevProvider(config: DevSandboxConfig, options: DockerDevProviderOptions = {}): DevSandboxProvider {
	let docker: Docker | null = options.docker ?? null;
	const hostFreeMb = options.hostFreeMb ?? (() => freemem() / (1024 * 1024));
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const healthCheck =
		options.healthCheck ??
		(async (endpoint: DevEndpoint) => {
			try {
				return (await createDevClient(endpoint).health()).ok === true;
			} catch {
				return false;
			}
		});

	const gateway = config.egressEnforce ? createEgressGateway(config, { docker: () => getDocker() }) : null;
	/** Última política registrada por sessão (para re-registrar quando o gateway reinicia). */
	const known = new Map<string, { ip: string; policy: EgressPolicy }>();
	let warnedBestEffort = config.egressEnforceUnavailable;
	if (config.egressEnforceUnavailable) {
		console.warn(
			"[dev-egress] DEV_SANDBOX_EGRESS_ENFORCE=network exige DEV_SANDBOX_CONNECT_MODE=network (portas publicadas não funcionam em rede interna); usando só o proxy de melhor esforço",
		);
	}

	function getDocker(): Docker {
		if (!config.enabled) throw new SandboxDockerUnavailableError("Sessões de desenvolvimento desativadas (DEV_SANDBOX_ENABLED)");
		docker ??= createDockerClient(config);
		return docker;
	}

	async function inspectOrNull(sessionId: string) {
		try {
			return await getDocker().getContainer(devContainerName(sessionId)).inspect();
		} catch (error) {
			if ((error as { statusCode?: number }).statusCode === 404) return null;
			throw error;
		}
	}

	async function runningContainers(): Promise<Array<{ memoryMb: number }>> {
		const items = await getDocker().listContainers({ filters: { label: [`${DEV_LABEL}=true`], status: ["running"] } });
		return items.map((item) => ({ memoryMb: Number.parseInt(item.Labels?.[`${DEV_LABEL}.memoryMb`] ?? "", 10) || DEV_TIERS.small.memoryMb }));
	}

	async function waitReady(sessionId: string): Promise<{ endpoint: DevEndpoint; containerId: string }> {
		for (let attempt = 0; attempt < config.readyAttempts; attempt += 1) {
			const inspect = await inspectOrNull(sessionId);
			const endpoint = inspect ? resolveDevEndpoint(config, inspect) : null;
			if (inspect && endpoint && (await healthCheck(endpoint))) return { endpoint, containerId: inspect.Id };
			await sleep(1_000);
		}
		throw new SandboxDockerUnavailableError("O ambiente de desenvolvimento não ficou pronto a tempo");
	}

	async function imageIsStale(containerImageId: string | undefined): Promise<boolean> {
		try {
			const current = await getDocker().getImage(config.image).inspect();
			return shouldRecreateForImage(containerImageId, current.Id);
		} catch {
			return false;
		}
	}

	/** Garante rede interna + gateway; se o gateway reiniciou, re-registra as sessões conhecidas. */
	async function prepareGateway(): Promise<void> {
		if (!gateway) return;
		const { fresh } = await gateway.ensure();
		if (fresh) {
			for (const [id, entry] of known) {
				try {
					await gateway.register(entry.ip, entry.policy, id);
				} catch (error) {
					console.warn(`[dev-egress] não foi possível re-registrar a sessão ${id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	/**
	 * Põe o container na(s) rede(s) certa(s) para a política (interna para allowlist/off, normal para full)
	 * e registra a política no gateway. Falha fechada: se não registrar, lança.
	 */
	async function applyEgressNetwork(inspect: Awaited<ReturnType<typeof inspectOrNull>> & object, sessionId: string, policy: EgressPolicy) {
		if (!gateway) {
			if (policy.mode !== "full" && !warnedBestEffort) {
				warnedBestEffort = true;
				console.warn(
					"[dev-egress] aplicação de saída na rede indisponível (exige DEV_SANDBOX_CONNECT_MODE=network); usando só o proxy de melhor esforço dentro do container",
				);
			}
			return inspect;
		}
		const client = getDocker();
		const nets = () => inspect.NetworkSettings?.Networks ?? {};
		if (wantsInternalNetwork(config, policy)) {
			await prepareGateway();
			if (!nets()[config.internalNetwork]) await client.getNetwork(config.internalNetwork).connect({ Container: inspect.Id });
			if (nets()[config.networkMode]) await client.getNetwork(config.networkMode).disconnect({ Container: inspect.Id, Force: true });
			inspect = (await inspectOrNull(sessionId)) ?? inspect;
			const ip = ipOnNetwork(inspect, config.internalNetwork);
			if (!ip) throw new Error("Container sem IP na rede interna de saída");
			await gateway.register(ip, policy, sessionId);
			known.set(sessionId, { ip, policy });
			return inspect;
		}
		const previous = ipOnNetwork(inspect, config.internalNetwork);
		if (nets()[config.internalNetwork]) {
			if (!nets()[config.networkMode]) await client.getNetwork(config.networkMode).connect({ Container: inspect.Id });
			await client.getNetwork(config.internalNetwork).disconnect({ Container: inspect.Id, Force: true });
			inspect = (await inspectOrNull(sessionId)) ?? inspect;
		}
		known.delete(sessionId);
		if (previous) await gateway.unregister(previous).catch(() => undefined);
		return inspect;
	}

	async function ensureLocked(input: DevEnsureInput): Promise<DevEnsureResult> {
		const client = getDocker();
		let inspect = await inspectOrNull(input.sessionId);
		const policy = effectivePolicy(config, input.egress);

		if (inspect?.State?.Running) {
			inspect = await applyEgressNetwork(inspect, input.sessionId, policy);
			const endpoint = resolveDevEndpoint(config, inspect);
			if (endpoint) return { status: "running", endpoint, containerId: inspect.Id, resumed: false };
		}

		const requestedMb = DEV_TIERS[input.tier].memoryMb;
		const decision = decideAdmission({
			running: await runningContainers(),
			requestedMb,
			maxConcurrent: config.maxConcurrent,
			memoryBudgetMb: config.memoryBudgetMb,
			hostFreeMb: hostFreeMb(),
			minFreeMb: config.minFreeMb,
		});
		if (!decision.admit) return { status: "queued", denied: decision };

		// Imagem reconstruída: recria o container (o volume do workspace permanece).
		if (inspect && (await imageIsStale(inspect.Image))) {
			await client.getContainer(inspect.Id).remove({ force: true });
			inspect = null;
		}
		// Parado e criado antes de o repositório (ou o cache) existir: recria com o volume de cache; o workspace permanece.
		if (inspect && !inspect.State?.Running && missingEnvCacheMount(config, input.userId, input.envCacheRepo, inspect.HostConfig?.Binds ?? undefined)) {
			await client.getContainer(inspect.Id).remove({ force: true });
			inspect = null;
		}
		const resumed = Boolean(inspect);
		if (inspect) {
			if (!inspect.State?.Running) await client.getContainer(inspect.Id).start();
		} else {
			if (wantsInternalNetwork(config, policy)) await prepareGateway();
			const container = await client.createContainer(
				buildDevContainerSpec(config, { ...input, token: randomBytes(24).toString("hex") }),
			);
			await container.start();
		}
		let ready = await waitReady(input.sessionId);
		const started = await inspectOrNull(input.sessionId);
		if (started) {
			const adjusted = await applyEgressNetwork(started, input.sessionId, policy);
			if (adjusted !== started) ready = await waitReady(input.sessionId);
		}
		return { status: "running", ...ready, resumed };
	}

	/** Roda um script curto numa imagem da sandbox com o volume do cache montado; devolve a saída. */
	async function runCacheHelper(volume: string, script: string, readOnly: boolean): Promise<string> {
		const client = getDocker();
		const container = await client.createContainer({
			Image: config.image,
			Entrypoint: ["sh", "-c"],
			Cmd: [script],
			User: "1001",
			Labels: { [DEV_LABEL]: "helper" },
			HostConfig: {
				Binds: [`${volume}:${ENV_CACHE_MOUNT}${readOnly ? ":ro" : ""}`],
				NetworkMode: "none",
				Memory: 128 * 1024 * 1024,
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges"],
			},
		});
		try {
			await container.start();
			await container.wait();
			const logs = await container.logs({ stdout: true, stderr: false, follow: false });
			return Buffer.isBuffer(logs) ? demuxText(logs) : String(logs);
		} finally {
			await container.remove({ force: true }).catch(() => undefined);
		}
	}

	async function runningEnvCacheIds(): Promise<Set<string>> {
		const items = await getDocker().listContainers({ filters: { label: [ENV_CACHE_LABEL], status: ["running"] } });
		return new Set(items.map((item) => item.Labels?.[ENV_CACHE_LABEL]).filter((value): value is string => Boolean(value)));
	}

	async function wipeEnvCache(volume: string): Promise<void> {
		await runCacheHelper(volume, ENV_CACHE_WIPE_SCRIPT, false);
		// Remove o volume se nenhum container o referencia; senão fica vazio (o próximo save reaproveita).
		await getDocker().getVolume(volume).remove().catch(() => undefined);
	}

	async function unregisterSession(sessionId: string): Promise<void> {
		const entry = known.get(sessionId);
		known.delete(sessionId);
		if (!gateway || !entry) return;
		// Melhor esforço: IP sem registro cai em "negar tudo" no gateway.
		await gateway.unregister(entry.ip).catch(() => undefined);
	}

	return {
		ensureRunning(input) {
			return serialized(() => ensureLocked(input));
		},

		setEgress(sessionId, policy) {
			return serialized(async () => {
				const inspect = await inspectOrNull(sessionId);
				if (inspect?.State?.Running) await applyEgressNetwork(inspect, sessionId, policy);
			});
		},

		async stop(sessionId) {
			await unregisterSession(sessionId);
			try {
				await getDocker().getContainer(devContainerName(sessionId)).stop({ t: 5 });
			} catch (error) {
				const code = (error as { statusCode?: number }).statusCode;
				if (code !== 404 && code !== 304) throw error;
			}
		},

		async destroy(sessionId, opts = {}) {
			const client = getDocker();
			await unregisterSession(sessionId);
			try {
				await client.getContainer(devContainerName(sessionId)).remove({ force: true });
			} catch (error) {
				if ((error as { statusCode?: number }).statusCode !== 404) throw error;
			}
			if (opts.removeVolume) {
				try {
					await client.getVolume(devWorkspaceVolumeName(sessionId)).remove({ force: true });
				} catch (error) {
					if ((error as { statusCode?: number }).statusCode !== 404) throw error;
				}
			}
		},

		async inspect(sessionId): Promise<DevContainerInfo> {
			const inspect = await inspectOrNull(sessionId);
			if (!inspect) return { state: "missing" };
			return { state: inspect.State?.Running ? "running" : "stopped", containerId: inspect.Id };
		},

		async endpoint(sessionId) {
			const inspect = await inspectOrNull(sessionId);
			if (!inspect?.State?.Running) return null;
			return resolveDevEndpoint(config, inspect);
		},

		async clearEnvCache(userId, repo) {
			if (!config.cacheEnabled) return false;
			const volume = envCacheVolumeName(userId, repo);
			try {
				await getDocker().getVolume(volume).inspect();
			} catch (error) {
				if ((error as { statusCode?: number }).statusCode === 404) return false;
				throw error;
			}
			await wipeEnvCache(volume);
			return true;
		},

		async sweepEnvCaches() {
			if (!config.cacheEnabled) return { evicted: [], totalBytes: 0 };
			const listed = await getDocker().listVolumes();
			const names = (listed.Volumes ?? []).map((item) => item.Name).filter((name) => name.startsWith(ENV_CACHE_VOLUME_PREFIX));
			const busy = await runningEnvCacheIds();
			const entries: EnvCacheEntry[] = [];
			for (const name of names) {
				try {
					const info = parseEnvCacheInspect(await runCacheHelper(name, ENV_CACHE_INSPECT_SCRIPT, true));
					if (!info) continue;
					const created = Date.parse(((listed.Volumes ?? []).find((item) => item.Name === name) as { CreatedAt?: string } | undefined)?.CreatedAt ?? "");
					entries.push({
						name,
						sizeBytes: info.sizeBytes,
						// Sem .used (nunca salvou): conta desde a criação do volume.
						usedAtMs: info.usedAtMs || (Number.isFinite(created) ? created : Date.now()),
						inUse: busy.has(name.slice(ENV_CACHE_VOLUME_PREFIX.length)),
					});
				} catch (error) {
					console.warn(`[dev-cache] não consegui medir ${name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const evictions = selectEnvCacheEvictions(entries, { now: Date.now(), maxAgeMs: config.cacheMaxAgeMs, maxBytes: config.cacheMaxBytes });
			const evicted: Array<{ name: string; reason: "expired" | "over-limit" }> = [];
			for (const eviction of evictions) {
				try {
					await wipeEnvCache(eviction.name);
					evicted.push(eviction);
				} catch (error) {
					console.warn(`[dev-cache] não consegui apagar ${eviction.name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const gone = new Set(evicted.map((item) => item.name));
			return { evicted, totalBytes: entries.filter((entry) => !gone.has(entry.name)).reduce((sum, entry) => sum + entry.sizeBytes, 0) };
		},

		async runningJobs(sessionId) {
			const endpoint = await this.endpoint(sessionId);
			if (!endpoint) return 0;
			try {
				return (await createDevClient(endpoint).health()).runningJobs ?? 0;
			} catch {
				return 0;
			}
		},
	};
}
