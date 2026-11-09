// Ações `browser.*` (F8.1) no despachante da porta `Sandbox`: cada kind do protocolo vira um `SandboxKindHandler` que leva a ação
// ao control server da VM da conversa (`POST /browser/v4`, via `manager.execBrowserV4`). A validação do formato e a tradução da
// resposta são de `browser-actions.ts`; aqui só se liga a sessão já resolvida (usuário + conversa) a ele.
import { BROWSER_KIND_LIST, type BrowserKind } from "@workspace/agent";
import { createBrowserActionHandlers } from "./browser-actions.js";
import type { SandboxKindHandler } from "./sandbox.js";

const handlerFor = (kind: BrowserKind): SandboxKindHandler => (ctx, params) =>
	createBrowserActionHandlers({
		post: async ({ body }) => ctx.manager.execBrowserV4(ctx.sessionId, body as { kind: string; params: unknown }),
	})[kind]({ userId: ctx.userId, runId: ctx.runId, params, ...(ctx.signal && { signal: ctx.signal }) });

export const browserKindHandlers: Readonly<Record<string, SandboxKindHandler>> = Object.fromEntries(BROWSER_KIND_LIST.map((kind) => [kind, handlerFor(kind)]));
