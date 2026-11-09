// `browser_export` (F8.1): salva o conteúdo COMPLETO de uma seção num arquivo da VM (pasta de trabalho do dono), carregando
// mais quando pedido. Volume grande não passa pela janela do modelo: o arquivo é lido em blocos por ajudantes (`browser_digest`).
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { BROWSER_KINDS, EXPORT_MAX_ROUNDS, exportDataSchema, sectionId } from "./protocol.js";
import { callBrowser } from "./run-browser.js";

export const exportInputSchema = z.object({
	section: sectionId.describe("Section id from browser_map."),
	loadAll: z.boolean().optional().describe("Keep loading more until the page has no more (or the time limit) before saving. Default false: saves what is loaded now."),
});

export function describeExport(data: z.output<typeof exportDataSchema>): string {
	const stop = { not_requested: "", end: " Loaded until the page had no more.", limit: ` Stopped at the loading limit (${EXPORT_MAX_ROUNDS} rounds): the page may have more, call again to continue.`, stalled: " Stopped because the page stopped giving new items: it may have more that this browser cannot load." }[data.stoppedBy];
	const total = data.declaredTotal !== null && data.declaredTotal > data.items ? ` The page declares ~${data.declaredTotal}.` : "";
	return `Saved ${data.items} item(s) (${data.chars} characters) of ${data.section} to ${data.path} (export ${data.exportId}).${total}${stop}`;
}

export function createBrowserExportTool() {
	return defineTool({
		name: "browser_export",
		description:
			"Save the whole content of a section to a file in the VM, optionally loading everything first. Use it when the content is too big to read in the chat and you want it kept (a long thread, a big table). " +
			"To get an answer out of it, use browser_digest instead, which saves and reads it in blocks. Do not use it for a short list: browser_read is enough.",
		inputSchema: exportInputSchema,
		effect: "read",
		trust: "untrusted",
		source: "web",
		async execute({ section, loadAll }, ctx) {
			const data = await callBrowser(ctx, BROWSER_KINDS.export, { section, loadAll: loadAll === true }, exportDataSchema);
			return { ok: true, summary: describeExport(data) };
		},
	});
}
