import type Docker from "dockerode";
import type { SandboxRuntimeConfig } from "./config.js";
import { resolveSandboxEndpoint } from "./docker-manager.js";

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
