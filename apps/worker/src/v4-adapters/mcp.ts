// Porta `Mcp` do v4 no worker (F2.6) sobre as conexões MCP do dono e o cliente MCP do v2 (`@workspace/agent-runtime`:
// cofre, OAuth, pool, redação de segredo). O pacote `@workspace/agent` não importa isso; o worker injeta.
//
// Escopo: a porta é montada POR RUN com o dono (e opcionalmente o bot) preso. `listConnections` devolve só as conexões
// conectadas do dono do run (o db filtra por `ownerIds`) e `call` recusa outro `userId` e conexão que não está nessa lista.
// Rotina/webhook/follow-up (`unattended`): o runtime do v2 só expõe tools de leitura com decisão `allow`, então escrita
// em conector é impossível sem o dono presente (regra de `40-seguranca.md`). Segredo nunca atravessa a porta: o runtime
// já redige o que devolve e o erro passa de novo por `sanitizeErrorMessage`.
import type { Mcp, McpCallResult, McpConnectionSnapshot } from "@workspace/agent";
import { listConnectedMcpConnections } from "@workspace/db";
import type { McpRuntime, McpRuntimeOptions } from "@workspace/agent-runtime";
import { sanitizeErrorMessage } from "@workspace/shared";

type ConnectedRecord = Awaited<ReturnType<typeof listConnectedMcpConnections>>[number];

export type V4McpDeps = {
	listConnected: (userId: string) => Promise<ConnectedRecord[]>;
	loadRuntime: (options: McpRuntimeOptions) => Promise<McpRuntime | null>;
};

// O pacote do v2 é pesado: só carrega na primeira chamada de tool (e os testes unitários nem o tocam).
export const realV4McpDeps: V4McpDeps = {
	listConnected: listConnectedMcpConnections,
	loadRuntime: async (options) => (await import("@workspace/agent-runtime")).loadMcpRuntime(options),
};

export type V4McpScope = {
	ownerId: string;
	/** Rotina, webhook e follow-up: só leitura. */
	unattended: boolean;
	botId?: string | null;
	botName?: string | null;
	conversationId?: string | null;
};

/** Nada foi enviado ao GitHub: o app não está instalado (ou sem permissão) no repositório. Sem promessa de cartão. */
export function githubIdentityError(repo: string | null): string {
	return `Nothing was sent: the GitHub app is not installed on ${repo ?? "this repository"} or lacks permission there. Tell the owner to install it in Settings → Connections → GitHub, then ask again. Do not retry another way and never ask for a token.`;
}

const OTHER_OWNER = "This app belongs to another owner.";

export function snapshotOf(record: ConnectedRecord, ownerId: string): McpConnectionSnapshot {
	return {
		id: record.id,
		ownerId,
		slug: record.slug,
		name: record.name,
		catalogId: record.catalogId,
		status: record.status,
		confirmWrites: record.confirmWrites,
		tools: record.tools,
		disabledTools: record.disabledTools,
		...(record.toolMarks && { toolMarks: record.toolMarks }),
	};
}

export function createV4Mcp(input: { scope: V4McpScope; deps?: V4McpDeps }): Mcp {
	const deps = input.deps ?? realV4McpDeps;
	const { scope } = input;
	// O runtime abre o cofre e monta o catálogo: só na primeira chamada de tool (listar não precisa).
	let runtime: Promise<McpRuntime | null> | undefined;
	const getRuntime = () =>
		(runtime ??= deps.loadRuntime({
			userId: scope.ownerId,
			unattended: scope.unattended,
			...(scope.botId && { botId: scope.botId }),
			...(scope.botName && { botName: scope.botName }),
			...(scope.conversationId && { conversationId: scope.conversationId }),
		}));

	return {
		async listConnections(userId) {
			if (userId !== scope.ownerId) return [];
			return (await deps.listConnected(userId)).map((record) => snapshotOf(record, userId));
		},
		async call(userId, connectionId, toolName, args, signal): Promise<McpCallResult> {
			if (userId !== scope.ownerId) return { ok: false, error: OTHER_OWNER };
			try {
				const loaded = await getRuntime();
				if (!loaded) return { ok: false, error: "The connected apps are not available right now. Tell the owner plainly." };
				let exposed: string | undefined;
				for (const [name, entry] of loaded.toolset.entries) {
					if (entry.connectionId === connectionId && entry.toolName === toolName) {
						exposed = name;
						break;
					}
				}
				if (!exposed) {
					return { ok: false, error: scope.unattended ? `"${toolName}" is not available in a run without the owner: only reading is allowed.` : `"${toolName}" is not available for this app (unknown, turned off or blocked by the owner's settings).` };
				}
				const result = await loaded.call(exposed, args, signal);
				// Bloqueio de identidade do GitHub: o texto legado (pt-BR) promete um cartão que o v4 não mostra. Erro honesto em inglês.
				if (result.githubIdentity) return { ok: false, error: githubIdentityError(result.githubIdentity.repo) };
				// O texto do runtime já vem redigido; passa de novo (defesa em profundidade) antes de ir ao modelo.
				return result.ok ? { ok: true, text: sanitizeErrorMessage(result.text, [], Number.MAX_SAFE_INTEGER) } : { ok: false, error: sanitizeErrorMessage(result.text) };
			} catch (error) {
				return { ok: false, error: sanitizeErrorMessage(error) };
			}
		},
	};
}
