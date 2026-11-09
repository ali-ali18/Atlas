// Chamada à VM: uma ação da porta `Sandbox`, escopada pelo dono do run, com a resposta validada pelo schema do protocolo.
// Falha da VM vira erro com o motivo real (a tool devolve `ok:false`), nunca sucesso com texto de erro.
import type { z } from "zod";
import type { SandboxAction } from "../../ports/sandbox.js";
import type { ToolContext } from "../../tools/types.js";
import type { BrowserKind } from "./protocol.js";

/** Falha da VM com o código estruturado que ela devolveu em `data.code` (o chamador decide por ele, nunca pelo texto). */
export class BrowserCallError extends Error {
	constructor(message: string, readonly code?: string) {
		super(message);
	}
}

export async function callBrowser<S extends z.ZodType>(ctx: ToolContext, kind: BrowserKind, params: Record<string, unknown>, schema: S): Promise<z.output<S>> {
	const action: SandboxAction = { kind, params };
	let result: Awaited<ReturnType<ToolContext["ports"]["sandbox"]["run"]>>;
	try {
		result = await ctx.ports.sandbox.run(ctx.ownerId, action, ctx.signal);
	} catch (error) {
		if (ctx.signal?.aborted) throw error;
		throw new Error(`The browser could not be reached: ${error instanceof Error ? error.message : String(error)}. Hint: try once more; if it keeps failing, tell the owner the browser is unavailable.`);
	}
	if (!result.ok) {
		const code = typeof result.data === "object" && result.data !== null && typeof (result.data as { code?: unknown }).code === "string" ? (result.data as { code: string }).code : undefined;
		throw new BrowserCallError(result.error && result.error.length > 0 ? result.error : "The browser refused the action without a reason.", code);
	}
	const parsed = schema.safeParse(result.data);
	if (!parsed.success) throw new Error(`The browser answered in an unexpected format for ${kind} (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}). Hint: try again; the page itself was not changed by this.`);
	return parsed.data;
}
