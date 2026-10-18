import { loadDevSandboxConfig } from "@workspace/sandbox";

/** Sessões de código ligadas neste servidor (`DEV_SANDBOX_ENABLED`). Lido do ambiente a cada chamada (barato). */
export function devSessionsEnabled(): boolean {
	try {
		return loadDevSandboxConfig().enabled;
	} catch {
		return false;
	}
}
