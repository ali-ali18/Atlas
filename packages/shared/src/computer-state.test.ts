import { describe, expect, it } from "vitest";
import {
	computerStateKey,
	createStallTracker,
	emptyComputerMetrics,
	recordComputerCall,
} from "./computer-state.js";

describe("computerStateKey", () => {
	it("ignora o número do ref e pequenas variações de scroll", () => {
		const a = computerStateKey({ url: "https://x.com/a", lines: ['[e1] button "Salvar"'], scrollY: 10 });
		const b = computerStateKey({ url: "https://x.com/a", lines: ['[e7] button "Salvar"'], scrollY: 40 });
		expect(a).toBe(b);
	});
	it("ignora também o prefixo de frame do ref (f1e3)", () => {
		const a = computerStateKey({ url: "https://x.com/a", lines: ['[f1e3] button "Salvar"'], scrollY: 0 });
		const b = computerStateKey({ url: "https://x.com/a", lines: ['[f2e9] button "Salvar"'], scrollY: 0 });
		expect(a).toBe(b);
	});
	it("muda com URL, elementos, valor e scroll grande", () => {
		const base = { url: "https://x.com/a", lines: ['[e1] textbox "Nome" value="a"'], scrollY: 0 };
		const key = computerStateKey(base);
		expect(computerStateKey({ ...base, url: "https://x.com/a#add" })).not.toBe(key);
		expect(computerStateKey({ ...base, lines: ['[e1] textbox "Nome" value="ab"'] })).not.toBe(key);
		expect(computerStateKey({ ...base, scrollY: 400 })).not.toBe(key);
		expect(computerStateKey({})).toBe(computerStateKey({}));
	});
});

describe("createStallTracker", () => {
	it("página igual após agir: dica na 2ª, forte na 3ª, aborto na 4ª", () => {
		const t = createStallTracker();
		expect(t.observe("snap", "A").level).toBe("none");
		t.action();
		expect(t.observe("snap", "A").level).toBe("none");
		t.action();
		expect(t.observe("snap", "A").level).toBe("hint");
		t.action();
		expect(t.observe("snap", "A").level).toBe("strong");
		t.action();
		expect(t.observe("snap", "A")).toEqual({ stalled: 4, level: "abort" });
	});
	it("reler sem agir não conta; mudança zera", () => {
		const t = createStallTracker();
		t.observe("snap", "A");
		expect(t.observe("snap", "A").stalled).toBe(0);
		t.action();
		expect(t.observe("snap", "A").stalled).toBe(1);
		t.action();
		expect(t.observe("snap", "B").stalled).toBe(0);
	});
	it("ação que também observa (act) conta por si", () => {
		const t = createStallTracker();
		t.observe("act", "same", true);
		t.observe("act", "same", true);
		expect(t.observe("act", "same", true).level).toBe("hint");
	});
});

describe("recordComputerCall", () => {
	it("conta por tipo, falhas e tempo", () => {
		let m = emptyComputerMetrics();
		m = recordComputerCall(m, { tool: "screenshot", ok: true, ms: 100 });
		m = recordComputerCall(m, { tool: "browser_act", ok: false, ms: 50.4 });
		m = recordComputerCall(m, { tool: "click", ok: true, ms: Number.NaN });
		m = recordComputerCall(m, { tool: "browser_snapshot", ok: true, ms: 10 });
		expect(m).toMatchObject({
			calls: 4,
			screenshots: 1,
			refActs: 1,
			coordActs: 1,
			snapshots: 1,
			failures: 1,
			totalMs: 160,
		});
	});
});
