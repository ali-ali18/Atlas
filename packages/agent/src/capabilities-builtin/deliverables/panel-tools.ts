// Ler, listar, atualizar e compartilhar painéis (F9). Mesma capacidade lazy `deliverables`; sem `CapabilityId` novo.
// O painel é do dono (escopo vem do run). Atualizar mantém o MESMO `pageId` (o cartão troca no lugar, a revisão sobe).
import { PAGE_MAX_JSON_CHARS, applyPagePatch, outlinePageSpec, parsePagePatchOps, parsePageSpec, summarizePageSpec, type PageSpec } from "@workspace/shared";
import { z } from "zod";
import type { PageStore } from "../../ports/deliverables.js";
import { defineTool } from "../../tools/define-tool.js";

const READ_FULL_MAX_CHARS = 20_000;
const notFound = (panelId: string) => new Error(`Panel ${panelId} not found. Use panel_list to see this owner's panels.`);

const panelId = z.string().trim().min(1).max(200).describe("Panel id from create_page's receipt or panel_list.");

export function createPanelListTool(pages: PageStore) {
	return defineTool({
		name: "panel_list",
		description:
			"List the owner's panels for this bot (id, title, revision, last update). Use to find the panel the owner means before reading or changing it, or to avoid creating a duplicate. Do not use to show a panel to the owner (the chat already shows it).",
		inputSchema: z.object({}),
		effect: "read",
		privateData: true,
		ownerData: "file",
		async execute(_args, ctx) {
			const items = await pages.list(ctx.ownerId);
			if (items.length === 0) return { ok: true, summary: "This bot has no panels yet." };
			const lines = items.map((item) => `- ${item.id}: "${item.title}"${item.groupName ? ` [group: ${item.groupName}]` : ""} (revision ${item.revision}, updated ${item.updatedAt})${item.summary ? ` ${item.summary}` : ""}`);
			return { ok: true, summary: `${items.length} panel${items.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
		},
	});
}

export function createPanelReadTool(pages: PageStore) {
	return defineTool({
		name: "panel_read",
		description:
			"Read one of the owner's panels by id: the node ids and the content, to change only part of it with panel_update. Use when you need the current node ids before panel_update. Do not use just to show the panel to the owner (the chat already shows it).",
		inputSchema: z.object({ panel_id: panelId }),
		effect: "read",
		// É dado do próprio dono, escrito por este bot: privado, mas não vem de terceiro.
		privateData: true,
		ownerData: "file",
		async execute({ panel_id }, ctx) {
			const page = await pages.read(ctx.ownerId, panel_id);
			if (!page) throw notFound(panel_id);
			const json = JSON.stringify({ title: page.spec.title, summary: page.spec.summary, palette: page.spec.palette, root: page.spec.root });
			const head = `Panel ${page.id}, revision ${page.revision}, ${page.sourceCount} sources, public link ${page.shared ? "ON" : "OFF"}. ${summarizePageSpec(page.spec)}.\nNode ids:\n${outlinePageSpec(page.spec)}`;
			if (json.length > READ_FULL_MAX_CHARS) return { ok: true, summary: `${head}\n(The full content is too large to print; use the ids above with panel_update ops.)` };
			return { ok: true, summary: `${head}\nContent: ${json}` };
		},
	});
}

export function createPanelUpdateTool(pages: PageStore) {
	return defineTool({
		name: "panel_update",
		description:
			"Update one of the owner's panels IN PLACE (same card in the chat, revision + 1). Pass `ops` to change only some nodes by id (op: replace | insert_after | append_child | remove, with id and node; insert_after without id appends to the root), or `spec` to rewrite the whole panel ({ v: 2, title, summary?, palette?, root }); `title` and `summary` can also change on their own. Use when the owner asks to change, extend or refresh a panel (get node ids from panel_read first). Do not use to create another panel for the same subject. Refreshed numbers must come from tools, never invented. Unknown fields are rejected with the accepted list.",
		inputSchema: z.object({
			panel_id: panelId,
			ops: z.array(z.record(z.string(), z.unknown())).min(1).max(50).optional().describe("Partial changes by node id."),
			spec: z.record(z.string(), z.unknown()).optional().describe("Full replacement of the panel spec."),
			title: z.string().trim().min(1).max(120).optional(),
			summary: z.string().trim().max(400).optional(),
		}),
		effect: "write_internal",
		riskFacts: ({ panel_id }) => ({ target: panel_id }),
		async execute({ panel_id, ops, spec, title, summary }, ctx) {
			if (ops && spec) throw new Error("Pass either `ops` (partial change) or `spec` (full rewrite), not both.");
			if (!ops && !spec && title === undefined && summary === undefined) throw new Error("Nothing to update: pass `ops`, `spec`, `title` or `summary`.");
			if (spec && JSON.stringify(spec).length > PAGE_MAX_JSON_CHARS) throw new Error(`Panel spec is too large (max ${PAGE_MAX_JSON_CHARS} characters). Split it into several panels.`);
			const parsedOps = ops ? parsePagePatchOps(ops) : null;
			if (parsedOps && !parsedOps.ok) throw new Error(`Invalid panel: ${parsedOps.error}. Fix the panel and call the tool again.`);
			// Uma releitura se outro update ganhou a corrida entre a leitura e a gravação.
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const current = await pages.read(ctx.ownerId, panel_id);
				if (!current) throw notFound(panel_id);
				let base: PageSpec = current.spec;
				if (parsedOps?.ok) {
					const patched = applyPagePatch(base, parsedOps.ops);
					if (!patched.ok) throw new Error(`Invalid panel: ${patched.error}. Fix the panel and call the tool again.`);
					base = patched.spec;
				}
				const next = spec ?? base;
				const parsed = parsePageSpec({ ...next, v: 2, ...(title !== undefined && { title }), ...(summary !== undefined && { summary }) });
				if (!parsed.ok) throw new Error(`Invalid panel spec: ${parsed.error}`);
				const result = await pages.update(ctx.ownerId, ctx.runId, panel_id, parsed.spec, current.revision);
				if (!result.ok && result.error === "conflict" && attempt === 0) continue;
				if (!result.ok) throw result.error === "conflict" ? new Error("The panel changed while updating. Call panel_read and try again.") : notFound(panel_id);
				return {
					ok: true,
					summary: `Panel updated in place (panel_id ${result.id}, revision ${result.revision}). ${summarizePageSpec(parsed.spec)}. The chat already shows the panel as a card: do not repeat its content; reply in one short line.`,
					receipt: { what: `Updated panel ${result.title}`, where: result.title, externalId: result.id },
				};
			}
			throw new Error("The panel changed while updating. Call panel_read and try again.");
		},
	});
}

export function createPanelShareTool(pages: PageStore) {
	return defineTool({
		name: "panel_share",
		description:
			"Create the PUBLIC read-only link of one of the owner's panels (or rotate it: the old link stops working). Anyone with the link sees the panel and its future updates, no login. The owner approves every call. Use when the owner asks to share a panel through a link or to get a new link, and only then. Do not use on your own initiative, to export or send a file, or for a panel the owner did not name. Give the owner the URL and say anyone with the link can see it; the address is shown only once.",
		inputSchema: z.object({ panel_id: panelId }),
		effect: "public_link",
		// Link público sempre pede o dono (mesmo em autonomia total); sem dono presente a tool fica fora.
		confirm: "always",
		riskFacts: () => ({ target: "public link to a panel" }),
		async enrichRiskFacts({ panel_id }, base, ctx) {
			const page = await pages.read(ctx.ownerId, panel_id);
			return page ? { ...base, target: `public link to panel "${page.title}"` } : base;
		},
		async execute({ panel_id }, ctx) {
			const page = await pages.read(ctx.ownerId, panel_id);
			if (!page) throw notFound(panel_id);
			const shared = await pages.share(ctx.ownerId, panel_id);
			if (!shared) throw notFound(panel_id);
			return {
				ok: true,
				// O endereço (que é a credencial de leitura) vai só no resumo para o dono; o recibo não o guarda.
				summary: `Public link created for "${page.title}": ${shared.url}\nShow this URL to the owner now (it is not shown again; creating again replaces it and the old one stops working) and say that anyone with the link sees this panel and its updates. They can turn it off by asking you.`,
				receipt: { what: `Public link for panel ${page.title}`, where: page.title, externalId: panel_id },
			};
		},
	});
}

export function createPanelUnshareTool(pages: PageStore) {
	return defineTool({
		name: "panel_unshare",
		description:
			"Turn off the public link of one of the owner's panels: the old address stops working. Use when the owner asks to stop sharing a panel or to turn its link off. Do not use to rotate the link (panel_share does that).",
		inputSchema: z.object({ panel_id: panelId }),
		effect: "write_internal",
		riskFacts: () => ({ target: "public link of a panel" }),
		async execute({ panel_id }, ctx) {
			const page = await pages.read(ctx.ownerId, panel_id);
			if (!page) throw notFound(panel_id);
			const revoked = await pages.unshare(ctx.ownerId, panel_id);
			if (revoked === null) throw notFound(panel_id);
			if (!revoked) return { ok: true, summary: `"${page.title}" had no active public link; nothing to turn off.` };
			return {
				ok: true,
				summary: `Public link of "${page.title}" turned off: the old address no longer works. Tell the owner in one short line.`,
				receipt: { what: `Turned off public link of panel ${page.title}`, where: page.title, externalId: panel_id },
			};
		},
	});
}
