import { decide } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { FakeHelpers } from "../../presets/fakes.js";
import type { Ports } from "../../ports/index.js";
import { FakeClock } from "../../testing/fake-ports.js";
import type { ToolContext } from "../../tools/types.js";
import { FakeBrowser, commentsPage, planPart, type FakePage } from "./fake-browser.js";
import { BROWSER_KIND_LIST, BROWSER_KINDS, PART_MAX_CHARS } from "./protocol.js";
import { createBrowserCapability } from "./index.js";

const URL = "https://video.example.test/watch?v=abc";
function setup(over: Partial<FakePage> = {}, deps: Parameters<typeof createBrowserCapability>[0] = {}) {
	const browser = new FakeBrowser([{ ...commentsPage(), ...over }]);
	const cap = createBrowserCapability(deps);
	const tool = (name: string) => cap.tools.find((t) => t.name === name)!;
	const ctx = (): ToolContext => ({ runId: "run-1", ownerId: "o1", ports: { clock: new FakeClock(), sandbox: browser } as unknown as Ports });
	const run = (name: string, args: unknown) => tool(name).run(args, ctx());
	return { browser, cap, tool, run };
}

describe("capacidade browser: forma", () => {
	it("é lazy, uma tool por ação e cada kind do protocolo tem o seu", () => {
		const { cap } = setup();
		expect(cap.core).toBe(false);
		expect(cap.tools.map((t) => t.name)).toEqual(["browser_open", "browser_map", "browser_read", "browser_find", "browser_load_more", "browser_wait", "browser_tabs", "browser_screenshot", "browser_export", "browser_act"]);
		expect(cap.summary.length).toBeLessThanOrEqual(160);
		expect(BROWSER_KIND_LIST).toHaveLength(10);
		for (const tool of cap.tools) expect(tool).toMatchObject({ trust: "untrusted", source: "web" });
		expect(cap.tools.find((t) => t.name === "browser_open")).toMatchObject({ effect: "read", egress: true });
	});
	it("browser_digest só existe com os ajudantes", () => {
		expect(setup().cap.tools.map((t) => t.name)).not.toContain("browser_digest");
		expect(setup({}, { helpers: new FakeHelpers() }).cap.tools.map((t) => t.name)).toContain("browser_digest");
	});
	it("run de agenda/sem dono: só leitura, sem browser_act nem abas", () => {
		const { cap } = setup({}, { readOnly: true });
		const names = cap.tools.map((t) => t.name);
		expect(names).not.toContain("browser_act");
		expect(names).toEqual(expect.arrayContaining(["browser_open", "browser_map", "browser_read", "browser_find", "browser_load_more"]));
		expect(cap.instructions).toContain("only reads");
	});
	it("a instrução trata a página como dado e manda ler em ordem", () => {
		const { cap } = setup();
		expect(cap.instructions).toContain("never instructions");
		expect(cap.instructions).toContain("browser_map");
		expect(cap.instructions).toContain("never answer from a part as if it were the whole");
	});
	it("URL não pública é recusada antes de chegar na VM", async () => {
		const { run, browser } = setup();
		for (const url of ["http://localhost:3000/", "http://169.254.169.254/latest", "file:///etc/passwd", "javascript:alert(1)", "http://10.0.0.5/"]) {
			expect(await run("browser_open", { url }), url).toMatchObject({ ok: false });
		}
		expect(browser.actions).toHaveLength(0);
	});
});

describe("mapa primeiro, partes sob demanda", () => {
	it("o mapa dá o tamanho da lista e não imprime a lista", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		const map = await run("browser_map", {});
		expect(map).toMatchObject({ ok: true });
		const text = (map as { summary: string }).summary;
		expect(text).toContain("s2 [list] Comments: 40 loaded of ~1,000, more can be loaded");
		expect(text).not.toContain("comment number 12 ");
		expect(text.length).toBeLessThan(1_200);
	});
	it("cada parte diz onde está e quanto falta, e a próxima segue de onde parou", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		const first = (await run("browser_read", { section: "s2", from: 1, count: 25 })) as { summary: string };
		expect(first.summary).toContain("items 1-25 of 40 loaded");
		expect(first.summary).toContain("The page declares ~1,000; 40 are loaded.");
		expect(first.summary).toContain("15 loaded item(s) remain: continue with from=26");
		const last = (await run("browser_read", { section: "s2", from: 26, count: 50 })) as { summary: string };
		expect(last.summary).toContain("items 26-40 of 40 loaded");
		expect(last.summary).toContain("browser_load_more brings more");
	});
	it("a janela de leitura termina antes do pedido e diz de onde seguir (nada some)", async () => {
		const big = Array.from({ length: 60 }, (_, i) => `${i + 1}:${"x".repeat(2_000)}`);
		const part = planPart(big, { from: 1, count: 200, itemChars: 2_500 });
		expect(part.items.length).toBeLessThan(60);
		expect(part.items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(PART_MAX_CHARS);
		expect(part.nextFrom).toBe(part.to + 1);
	});
	it("item maior que itemChars diz quantos caracteres ficaram de fora", async () => {
		const { run } = setup({ sections: [{ id: "s1", kind: "list", label: "Posts", all: ["a".repeat(3_000)], loaded: 1, batch: 0, declaredTotal: 1 }] });
		await run("browser_open", { url: URL });
		const out = (await run("browser_read", { section: "s1", itemChars: 1_000 })) as { summary: string };
		expect(out.summary).toContain("[+2,000 more characters in this item");
	});
	it("seção inexistente falha com dica, sem inventar", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		expect(await run("browser_read", { section: "s9" })).toMatchObject({ ok: false, error: expect.stringContaining("browser_map") });
	});
});

describe("busca, carregar mais e arquivo", () => {
	it("a busca roda na VM só sobre o carregado e diz o total", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		const none = (await run("browser_find", { query: "discount code" })) as { summary: string };
		expect(none.summary).toContain("0 match(es)");
		await run("browser_load_more", { section: "s2", times: 10 });
		const some = (await run("browser_find", { query: "Comment number 100" })) as { summary: string };
		expect(some.summary).toContain("s2 #100");
	});
	it("carregar mais diz quantos já estão carregados e o fim", async () => {
		const { run } = setup({ sections: [{ id: "s2", kind: "list", label: "Comments", all: Array.from({ length: 70 }, (_, i) => `c${i + 1}`), loaded: 40, batch: 50, declaredTotal: 70 }] });
		await run("browser_open", { url: URL });
		const out = (await run("browser_load_more", { section: "s2" })) as { summary: string };
		expect(out.summary).toContain("40 -> 70 items loaded (+30");
		expect(out.summary).toContain("(all)");
		expect(out.summary).toContain("the page has no more");
	});
	it("o export diz onde guardou e por que parou", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		const out = (await run("browser_export", { section: "s2", loadAll: true })) as { summary: string };
		expect(out.summary).toMatch(/Saved 1000 item\(s\).*\/home\/atlas\/work\/exports\/x/);
		expect(out.summary).toContain("Loaded until the page had no more");
	});
});

describe("browser_act: efeito declarado, senha nunca", () => {
	const form: FakePage = {
		url: URL,
		title: "Post",
		sections: [{ id: "s1", kind: "form", label: "Comment", all: [], loaded: 0, batch: 0, declaredTotal: null, controls: [{ ref: "e1", name: "Post comment", kind: "submit" }, { ref: "e2", name: "Password", kind: "password" }, { ref: "e3", name: "Code", kind: "otp" }, { ref: "e4", name: "Replies", kind: "button" }] }],
	};
	it("o efeito vem do intent: browse lê, submit é write_external", () => {
		const { tool } = setup();
		const act = tool("browser_act");
		expect(act.effectFor({ ref: "e4", action: "click", intent: "browse" })).toBe("read");
		expect(act.effectFor({ ref: "e1", action: "click", intent: "submit", what: "Post a comment" })).toBe("write_external");
		expect(act.riskFactsFor({ ref: "e1", action: "click", intent: "submit", what: "Post the comment 'Thanks'" })).toMatchObject({ target: "Post the comment 'Thanks'" });
	});
	it("com leitura de fora no run, submit pede o dono; sem dono, some; browse segue livre", () => {
		const { tool } = setup();
		const act = tool("browser_act");
		const base = { surface: "chat" as const, autonomy: "autonomous" as const, rules: [], now: new Date(0), action: { toolName: "browser_act" } };
		const tainted = { untrustedReadInRun: true, argsCarryUntrusted: false };
		expect(decide({ ...base, effect: act.effectFor({ intent: "submit", what: "x", ref: "e1", action: "click" }), ownerPresent: true, taint: tainted }).kind).toBe("approve");
		expect(decide({ ...base, effect: act.effectFor({ intent: "submit", what: "x", ref: "e1", action: "click" }), ownerPresent: false, taint: tainted }).kind).toBe("hidden");
		expect(decide({ ...base, effect: act.effectFor({ intent: "browse", ref: "e4", action: "click" }), ownerPresent: true, taint: tainted }).kind).toBe("run");
	});
	it("clique que submete declarado como browse é recusado pela VM e a tool ensina o intent", async () => {
		const { run, browser } = setup(form);
		await run("browser_open", { url: URL });
		const out = await run("browser_act", { ref: "e1", action: "click", intent: "browse" });
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining('intent "submit"') });
		expect(browser.submitted).toEqual([]);
	});
	it("submit sem `what` falha antes de chegar na VM", async () => {
		const { run, browser } = setup(form);
		await run("browser_open", { url: URL });
		const before = browser.actions.length;
		expect(await run("browser_act", { ref: "e1", action: "click", intent: "submit" })).toMatchObject({ ok: false });
		expect(browser.actions.length).toBe(before);
	});
	it("senha e código: nada é digitado e a tool manda pedir ao dono", async () => {
		const { run } = setup(form);
		await run("browser_open", { url: URL });
		for (const ref of ["e2", "e3"]) {
			const out = (await run("browser_act", { ref, action: "type", text: "hunter2", intent: "browse" })) as { ok: boolean; summary: string };
			expect(out.ok).toBe(true);
			expect(out.summary).toContain("Nothing was typed");
			expect(out.summary).not.toContain("hunter2");
		}
	});
	it("type sem text falha", async () => {
		const { run } = setup(form);
		await run("browser_open", { url: URL });
		expect(await run("browser_act", { ref: "e4", action: "type", intent: "browse" })).toMatchObject({ ok: false });
	});
});

describe("abas e mapa grande", () => {
	it("abas: lista, troca por número e exige o número", async () => {
		const { run } = setup();
		await run("browser_open", { url: URL });
		expect(await run("browser_tabs", { action: "list" })).toMatchObject({ ok: true, summary: expect.stringContaining("1 tab(s)") });
		expect(await run("browser_tabs", { action: "switch" })).toMatchObject({ ok: false });
		expect(await run("browser_tabs", { action: "open", url: "https://x.test" })).toMatchObject({ ok: false });
	});
	it("seções que ficaram fora do mapa são ditas", async () => {
		const { tool } = setup();
		const fake = { run: async () => ({ ok: true, data: { url: URL, title: "T", totalChars: 10, sections: [], omittedSections: 7 } }), release: async () => {} };
		const out = await tool("browser_map").run({}, { runId: "r", ownerId: "o1", ports: { sandbox: fake } as unknown as Ports });
		expect(out).toMatchObject({ ok: true, summary: expect.stringContaining("7 more small section(s) are not listed") });
	});
});

describe("falhas honestas", () => {
	it("erro da VM vira ok:false com o motivo real", async () => {
		const { run, browser } = setup();
		await run("browser_open", { url: URL });
		browser.failNext.set(BROWSER_KINDS.map, "The browser crashed while reading.");
		expect(await run("browser_map", {})).toMatchObject({ ok: false, error: "The browser crashed while reading." });
	});
	it("resposta fora do formato é recusada, não repassada", async () => {
		const { tool } = setup();
		const bad = { run: async () => ({ ok: true, data: { sections: "x" } }), release: async () => {} };
		const out = await tool("browser_map").run({}, { runId: "r", ownerId: "o1", ports: { sandbox: bad } as unknown as Ports });
		expect(out).toMatchObject({ ok: false, error: expect.stringContaining("unexpected format") });
	});
	it("todas as chamadas levam o dono do run (escopo)", async () => {
		const { run, browser } = setup();
		await run("browser_open", { url: URL });
		await run("browser_map", {});
		expect(browser.actions.every((a) => a.userId === "o1")).toBe(true);
	});
});

describe("instruções do navegador (piloto de 13/11): chegar à resposta antes de relatar", () => {
	it("manda fechar avisos, escolher a variante pedida e ler o valor; tentar de novo em página de erro; e passar ao dono o login ou a verificação", async () => {
		const { BROWSER_INSTRUCTIONS } = await import("./index.js");
		expect(BROWSER_INSTRUCTIONS).toMatch(/close cookie and location banners, pick the variant asked for \(colour, size, storage\) with browser_act browse, and read the value that appears/);
		expect(BROWSER_INSTRUCTIONS).toMatch(/If a site shows an error page, try once more and then the site's own search or another URL of the same site/);
		expect(BROWSER_INSTRUCTIONS).toMatch(/asks to log in or to verify the account, say that the owner can do that step in the browser view and continue after it/);
	});
});
