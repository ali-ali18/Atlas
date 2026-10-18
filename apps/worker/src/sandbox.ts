/**
 * Ponto de extensão para jobs computer-use no worker.
 * Hoje o lifecycle é acionado pela API (`POST /v1/sandbox/sessions`).
 *
 * TODO: job `sandbox.navigate` / ferramentas invocadas durante `chat.completion`.
 */
import { createSandboxManager, loadSandboxConfig } from "@workspace/sandbox";

export function getWorkerSandboxManager(userId: string) {
	return createSandboxManager(loadSandboxConfig(), userId);
}
