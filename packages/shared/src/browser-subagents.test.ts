import { describe, expect, it } from "vitest";
import {
	BROWSER_CHILD_HARD_STEPS,
	BROWSER_CHILD_REPORT_MAX_CHARS,
	BROWSER_CHILD_WALL_MS,
	buildChildToolFilter,
	clampBrowserChildBudget,
	clipBrowserReport,
	createConcurrencyLimiter,
	createTaskLedger,
	formatDelegateResults,
	ledgerUpdateFromChild,
	mapDelegatedItems,
	parseBrowserStartUrl,
	parseDelegateTaskArgs,
	setLedgerItems,
	updateLedgerItem,
} from "./index.js";

describe("parseDelegateTaskArgs: modo browser_item", () => {
	const base = { mode: "browser_item", tasks: [{ goal: "Read week 1", item: "e1", url: "https://lms.test/c/1" }] };

	it("aceita item e url no modo navegador", () => {
		const parsed = parseDelegateTaskArgs(base);
		expect(parsed).toMatchObject({ ok: true, mode: "browser_item" });
		if (parsed.ok) expect(parsed.tasks[0]).toMatchObject({ item: "e1", url: "https://lms.test/c/1" });
	});

	it("recusa modo desconhecido, url que não é http(s), url com credencial e item repetido", () => {
		expect(parseDelegateTaskArgs({ ...base, mode: "fast" })).toMatchObject({ ok: false });
		expect(parseDelegateTaskArgs({ ...base, tasks: [{ goal: "g", url: "file:///etc/passwd" }] })).toMatchObject({ ok: false });
		expect(parseDelegateTaskArgs({ ...base, tasks: [{ goal: "g", url: "javascript:alert(1)" }] })).toMatchObject({ ok: false });
		expect(parseDelegateTaskArgs({ ...base, tasks: [{ goal: "g", url: "https://u:p@x.test/" }] })).toMatchObject({ ok: false });
		expect(parseDelegateTaskArgs({ mode: "browser_item", tasks: [{ goal: "a", item: "e1" }, { goal: "b", item: "e1" }] })).toMatchObject({ ok: false });
	});

	it("sem modo, a url é ignorada e o item vale (o resultado fecha o item do checklist)", () => {
		const parsed = parseDelegateTaskArgs({ tasks: [{ goal: "g", item: "e1", url: "ftp://x" }] });
		expect(parsed).toMatchObject({ ok: true });
		if (parsed.ok) {
			expect(parsed.mode).toBeUndefined();
			expect(parsed.tasks[0]).toEqual({ goal: "g", item: "e1" });
		}
		expect(parseDelegateTaskArgs({ tasks: [{ goal: "a", item: "e1" }, { goal: "b", item: "e1" }] })).toMatchObject({ ok: false });
	});
});

describe("filtro de tools do filho de navegador", () => {
	const common = { isMcpName: (name: string) => name.startsWith("mcp__"), isMcpReadOnly: () => true };
	it("só com browser:true entram as tools do DOM; nunca screenshot nem coordenada", () => {
		const plain = buildChildToolFilter(common);
		const browser = buildChildToolFilter({ ...common, browser: true });
		expect(plain("browser_text")).toBe(false);
		expect(browser("browser_text")).toBe(true);
		expect(browser("browser_act")).toBe(true);
		expect(browser("browser_read")).toBe(true);
		expect(browser("browser_find")).toBe(true);
		expect(browser("navigate")).toBe(true);
		for (const name of ["screenshot", "click", "type", "key", "scroll", "delegate_task", "create_file"]) {
			expect(browser(name)).toBe(false);
		}
	});
});

describe("orçamento do filho de navegador", () => {
	it("aperta passos e relógio, sem ampliar um orçamento já menor", () => {
		const clamped = clampBrowserChildBudget({ softMaxSteps: 12, hardMaxSteps: 30, maxWallMs: 720_000, maxTokens: 400_000 });
		expect(clamped).toEqual({ softMaxSteps: 12, hardMaxSteps: BROWSER_CHILD_HARD_STEPS, maxWallMs: BROWSER_CHILD_WALL_MS, maxTokens: 400_000 });
		const small = clampBrowserChildBudget({ softMaxSteps: 4, hardMaxSteps: 6, maxWallMs: 30_000, maxTokens: 1000 });
		expect(small).toEqual({ softMaxSteps: 4, hardMaxSteps: 6, maxWallMs: 30_000, maxTokens: 1000 });
	});
});

describe("mapa resultado do filho -> ledger do pai", () => {
	const ledger = setLedgerItems(createTaskLedger(), [{ id: "e1", label: "Week 1" }, { id: "e2", label: "Week 2" }, { id: "e3", label: "Week 3" }]);

	it("ok fecha com evidência; failed e partial fecham como failed com motivo e causa", () => {
		let next = updateLedgerItem(ledger, ledgerUpdateFromChild("e1", { status: "ok", report: "Week 1 covers\n  limits and derivatives." }), { trusted: true });
		next = updateLedgerItem(next, ledgerUpdateFromChild("e2", { status: "failed", report: "Sub-agent failed: tab crashed" }), { trusted: true });
		next = updateLedgerItem(next, ledgerUpdateFromChild("e3", { status: "partial", report: "half of it\n[stopped early: time]" }), { trusted: true });
		const byId = Object.fromEntries(next.items.map((item) => [item.id, item]));
		expect(byId.e1).toMatchObject({ status: "done", evidence: "Week 1 covers limits and derivatives." });
		expect(byId.e2).toMatchObject({ status: "failed", reason: "subagent", detail: "not read: tab crashed" });
		expect(byId.e3).toMatchObject({ status: "failed", reason: "subagent" });
		expect(byId.e3?.detail).toMatch(/^partial read:/);
	});

	it("o motivo subagent é só do runtime: o modelo não o escolhe", () => {
		const update = ledgerUpdateFromChild("e1", { status: "failed", report: "x" });
		expect(() => updateLedgerItem(ledger, update)).toThrow(/real blocker/);
	});
});

describe("createConcurrencyLimiter", () => {
	it("nunca passa do teto e libera a fila em ordem", async () => {
		const limiter = createConcurrencyLimiter(2);
		let running = 0;
		let peak = 0;
		const order: number[] = [];
		const work = async (id: number) => {
			const release = await limiter.acquire();
			running += 1;
			peak = Math.max(peak, running);
			order.push(id);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running -= 1;
			release();
		};
		await Promise.all([1, 2, 3, 4, 5].map(work));
		expect(peak).toBe(2);
		expect(order).toEqual([1, 2, 3, 4, 5]);
		expect(limiter.active()).toBe(0);
	});

	it("liberar duas vezes não abre vaga a mais", async () => {
		const limiter = createConcurrencyLimiter(1);
		const release = await limiter.acquire();
		release();
		release();
		const first = await limiter.acquire();
		let second = false;
		void limiter.acquire().then(() => { second = true; });
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(second).toBe(false);
		first();
	});
});

describe("helpers", () => {
	it("parseBrowserStartUrl e clipBrowserReport", () => {
		expect(parseBrowserStartUrl(" https://a.test/x ")).toBe("https://a.test/x");
		expect(parseBrowserStartUrl("")).toBeNull();
		expect(parseBrowserStartUrl(42)).toBeNull();
		expect(clipBrowserReport("a".repeat(5000)).length).toBe(BROWSER_CHILD_REPORT_MAX_CHARS);
		expect(clipBrowserReport("  short ")).toBe("short");
	});

	it("o relatório mostra o item de cada tarefa", () => {
		const text = formatDelegateResults([{ taskIndex: 0, goal: "g", status: "ok", report: "r", toolsUsed: [], itemId: "e7" }]);
		expect(text).toContain("### Task 1 (item e7) [ok]");
	});
});

describe("mapDelegatedItems: tarefa delegada -> item do checklist", () => {
	const ledger = (labels: string[], done: number[] = []) => {
		let l = setLedgerItems(createTaskLedger(), labels.map((label) => ({ label })));
		for (const index of done) l = updateLedgerItem(l, { id: l.items[index]!.id, status: "done", evidence: "x" });
		return l;
	};

	it("sem ledger ou sem itens: nada é mapeado", () => {
		expect(mapDelegatedItems([{ goal: "Semana 2" }], undefined)).toEqual([undefined]);
		expect(mapDelegatedItems([{ goal: "Semana 2" }], createTaskLedger())).toEqual([undefined]);
	});

	it("item explícito vale se existe; id desconhecido é ignorado", () => {
		const l = ledger(["Semana 1", "Semana 2"]);
		expect(mapDelegatedItems([{ goal: "qualquer", item: "2" }, { goal: "x", item: "99" }], l)).toEqual(["2", undefined]);
	});

	it("rótulo inteiro no objetivo ou no título (sem acento, palavra inteira) casa com o único item aberto", () => {
		const l = ledger(["Semana 2", "Semana 12", "Conclusão"]);
		expect(mapDelegatedItems([{ goal: "Escreva o resumo da SEMANA 2 da disciplina" }], l)).toEqual(["1"]);
		expect(mapDelegatedItems([{ title: "Conclusao", goal: "escreva o fecho" }], l)).toEqual(["3"]);
	});

	it("ambíguo ou sem casamento: não fecha nada", () => {
		const l = ledger(["Semana 2", "Semana 3"]);
		expect(mapDelegatedItems([{ goal: "leia a semana 2 e a semana 3" }], l)).toEqual([undefined]);
		expect(mapDelegatedItems([{ goal: "pesquise preços" }], l)).toEqual([undefined]);
		// duas tarefas casando o mesmo item
		expect(mapDelegatedItems([{ goal: "semana 2 parte A" }, { goal: "semana 2 parte B" }], l)).toEqual([undefined, undefined]);
		// item explícito em uma tarefa: a outra não o reivindica por rótulo
		expect(mapDelegatedItems([{ goal: "a", item: "1" }, { goal: "semana 2" }], l)).toEqual(["1", undefined]);
	});

	it("item já fechado e rótulo curto demais não casam por rótulo", () => {
		expect(mapDelegatedItems([{ goal: "semana 2" }], ledger(["Semana 2"], [0]))).toEqual([undefined]);
		expect(mapDelegatedItems([{ goal: "item A de novo" }], ledger(["A"]))).toEqual([undefined]);
	});
});
