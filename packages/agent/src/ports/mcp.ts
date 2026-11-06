// Porta `Mcp`: conexões MCP do dono (e-mail, agenda, drive, ERP…) e a chamada de uma tool delas. A implementação
// real (cofre de segredos, cliente MCP, OAuth) é ligada pelo worker em outra etapa; o motor só conhece esta forma.
// REGRA: tudo é escopado pelo dono. `listConnections(userId)` devolve só as conexões dele (nunca as de todos) e
// `call` recusa conexão que não é do `userId`. Segredo nunca atravessa a porta: ela só devolve texto do resultado.
import type { McpConnectionStatus, McpToolInfo } from "@workspace/shared";

/** Foto de uma conexão para um run. Não leva segredo nem URL. */
export type McpConnectionSnapshot = {
	id: string;
	/** Dono da conexão. A capacidade descarta o que não for do dono do run (defesa em profundidade). */
	ownerId: string;
	/** Identificador curto e estável (`gmail`, `minha-agenda`). Vira parte do nome das tools. */
	slug: string;
	/** Nome para o usuário. */
	name: string;
	/** Id do catálogo (`gmail`) ou `null` para conector personalizado. */
	catalogId: string | null;
	status: McpConnectionStatus;
	/** O dono quer cartão antes de qualquer escrita neste conector. */
	confirmWrites: boolean;
	tools: readonly McpToolInfo[];
	disabledTools: readonly string[];
	/** Marcação do dono por tool ("read" | "write"); só vale para tool sem anotação do servidor. */
	toolMarks?: Readonly<Record<string, "read" | "write">>;
};

export type McpCallResult = { ok: true; text: string } | { ok: false; error: string };

export interface Mcp {
	listConnections(userId: string, signal?: AbortSignal): Promise<readonly McpConnectionSnapshot[]>;
	call(userId: string, connectionId: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/** Nome da porta como o plano a chama. */
export type McpPort = Mcp;
