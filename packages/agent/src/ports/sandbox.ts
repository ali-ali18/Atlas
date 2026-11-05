// Porta `Sandbox`: VM e navegador. A ação e o resultado são opacos de propósito:
// o formato mora na capacidade e no adaptador, a porta só garante o canal,
// o escopo por dono e o cancelamento.

export type SandboxAction = { kind: string; params: unknown };
export type SandboxResult = { ok: boolean; data?: unknown; error?: string };

export interface Sandbox {
	run(userId: string, action: SandboxAction, signal?: AbortSignal): Promise<SandboxResult>;
	/** Libera a sessão da VM/navegador do run. */
	release(userId: string, runId: string): Promise<void>;
}
