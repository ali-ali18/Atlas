// Porta `Sandbox`: VM e navegador. A ação e o resultado são opacos de propósito:
// o formato mora na capacidade e no adaptador, a porta só garante o canal,
// o escopo por dono e o cancelamento.

// `kind`s em uso (cada um documentado no módulo da capacidade que o possui): `card_fill` (shopping/payment), `browser.*`
// (capabilities/browser/protocol.ts), `code.*` (capabilities/code/kinds.ts) e `vault.login_fill`
// (capabilities/vault/kinds.ts: leva só o NOME do login; a senha é lida pelo tratador do worker e vai direto à VM) e
// `video.transcript` (capabilities/video/kinds.ts: legenda de vídeo lida na VM, uma página por chamada).
export type SandboxAction ={ kind: string; params: unknown };
export type SandboxResult = { ok: boolean; data?: unknown; error?: string };

export interface Sandbox {
	run(userId: string, action: SandboxAction, signal?: AbortSignal): Promise<SandboxResult>;
	/** Libera a sessão da VM/navegador do run. */
	release(userId: string, runId: string): Promise<void>;
}
