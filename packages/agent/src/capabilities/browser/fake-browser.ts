// Fake tipado do `Sandbox` para a capacidade `browser`: uma "VM" em memória que fala o protocolo `browser.*` com a MESMA
// semântica da VM real (mapa, partes numeradas, busca, carregar mais, export). Serve aos testes, ao `--simulate` da matriz
// de evals v4 e ao `browser-bench --dry`. Um teste da VM real (`browser-v4.test.mjs`) cobre as mesmas regras.
import type { Sandbox, SandboxAction, SandboxResult } from "../../ports/sandbox.js";
import { BROWSER_KINDS, ITEM_DEFAULT_CHARS, PART_MAX_CHARS, SUBMIT_INTENT_REQUIRED, type MapSection } from "./protocol.js";

export type FakeControl = { ref: string; name: string; kind: "button" | "link" | "submit" | "password" | "otp" | "field" };
export type FakeSection = {
	id: string;
	kind: MapSection["kind"];
	label: string;
	/** Tudo o que a página tem (mesmo o que ainda não foi carregado). */
	all: string[];
	loaded: number;
	/** Quantos itens cada "carregar mais" traz. 0 = não tem como carregar. */
	batch: number;
	declaredTotal: number | null;
	controls?: FakeControl[];
};
export type FakePage = { url: string; title: string; sections: FakeSection[]; wall?: "captcha" | "blocked"; poorTree?: boolean };

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A mesma regra da VM: itens a partir de `from`, no máximo `count`, parando antes de passar da janela (sempre ao menos um). */
export function planPart(texts: readonly string[], input: { from: number; count: number; itemChars: number; maxChars?: number }) {
	const maxChars = input.maxChars ?? PART_MAX_CHARS;
	const items: Array<{ n: number; text: string; clippedChars?: number }> = [];
	let used = 0;
	for (let n = input.from; n <= texts.length && items.length < input.count; n++) {
		const full = texts[n - 1] ?? "";
		const text = full.length > input.itemChars ? full.slice(0, input.itemChars) : full;
		if (items.length > 0 && used + text.length > maxChars) break;
		used += text.length;
		items.push({ n, text, ...(full.length > text.length && { clippedChars: full.length - text.length }) });
	}
	const to = items.length > 0 ? items[items.length - 1]!.n : 0;
	return { items, to, nextFrom: to > 0 && to < texts.length ? to + 1 : null };
}

export class FakeBrowser implements Sandbox {
	readonly actions: Array<{ userId: string; action: SandboxAction }> = [];
	readonly released: Array<{ userId: string; runId: string }> = [];
	/** Saída de `browser.read`, em caracteres, por chamada (para medir o que o modelo recebeu). */
	readonly sent: string[] = [];
	private current: FakePage | undefined;
	private readonly pages = new Map<string, FakePage>();
	private readonly exports = new Map<string, { section: string; label: string; items: string[]; declaredTotal: number | null }>();
	private exportSeq = 0;
	/** Controles que o fake já submeteu (para o teste ver que nada foi enviado sem aprovação). */
	readonly submitted: string[] = [];
	/** Falha a próxima chamada do `kind` com este erro (uma vez). */
	failNext = new Map<string, string>();

	constructor(pages: readonly FakePage[] = []) {
		for (const page of pages) this.addPage(page);
	}
	addPage(page: FakePage) {
		this.pages.set(page.url, structuredClone(page));
	}
	get page(): FakePage | undefined {
		return this.current;
	}

	async run(userId: string, action: SandboxAction): Promise<SandboxResult> {
		this.actions.push({ userId, action });
		const failure = this.failNext.get(action.kind);
		if (failure) {
			this.failNext.delete(action.kind);
			return { ok: false, error: failure };
		}
		try {
			return { ok: true, data: this.handle(action.kind, (action.params ?? {}) as Record<string, unknown>) };
		} catch (error) {
			const code = (error as { code?: string }).code;
			return { ok: false, error: error instanceof Error ? error.message : String(error), ...(code && { data: { code } }) };
		}
	}
	async release(userId: string, runId: string) {
		this.released.push({ userId, runId });
	}

	private need(): FakePage {
		if (!this.current) throw new Error("No page is open. Hint: call browser_open first.");
		return this.current;
	}
	private section(id: unknown): FakeSection {
		const s = this.need().sections.find((x) => x.id === id);
		if (!s) throw new Error(`No section "${String(id)}" on this page. Hint: call browser_map for the current ids.`);
		return s;
	}
	private loadedTexts(s: FakeSection) {
		return s.all.slice(0, s.loaded);
	}

	private handle(kind: string, p: Record<string, unknown>): unknown {
		switch (kind) {
			case BROWSER_KINDS.open: {
				const page = this.pages.get(String(p.url));
				if (!page) throw new Error(`Could not open ${String(p.url)} (no such page).`);
				this.current = structuredClone(page);
				return { url: page.url, title: page.title, tabId: "t1", ...(page.wall && { wall: page.wall }) };
			}
			case BROWSER_KINDS.map: {
				const page = this.need();
				const sections = page.sections.map((s) => ({
					id: s.id,
					kind: s.kind,
					label: s.label,
					items: s.kind === "form" ? (s.controls?.length ?? 0) : s.loaded,
					declaredTotal: s.declaredTotal,
					canLoadMore: s.loaded < s.all.length && s.batch > 0,
					chars: this.loadedTexts(s).reduce((n, t) => n + t.length, 0),
					...(s.loaded > 0 && { preview: (s.all[0] ?? "").slice(0, 80) }),
				}));
				return { url: page.url, title: page.title, totalChars: sections.reduce((n, s) => n + s.chars, 0), sections, ...(page.poorTree && { poorTree: true }), ...(page.wall && { wall: page.wall }) };
			}
			case BROWSER_KINDS.read: {
				const from = Number(p.from ?? 1);
				const count = Number(p.count ?? 50);
				const itemChars = Number(p.itemChars ?? ITEM_DEFAULT_CHARS);
				const exp = typeof p.export === "string" ? this.exports.get(p.export) : undefined;
				if (typeof p.export === "string" && !exp) throw new Error(`No export "${p.export}". Hint: export the section again.`);
				const s = exp ? undefined : this.section(p.section);
				const texts = exp ? exp.items : this.loadedTexts(s!);
				const part = planPart(texts, { from, count, itemChars });
				const data = { section: exp?.section ?? s!.id, label: exp?.label ?? s!.label, from, to: part.to, loaded: texts.length, declaredTotal: exp?.declaredTotal ?? s!.declaredTotal, canLoadMore: s ? s.loaded < s.all.length && s.batch > 0 : false, nextFrom: part.nextFrom, items: part.items };
				this.sent.push(JSON.stringify(data));
				return data;
			}
			case BROWSER_KINDS.find: {
				const words = norm(String(p.query)).split(/\s+/).filter(Boolean);
				const limit = Number(p.limit ?? 20);
				const scope = p.section ? [this.section(p.section)] : this.need().sections;
				const matches: Array<{ section: string; n: number; snippet: string }> = [];
				let searched = 0;
				let total = 0;
				for (const s of scope) {
					this.loadedTexts(s).forEach((text, i) => {
						searched++;
						if (words.every((w) => norm(text).includes(w))) {
							total++;
							if (matches.length < limit) matches.push({ section: s.id, n: i + 1, snippet: text.length > 240 ? `${text.slice(0, 239)}…` : text });
						}
					});
				}
				return { ...(p.section ? { section: String(p.section) } : {}), searchedItems: searched, totalMatches: total, matches };
			}
			case BROWSER_KINDS.loadMore: {
				const s = this.section(p.section);
				const before = s.loaded;
				for (let i = 0; i < Number(p.times ?? 1) && s.batch > 0 && s.loaded < s.all.length; i++) s.loaded = Math.min(s.all.length, s.loaded + s.batch);
				return { section: s.id, before, after: s.loaded, declaredTotal: s.declaredTotal, method: "button", reachedEnd: s.loaded >= s.all.length || s.batch === 0 };
			}
			case BROWSER_KINDS.export: {
				const s = this.section(p.section);
				let stoppedBy: "not_requested" | "end" | "limit" | "stalled" = "not_requested";
				if (p.loadAll === true) {
					while (s.loaded < s.all.length && s.batch > 0) s.loaded = Math.min(s.all.length, s.loaded + s.batch);
					stoppedBy = s.loaded >= s.all.length ? "end" : "stalled";
				}
				const exportId = `x${(++this.exportSeq).toString(36).padStart(4, "0")}`;
				const items = this.loadedTexts(s);
				this.exports.set(exportId, { section: s.id, label: s.label, items, declaredTotal: s.declaredTotal });
				return { exportId, path: `/home/atlas/work/exports/${exportId}.json`, section: s.id, items: items.length, chars: items.reduce((n, t) => n + t.length, 0), declaredTotal: s.declaredTotal, stoppedBy };
			}
			case BROWSER_KINDS.act: {
				const page = this.need();
				const control = page.sections.flatMap((s) => s.controls ?? []).find((c) => c.ref === p.ref);
				if (!control) throw new Error(`No element with ref "${String(p.ref)}". Hint: map the page again.`);
				if (control.kind === "password" || control.kind === "otp") return { url: page.url, title: page.title, needsOwner: control.kind === "password" ? "password" : "code" };
				if (control.kind === "submit" && p.intent !== "submit") throw Object.assign(new Error("This control submits a form."), { code: SUBMIT_INTENT_REQUIRED });
				if (control.kind === "submit") this.submitted.push(control.name);
				return { url: page.url, title: page.title, changes: `${String(p.action)} on ${control.name}` };
			}
			case BROWSER_KINDS.wait:
				return { url: this.need().url, met: true, waitedMs: 0 };
			case BROWSER_KINDS.tabs:
				return { tabs: [{ id: "t1", url: this.need().url, title: this.need().title, active: true }] };
			case BROWSER_KINDS.screenshot:
				return { mediaType: "image/png", data: "iVBORw0KGgo=", width: 1280, height: 800 };
			default:
				throw new Error(`Unknown browser action "${kind}".`);
		}
	}
}

/** Página de vídeo com `total` comentários, `initial` carregados e `batch` por "ver mais". O comentário `answerAt` traz a resposta. */
export function commentsPage(input: { total?: number; initial?: number; batch?: number; answerAt?: number; answer?: string; url?: string; declared?: boolean } = {}): FakePage {
	const total = input.total ?? 1000;
	const answerAt = input.answerAt ?? 870;
	const answer = input.answer ?? "Update: the sponsor discount code is ATLAS-4242 and it expires on 30 November.";
	const all = Array.from({ length: total }, (_, i) => (i + 1 === answerAt ? `@viewer${i + 1}: ${answer}` : `@viewer${i + 1}: Nice video, comment number ${i + 1} about the editing and the music, nothing about prices.`));
	return {
		url: input.url ?? "https://video.example.test/watch?v=abc",
		title: "How to edit a video",
		sections: [
			{ id: "s1", kind: "text", label: "Video description", all: ["A tutorial about editing videos with free tools."], loaded: 1, batch: 0, declaredTotal: 1 },
			{ id: "s2", kind: "list", label: "Comments", all, loaded: input.initial ?? 40, batch: input.batch ?? 50, declaredTotal: input.declared === false ? null : total, controls: [{ ref: "e90", name: "Show more comments", kind: "button" }] },
		],
	};
}
