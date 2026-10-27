import Docker from "dockerode";
import type { SandboxRuntimeConfig } from "./config.js";
import { createSandboxManager, SANDBOX_STOP_TIMEOUT_S } from "./docker-manager.js";
import { probeSandboxIdleMs } from "./reaper-probe.js";
import { runMemoryGuard, type MemoryGuardDeps } from "./memory-guard.js";
import { listAllSessionsForCleanup as listSessions } from "./session-store.js";
import { loadCodeRunnerConfig } from "./code-runner/config.js";
import { reapCodeRunnerContainers } from "./code-runner/executor.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const SANDBOX_LABEL = "atlas.sandbox";

export { probeSandboxIdleMs };

/** Órfãos (fora do store deste processo): só dorme o que está comprovadamente ocioso; remove velhos além do hardTtl. */
export async function reapOrphanContainers(
	docker: Docker,
	config: SandboxRuntimeConfig,
	known: Set<string>,
	options: { ttlMs: number; hardTtlMs: number; now?: number; probe?: typeof probeSandboxIdleMs; idleStop?: boolean },
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

		// Sem idleStop (padrão) a VM ligada fica ligada: quem decide parar é o usuário, o bot ou o guarda de memória.
		if (options.idleStop && ageMs > options.ttlMs && container.State === "running") {
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
	options: {
		ttlMs?: number;
		hardTtlMs?: number;
		intervalMs?: number;
		/** Para VMs ociosas após `ttlMs`. Desligado por padrão (o login vive na VM; ver SANDBOX_IDLE_STOP). */
		idleStop?: boolean;
		/** Guarda de memória/contagem: para a VM ociosa há mais tempo e avisa o dono. */
		memoryGuard?: Pick<MemoryGuardDeps, "notify" | "limits" | "isProtected">;
	} = {},
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

	const idleStop = options.idleStop ?? false;

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
		await reapOrphanContainers(docker, config, known, { ttlMs, hardTtlMs, idleStop });
	};

	const reap = async (): Promise<void> => {
		if (config.enabled) {
			if (idleStop) await reapInMemory();
			await reapOrphans();
			if (options.memoryGuard) await runMemoryGuard(docker, config, options.memoryGuard);
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
