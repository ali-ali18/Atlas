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

	it("sem modo, item e url são ignorados (delegação comum não muda)", () => {
		const parsed = parseDelegateTaskArgs({ tasks: [{ goal: "g", item: "e1", url: "ftp://x" }] });
		expect(parsed).toMatchObject({ ok: true });
		if (parsed.ok) {
			expect(parsed.mode).toBeUndefined();
			expect(parsed.tasks[0]).toEqual({ goal: "g" });
		}
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
