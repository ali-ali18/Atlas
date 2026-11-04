import type { ControlActResult, ControlPageState, ControlWaitParams } from "@workspace/sandbox";
import { z } from "zod";
import { redactSecrets } from "../../mcp/sanitize.js";
import { parseScrollValue } from "../browser-act.js";
import { formatAct } from "../computer-refs.js";
import { formatBrowserClick } from "../computer-changes.js";
import { defineTool } from "../define-tool.js";
import type { ToolContext } from "../registry/types.js";
import { derivePageState, formatPageState } from "./page-state.js";
import { checkTypeable, forgetRefs, noteSecretGuard, rememberLines } from "./ref-memory.js";
import { MAY_HAVE_HAPPENED, REF_PATTERN, ensureTab, isTimeoutError } from "./shared.js";

export const BROWSER_ACT_TOOL_NAME = "browser_act";
export const ACT_BATCH_MAX = 10;
export const ACT_VERBS = ["click", "type", "fill", "select", "press", "scroll", "hover", "upload", "wait"] as const;
const WAIT_FOR = ["text", "ref", "url", "network", "stable", "text_stable"] as const;

const actionSchema = z.object({
	do: z.enum(ACT_VERBS),
	ref: z.string().regex(REF_PATTERN).optional(),
	text: z.string().max(300).describe("click without ref: visible text").optional(),
	value: z.string().max(20_000).describe("fill/type/select text, press key, scroll down|up|top|bottom|pixels, upload file path, wait target").optional(),
	submit: z.boolean().describe("fill/type: press Enter after").optional(),
	for: z.enum(WAIT_FOR).describe("wait: what to wait for").optional(),
	ms: z.number().int().min(100).max(20_000).describe("wait: timeout").optional(),
});
type Action = z.output<typeof actionSchema>;

/** Valida o lote inteiro antes de executar qualquer ação (lote inválido não executa nada). */
export function validateBatch(actions: readonly Action[]): void {
	actions.forEach((action, index) => {
		const at = `Action ${index + 1} (${action.do})`;
		const need = (ok: boolean, what: string) => {
			if (!ok) throw new Error(`${at} needs ${what}.`);
		};
		switch (action.do) {
			case "click":
				need(Boolean(action.ref || action.text?.trim()), "a `ref` from browser_snapshot or the visible `text`");
				break;
			case "fill":
			case "type":
				need(Boolean(action.ref) && action.value !== undefined, "`ref` and `value`");
				break;
			case "select":
			case "press":
			case "upload":
				need(Boolean(action.ref) && Boolean(action.value), "`ref` and `value`");
				break;
			case "hover":
				need(Boolean(action.ref), "a `ref`");
				break;
			case "scroll":
				parseScrollValue(action.value);
				break;
			case "wait":
				if (action.for && ["text", "ref", "url"].includes(action.for)) need(Boolean(action.value?.trim()), "`value`");
				break;
		}
	});
}

/** Resultado de uma ação: linha curta e o que o servidor devolveu. */
type StepResult = { head: string; detail: string[]; navigated: boolean; pageState?: ControlPageState; url?: string; title?: string; /** Linhas com ref que a VM devolveu (elementos novos e diff da árvore): modal de login que abriu, por exemplo. */ lines?: string[]; secretGuard?: boolean };

async function runAction(action: Action, ctx: ToolContext, sessionId: string): Promise<StepResult> {
	const { manager } = ctx;
	switch (action.do) {
		case "click": {
			if (!action.ref) {
				const result = await manager.execBrowserClick(sessionId, { text: action.text!.trim() });
				const [head = "", ...detail] = formatBrowserClick(result).split("\n");
				return { head, detail, navigated: result.navigated === true, ...(result.url ? { url: result.url } : {}) };
			}
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref, action: "click" }), undefined);
		}
		case "fill":
		case "type": {
			const value = action.value ?? "";
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref!, action: "type", value, submit: action.submit === true, sequential: action.do === "type" }), value);
		}
		case "select":
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref!, action: "select", value: action.value! }), undefined);
		case "press":
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref!, action: "press", value: action.value! }), undefined);
		case "hover":
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref!, action: "hover" }), undefined);
		case "upload":
			return fromAct(await manager.execBrowserAct(sessionId, { ref: action.ref!, action: "upload", value: action.value! }), undefined);
		case "scroll": {
			const deltaY = parseScrollValue(action.value);
			const position = await manager.execScroll(sessionId, 0, deltaY);
			const where = typeof position?.scrollY === "number" ? `; position ${position.scrollY}${typeof position.scrollHeight === "number" ? `/${position.scrollHeight}` : ""}` : "";
			return { head: `Scrolled ${deltaY > 0 ? "down" : "up"} ${Math.abs(deltaY)} px${where}. Take a browser_snapshot to see what the scroll revealed.`, detail: [], navigated: false };
		}
		case "wait": {
			const kind = action.for ?? "stable";
			const result = await manager.execBrowserWait(sessionId, {
				for: kind as ControlWaitParams["for"],
				...(action.value ? { value: action.value } : {}),
				...(action.ms ? { timeoutMs: action.ms } : {}),
				...(kind === "text_stable" && action.ref ? { ref: action.ref } : {}),
			});
			if (!result.met) throw new Error(`Waiting for ${kind}${action.value ? ` ${JSON.stringify(action.value.slice(0, 60))}` : ""} did not finish (${result.reason ?? "timeout"}) after ${result.waitedMs} ms. Take a browser_snapshot to see the real state.`);
			const note = kind === "text_stable" ? (result.changed === false ? " The text did not change while waiting: if you expected an answer it may not have started." : " The text stopped changing: read it now.") : "";
			return { head: `Waited for ${kind} (${result.waitedMs} ms).${note}`, detail: [], navigated: false, url: result.url, title: result.title };
		}
	}
}

function fromAct(result: ControlActResult, requested: string | undefined): StepResult {
	const [head = "", ...detail] = formatAct(result, requested).split("\n");
	return { head, detail, navigated: result.navigated === true, lines: [...(result.newElements ?? []), ...(result.changes?.tree ?? [])], ...(result.secretGuard ? { secretGuard: true } : {}), ...(result.pageState ? { pageState: result.pageState } : {}), ...(result.url ? { url: result.url } : {}), ...(result.title ? { title: result.title } : {}) };
}

/** Linhas de aviso (verificação, erros de formulário) que valem mesmo no meio do lote. */
const KEEP_IN_MIDDLE = /^(?:Verification warning:|Validation errors|Navigated to|URL changed|Dialog opened)/;

/**
 * Lote de até 10 ações por ref (desenho 5). Para na primeira que falha, e o erro diz o que já foi feito e o que não
 * rodou. Depois do lote devolve o diff da última ação (o que mudou, refs novos) e o `page_state`. Timeout: a ação
 * pode ter acontecido, então manda olhar antes de repetir.
 */
export const browserActTool = defineTool({
	name: BROWSER_ACT_TOOL_NAME,
	description:
		"Act on the page by ref (from browser_snapshot), up to 10 actions in order in one call: click; fill (set a field's value; submit=true presses Enter); type (key by key, for autocomplete and chat boxes); select; press (key on a ref); scroll (no ref; value down|up|top|bottom|pixels); hover; upload (ref + a file in your work folder); wait (for text|ref|url|network|stable|text_stable, e.g. after sending a message to a chat before reading its answer). Click may use the visible `text` when you have no ref. Batch actions you are sure of (fill several fields, then click Send); it stops at the first failure and says what ran. The result reports the URL, field values, dialogs, new text and new refs, then page_state: act on it instead of re-reading the page. Never type passwords or codes: use login_fill or let the user log in. If a call times out the action may have happened: inspect before repeating.",
	input: z.object({
		actions: z.array(actionSchema).min(1).max(ACT_BATCH_MAX),
		tab: z.number().int().min(1).max(99).optional(),
	}),
	// Pior caso: `upload` entrega um arquivo da VM a um site de terceiro (write_external: sem humano nega, com humano pede
	// aprovação). O resto do navegador é da VM do próprio bot (write_internal); o catálogo usa o mais permissivo.
	effect: "write_external",
	catalogEffect: "write_internal",
	effectForArgs: (args) => (args.actions.some((action) => action.do === "upload") ? "write_external" : "write_internal"),
	group: "browser",
	run: async (args, ctx) => {
		validateBatch(args.actions);
		await ensureTab(ctx, args.tab);
		const sessionId = await ctx.getSessionId();
		// Fail-closed (2ª camada; a 1ª é a barreira da VM): nenhuma ação que digita (fill, type, select, press) em campo de
		// senha/código, nem em ref que nunca vimos quando a VM não declara a barreira.
		const typing = (action: Action) => (action.do === "fill" || action.do === "type" || action.do === "select" || action.do === "press") && action.ref !== undefined;
		const assertTypeable = (action: Action, index: number) => {
			if (!typing(action)) return;
			const check = checkTypeable(sessionId, action.ref!);
			if (check.ok) return;
			throw new Error(
				check.reason === "secret"
					? `Action ${index + 1}: ${action.ref} is a password or one-time-code field; nothing was done. Never type credentials: use login_fill for a saved login, or let the user log in through the login card.`
					: `Action ${index + 1}: ${action.ref} was not seen in a browser_snapshot of this page, so I cannot rule out a password field; nothing was done. Take a browser_snapshot and use a ref from it.`,
			);
		};
		args.actions.forEach(assertTypeable);
		const done: StepResult[] = [];
		let navigated = false;
		for (const [index, action] of args.actions.entries()) {
			try {
				// De novo na hora: um passo anterior do lote pode ter aberto um modal de login.
				assertTypeable(action, index);
				const step = await runAction(action, ctx, sessionId);
				done.push(step);
				noteSecretGuard(sessionId, step.secretGuard);
				if (step.lines?.length) rememberLines(sessionId, step.lines);
				if (step.navigated) {
					navigated = true;
					forgetRefs(sessionId);
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message.split("\n")[0]! : String(error);
				const timeout = isTimeoutError(error);
				const ran = done.map((step, at) => `${at + 1}. ${step.head}`);
				const rest = args.actions.length - index - 1;
				throw new Error(
					redactSecrets(
						[
							timeout ? `Action ${index + 1} (${action.do}) timed out: ${MAY_HAVE_HAPPENED}.` : `Action ${index + 1} (${action.do}) failed: ${reason}`,
							ran.length > 0 ? `Done before it:\n${ran.join("\n")}` : "Nothing ran before it.",
							rest > 0 ? `${rest} later action${rest === 1 ? "" : "s"} did not run.` : "",
						]
							.filter(Boolean)
							.join("\n"),
					),
				);
			}
		}
		const last = done[done.length - 1]!;
		const lines = done.map((step, index) => {
			const isLast = index === done.length - 1;
			const extra = isLast ? step.detail : step.detail.filter((line) => KEEP_IN_MIDDLE.test(line));
			return [`${done.length > 1 ? `${index + 1}. ` : ""}${step.head}`, ...extra].join("\n");
		});
		const state = formatPageState(derivePageState({ ...(last.url ? { url: last.url } : {}), ...(last.title ? { title: last.title } : {}), ...(last.pageState ? { fromServer: last.pageState } : {}) }));
		if (navigated) forgetRefs(sessionId);
		return { summary: redactSecrets(`${lines.join("\n")}${state ? `\n${state}` : ""}`) };
	},
});

