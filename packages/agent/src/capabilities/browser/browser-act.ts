// `browser_act` (F8.1): clica, digita, marca, escolhe numa ref. O EFEITO é declarado pelo modelo num campo (`intent`), não
// deduzido de texto: `browse` (abrir, expandir, trocar de aba, paginar) é leitura; `submit` (enviar formulário, postar,
// comprar, assinar, apagar no site) é `write_external`: com leitura de conteúdo não confiável no run pede o dono, e sem
// dono (agenda) nem existe. A VM confere o contrário: ação que submete declarada como `browse` é recusada com a dica.
// Senha e código de uso único NUNCA são digitados pelo bot nem aparecem: a VM recusa e a tool manda pedir ao dono.
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { ACT_ACTIONS, ACT_INTENTS, BROWSER_KINDS, SUBMIT_INTENT_REQUIRED, actDataSchema, refId } from "./protocol.js";
import { BrowserCallError, callBrowser } from "./run-browser.js";

const inputSchema = z.object({
	ref: refId.describe("Ref of the element, from browser_map/browser_read/browser_find."),
	action: z.enum(ACT_ACTIONS).describe("click, type (needs text), select (needs text = the option), check, uncheck, hover, press (needs text = the key, like Enter), clear."),
	text: z.string().max(4000).optional().describe("Text to type, option to select or key to press."),
	intent: z.enum(ACT_INTENTS).describe('"browse" = only looks around (open a menu, expand, change tab, next page, fill a field without sending). "submit" = sends or changes something outside: submit a form, post, buy, subscribe, delete on the site.'),
	what: z.string().trim().min(1).max(200).optional().describe("With intent submit: what will be sent or changed, in one plain sentence. The owner reads it on the approval card."),
});

export function createBrowserActTool() {
	return defineTool({
		name: "browser_act",
		description:
			"Act on an element of the page by ref: click, type, select, check, press a key. Declare intent: browse for anything that only looks around, submit for anything that sends or changes something (with a sentence in what). " +
			"A submit asks the owner when the run read outside content. You never type passwords or one-time codes: the owner does that in the browser view. Do not use it to read (browser_read) or to buy with a saved card (checkout).",
		inputSchema,
		effect: "read",
		effectForArgs: (args) => (args.intent === "submit" ? "write_external" : "read"),
		riskFacts: (args) => (args.intent === "submit" ? { target: args.what ?? `${args.action} on the page`, irreversible: false } : {}),
		trust: "untrusted",
		source: "web",
		async execute({ ref, action, text, intent, what }, ctx) {
			if (intent === "submit" && !what) throw new Error("With intent submit, say what will be sent or changed in `what`. Hint: one plain sentence, like \"Post the comment 'Thanks!'\".");
			if ((action === "type" || action === "select" || action === "press") && (text === undefined || text.length === 0)) throw new Error(`The action ${action} needs text. Hint: ${action === "press" ? "the key, like Enter" : action === "select" ? "the option to pick" : "what to type"}.`);
			let result: z.output<typeof actDataSchema>;
			try {
				result = await callBrowser(ctx, BROWSER_KINDS.act, { ref, action, intent, ...(text !== undefined && { text }) }, actDataSchema);
			} catch (error) {
				if (error instanceof BrowserCallError && error.code === SUBMIT_INTENT_REQUIRED) throw new Error(`This action would send or change something on the site, so it was NOT done. Hint: call browser_act again with intent "submit" and say in \`what\` what will happen; the owner may be asked first.`);
				throw error;
			}
			if (result.needsOwner) {
				const what = result.needsOwner === "captcha" ? "a captcha" : result.needsOwner === "password" ? "a password field" : "a one-time code field";
				return { ok: true, summary: `Nothing was typed: this is ${what}. Only the owner can fill it, in the browser view. Ask the owner to do it and say when they are done, then call browser_map again.` };
			}
			return { ok: true, summary: `Done: ${action} on ${ref}. Now at ${result.url} (title: ${result.title || "none"}).${result.changes ? ` What changed: ${result.changes}` : ""}` };
		},
	});
}
