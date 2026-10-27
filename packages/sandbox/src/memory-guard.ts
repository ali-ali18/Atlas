import { readFileSync } from "node:fs";
import { freemem } from "node:os";
import type Docker from "dockerode";
import type { SandboxRuntimeConfig } from "./config.js";
import { SANDBOX_STOP_TIMEOUT_S } from "./docker-manager.js";
import { probeSandboxIdleMs } from "./reaper-probe.js";

export const DEFAULT_MAX_RUNNING = 3;
export const DEFAULT_MIN_FREE_MEM_MB = 512;
/** VM com ferramenta nos últimos 2 min é considerada em uso: nunca é candidata. */
export const MIN_IDLE_FOR_MEMORY_STOP_MS = 2 * 60 * 1000;

export type RunningVm = {
	id: string;
	name: string;
	userId: string;
	conversationId?: string;
	/** Há quanto tempo o control server não recebe ferramenta; null = não deu para saber. */
	idleMs: number | null;
};

export type MemoryGuardLimits = {
	/** Máximo de VMs ligadas ao mesmo tempo (0 = sem limite). */
	maxRunning: number;
	/** Memória disponível mínima do servidor, em bytes (0 = sem checar). */
	minFreeBytes: number;
};

/** Lê limites do ambiente. Valor inválido cai no padrão; 0 desliga o limite. */
export function loadMemoryGuardLimits(env: NodeJS.ProcessEnv = process.env): MemoryGuardLimits {
	const maxRunning = Number.parseInt(env.SANDBOX_MAX_RUNNING ?? "", 10);
	const minFreeMb = Number.parseInt(env.SANDBOX_MIN_FREE_MEM_MB ?? "", 10);
	return {
		maxRunning: Number.isFinite(maxRunning) && maxRunning >= 0 ? maxRunning : DEFAULT_MAX_RUNNING,
		minFreeBytes: (Number.isFinite(minFreeMb) && minFreeMb >= 0 ? minFreeMb : DEFAULT_MIN_FREE_MEM_MB) * 1024 * 1024,
	};
}

/**
 * Quais VMs parar agora. Só VMs comprovadamente ociosas (idleMs conhecido e acima do mínimo),
 * da mais parada para a menos (LRU). Acima de `maxRunning` para o excedente; com pouca memória
 * disponível para uma por rodada (o efeito aparece na próxima leitura).
 */
export function pickVmsToStop(
	vms: RunningVm[],
	limits: MemoryGuardLimits,
	availableMemBytes: number | null,
	minIdleMs: number = MIN_IDLE_FOR_MEMORY_STOP_MS,
): RunningVm[] {
	const overflow = limits.maxRunning > 0 ? Math.max(0, vms.length - limits.maxRunning) : 0;
	const lowMemory = limits.minFreeBytes > 0 && availableMemBytes !== null && availableMemBytes < limits.minFreeBytes;
	const wanted = Math.max(overflow, lowMemory ? 1 : 0);
	if (wanted === 0) return [];
	const idle = vms
		.filter((vm): vm is RunningVm & { idleMs: number } => vm.idleMs !== null && vm.idleMs >= minIdleMs)
		.sort((a, b) => b.idleMs - a.idleMs);
	return idle.slice(0, wanted);
}

/** Memória realmente disponível (MemAvailable inclui cache liberável); cai em os.freemem(). */
export function readAvailableMemBytes(readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): number | null {
	try {
		const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFile("/proc/meminfo"));
		if (match) return Number.parseInt(match[1]!, 10) * 1024;
	} catch {
		// sem /proc (macOS/Windows): usa o que o Node informa.
	}
	try {
		return freemem();
	} catch {
		return null;
	}
}

export type MemoryGuardDeps = {
	limits?: MemoryGuardLimits;
	availableMemBytes?: () => number | null;
	probe?: typeof probeSandboxIdleMs;
	/** Avisa o dono ANTES de parar (push). Falha aqui não impede a parada. */
	notify?: (vm: RunningVm) => Promise<void>;
};

/** Uma rodada do guarda: lista VMs ligadas, escolhe as ociosas a parar, avisa o dono e para com graça. */
export async function runMemoryGuard(
	docker: Docker,
	config: SandboxRuntimeConfig,
	deps: MemoryGuardDeps = {},
): Promise<RunningVm[]> {
	const limits = deps.limits ?? loadMemoryGuardLimits();
	if (limits.maxRunning === 0 && limits.minFreeBytes === 0) return [];
	let containers: Awaited<ReturnType<Docker["listContainers"]>>;
	try {
		containers = await docker.listContainers({ all: false, filters: { label: ["atlas.sandbox=true"], status: ["running"] } });
	} catch (error) {
		console.error("[sandbox-memory-guard] docker list failed", error);
		return [];
	}
	const probe = deps.probe ?? probeSandboxIdleMs;
	const vms: RunningVm[] = await Promise.all(
		containers.map(async (c) => ({
			id: c.Id,
			name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
			userId: c.Labels?.["atlas.sandbox.userId"] ?? "",
			conversationId: c.Labels?.["atlas.sandbox.conversationId"],
			idleMs: await probe(docker, config, c.Id),
		})),
	);
	const available = (deps.availableMemBytes ?? readAvailableMemBytes)();
	const victims = pickVmsToStop(vms, limits, available);
	for (const vm of victims) {
		try {
			await deps.notify?.(vm);
		} catch (error) {
			console.error("[sandbox-memory-guard] notify failed", error instanceof Error ? error.message : "erro");
		}
		try {
			console.log(`[sandbox-memory-guard] stopping idle ${vm.name} idleMs=${vm.idleMs} running=${vms.length} availableMem=${available ?? "?"}`);
			await docker.getContainer(vm.id).stop({ t: SANDBOX_STOP_TIMEOUT_S });
		} catch (error) {
			console.error("[sandbox-memory-guard] failed to stop", error);
		}
	}
	return victims;
}
