import Docker from "dockerode";
import type { SandboxRuntimeConfig } from "./config.js";
import { createSandboxManager, resolveSandboxEndpoint, SANDBOX_STOP_TIMEOUT_S } from "./docker-manager.js";
import { listAllSessionsForCleanup as listSessions } from "./session-store.js";
import { loadCodeRunnerConfig } from "./code-runner/config.js";
import { reapCodeRunnerContainers } from "./code-runner/executor.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const SANDBOX_LABEL = "atlas.sandbox";

/**
 * Quanto tempo o control server da VM está sem receber ferramenta (GET /idle).
 * null = não deu para saber (VM fora, imagem antiga sem /idle, rede). Existe porque
 * o store de sessões é por processo: a API não enxerga a VM que o worker usa, então
 * "idade do container" ou "lastUsedAt local" derrubavam VM em uso (SIGTERM, exit 143).
 */
export async function probeSandboxIdleMs(
	docker: Docker,
	config: SandboxRuntimeConfig,
	containerId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
	try {
		const inspect = await docker.getContainer(containerId).inspect();
		if (!inspect.State?.Running) return null;
		const endpoint = resolveSandboxEndpoint(config, inspect);
		if (!endpoint) return null;
		const response = await fetchImpl(`http://${endpoint.host}:${endpoint.controlPort}/idle`, {
			signal: AbortSignal.timeout(3_000),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { idleMs?: unknown };
		return typeof body.idleMs === "number" && Number.isFinite(body.idleMs) ? body.idleMs : null;
	} catch {
		return null;
	}
}

/** Órfãos (fora do store deste processo): só dorme o que está comprovadamente ocioso; remove velhos além do hardTtl. */
export async function reapOrphanContainers(
	docker: Docker,
	config: SandboxRuntimeConfig,
	known: Set<string>,
	options: { ttlMs: number; hardTtlMs: number; now?: number; probe?: typeof probeSandboxIdleMs },
): Promise<void> {
	const now = options.now ?? Date.now();
	const probe = options.probe ?? probeSandboxIdleMs;
	let containers: Awaited<ReturnType<Docker["listContainers"]>>;
	try {
		containers = await docker.listContainers({
			all: true,
			filters: { label: [SANDBOX_LABEL] },
		});
	} catch (error) {
		console.error("[sandbox-reaper] docker list failed", error);
		return;
	}

	for (const container of containers) {
		const name = (container.Names?.[0] ?? "").replace(/^\//, "");
		if (known.has(name)) continue;
		const ageMs = now - (container.Created ? container.Created * 1000 : now);

		if (ageMs > options.hardTtlMs && container.State !== "running") {
			try {
				await docker.getContainer(container.Id).remove({ force: true });
				console.log(`[sandbox-reaper] removed stale orphan ${name}`);
			} catch (error) {
				console.error("[sandbox-reaper] failed to remove orphan", error);
			}
			continue;
		}

		if (ageMs > options.ttlMs && container.State === "running") {
			const idleMs = await probe(docker, config, container.Id);
			if (idleMs === null || idleMs < options.ttlMs) continue;
			try {
				console.log(`[sandbox-reaper] stopping idle orphan ${name} idleMs=${idleMs}`);
				await docker.getContainer(container.Id).stop({ t: SANDBOX_STOP_TIMEOUT_S });
				console.log(`[sandbox-reaper] slept orphan ${name}`);
			} catch (error) {
				console.error("[sandbox-reaper] failed to stop orphan", error);
			}
		}
	}
}

/**
 * Descansa sessões de sandbox ociosas: **para** o container (preserva o estado
 * pra religar depois) após `ttlMs`; remove de fato só após `hardTtlMs`. Também
 * cuida de órfãos (containers que não estão no session-store, ex.: após restart
 * da API) — parando-os e, bem depois, removendo.
 * Retorna um stop().
 */
export function startSandboxReaper(
	config: SandboxRuntimeConfig,
	options: { ttlMs?: number; hardTtlMs?: number; intervalMs?: number } = {},
): () => void {
	const codeRunnerEnabled = loadCodeRunnerConfig().enabled;
	if (!config.enabled && !codeRunnerEnabled) {
		return () => undefined;
	}

	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const hardTtlMs = options.hardTtlMs ?? DEFAULT_HARD_TTL_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	// Fase 0: mesmo critério do docker-manager — proxy TCP quando DOCKER_HOST setado.
	const dockerHost = config.dockerHost?.trim();
	const docker = (() => {
		if (dockerHost) {
			try {
				const url = new URL(dockerHost);
				if ((url.protocol === "tcp:" || url.protocol === "http:") && url.hostname) {
					const port = url.port ? Number.parseInt(url.port, 10) : 2375;
					return new Docker({ host: url.hostname, port });
				}
			} catch {
				// cai no socket abaixo
			}
		}
		return new Docker({ socketPath: config.dockerSocketPath });
	})();

	const reapInMemory = async (): Promise<void> => {
		const now = Date.now();
		for (const record of listSessions()) {
			if (record.status !== "running") continue;
			const idleSince =
				record.lastUsedAt?.getTime() ?? record.createdAt.getTime();
			if (now - idleSince < ttlMs) continue;
			// Outro processo (worker) pode estar usando a mesma VM: confirma ociosidade real antes de parar.
			if (record.containerId) {
				const idleMs = await probeSandboxIdleMs(docker, config, record.containerId);
				if (idleMs !== null && idleMs < ttlMs) {
					record.lastUsedAt = new Date(now - idleMs);
					continue;
				}
			}
			try {
				console.log(`[sandbox-reaper] stopping idle session ${record.sessionId} (${record.containerName})`);
				await createSandboxManager(config, record.userId).stopSession(record.sessionId);
				console.log(`[sandbox-reaper] slept idle session ${record.sessionId}`);
			} catch (error) {
				console.error("[sandbox-reaper] failed to stop session", error);
			}
		}
	};

	const reapOrphans = async (): Promise<void> => {
		const known = new Set(listSessions().map((record) => record.containerName));
		await reapOrphanContainers(docker, config, known, { ttlMs, hardTtlMs });
	};

	const reap = async (): Promise<void> => {
		if (config.enabled) {
			await reapInMemory();
			await reapOrphans();
		}
		// Containers efêmeros do `run_code` esquecidos (processo morreu no meio da execução).
		if (codeRunnerEnabled) await reapCodeRunnerContainers(docker);
	};

	const timer = setInterval(() => {
		void reap();
	}, intervalMs);
	timer.unref?.();

	return () => clearInterval(timer);
}
