// Ações `browser.*` da porta `Sandbox` no worker (F8.1): leva cada kind do protocolo da capacidade `browser`
// (packages/agent/src/capabilities/browser/protocol.ts) ao control server da VM (`POST /browser/v4`, docker/agent-sandbox/control/browser-v4.mjs).
//
// Este módulo NÃO cria o adaptador `Sandbox`: a integração (frente A, `v4-adapters/sandbox.ts`) registra estes handlers por kind e
// resolve o dono do run → conversa → VM. Aqui só: validar o formato (não confiar no que chega), conferir a URL, escopar pelo dono e
// traduzir a resposta. O bloqueio de SSRF de verdade (DNS, IP privado, redirecionamento) mora na VM/adaptador da frente A.
import { BROWSER_KINDS, BROWSER_KIND_LIST, SUBMIT_INTENT_REQUIRED, checkPublicHttpUrl, type BrowserKind, type SandboxResult } from "@workspace/agent";
import { z } from "zod";

/** Chamada ao control server da VM do dono. Quem implementa resolve a VM pelo `userId` (nunca por dado do params). */
export type BrowserControlPost = (input: { userId: string; runId?: string; path: string; body: unknown; signal?: AbortSignal }) => Promise<unknown>;

export type BrowserActionInput = { userId: string; runId?: string; params: unknown; signal?: AbortSignal };
export type BrowserActionHandler = (input: BrowserActionInput) => Promise<SandboxResult>;

const section = z.string().regex(/^s\d{1,4}$/);
const exportId = z.string().regex(/^x[0-9a-z]{4,24}$/);
const ref = z.string().regex(/^(?:f\d{1,3})?[ae]\d{1,5}$/);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const publicUrl = z
	.string()
	.max(2000)
	.refine((value) => checkPublicHttpUrl(value).ok, "URL must be a public http(s) address");

/** Formato aceito por kind. `strictObject`: campo desconhecido falha (nada de repassar à VM o que ninguém declarou). */
export const BROWSER_PARAMS: Readonly<Record<BrowserKind, z.ZodType>> = {
	[BROWSER_KINDS.open]: z.strictObject({ url: publicUrl }),
	[BROWSER_KINDS.map]: z.strictObject({}),
	[BROWSER_KINDS.read]: z
		.strictObject({ section: section.optional(), export: exportId.optional(), from: int(1, 10_000_000).optional(), count: int(1, 200).optional(), itemChars: int(100, 20_000).optional() })
		.refine((p) => Boolean(p.section) !== Boolean(p.export), "give exactly one of section or export"),
	[BROWSER_KINDS.find]: z.strictObject({ query: z.string().trim().min(1).max(200), section: section.optional(), limit: int(1, 100).optional() }),
	[BROWSER_KINDS.act]: z.strictObject({ ref, action: z.enum(["click", "type", "select", "check", "uncheck", "hover", "press", "clear"]), intent: z.enum(["browse", "submit"]), text: z.string().max(4000).optional() }),
	[BROWSER_KINDS.loadMore]: z.strictObject({ section, times: int(1, 10).optional() }),
	[BROWSER_KINDS.wait]: z.strictObject({ for: z.enum(["text", "url", "network", "stable"]), value: z.string().max(200).optional(), timeoutMs: int(500, 20_000).optional() }),
	[BROWSER_KINDS.tabs]: z.strictObject({ action: z.enum(["list", "switch", "close"]), tabId: z.string().regex(/^\d{1,2}$/).optional() }),
	[BROWSER_KINDS.screenshot]: z.strictObject({ ref: ref.optional() }),
	[BROWSER_KINDS.export]: z.strictObject({ section, loadAll: z.boolean().optional() }),
};

type ControlAnswer = { ok?: unknown; data?: unknown; error?: unknown; code?: unknown };

function fail(error: string, code?: string): SandboxResult {
	return { ok: false, error, ...(code && { data: { code } }) };
}

/** Handlers por kind, prontos para o registro do adaptador `Sandbox` (um módulo, dez kinds). */
export function createBrowserActionHandlers(deps: { post: BrowserControlPost }): Record<BrowserKind, BrowserActionHandler> {
	const make = (kind: BrowserKind): BrowserActionHandler => async ({ userId, runId, params, signal }) => {
		const parsed = BROWSER_PARAMS[kind].safeParse(params ?? {});
		if (!parsed.success) return fail(`Invalid ${kind} request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}.`);
		let answer: ControlAnswer;
		try {
			answer = (await deps.post({ userId, ...(runId && { runId }), path: "/browser/v4", body: { kind, params: parsed.data }, ...(signal && { signal }) })) as ControlAnswer;
		} catch (error) {
			if (signal?.aborted) throw error;
			return fail(`The browser VM could not be reached: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (answer?.ok === true) return { ok: true, data: answer.data };
		const code = typeof answer?.code === "string" ? answer.code : undefined;
		return fail(typeof answer?.error === "string" && answer.error.length > 0 ? answer.error : "The browser VM refused the action without a reason.", code);
	};
	return Object.fromEntries(BROWSER_KIND_LIST.map((kind) => [kind, make(kind)])) as Record<BrowserKind, BrowserActionHandler>;
}

export { SUBMIT_INTENT_REQUIRED };
