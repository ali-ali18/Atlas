import { describe, expect, it } from "vitest";
import type { ToolCacheState } from "@workspace/shared";
import { arrangeGroupSegments, nextToolCacheState, orderByPrior, planStickyGroups, STICKY_TOOL_IDLE_MS, STICKY_TOOL_TURNS } from "./sticky-groups.js";

const T0 = new Date("2026-10-23T12:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);
const state = (over: Partial<ToolCacheState> = {}): ToolCacheState => ({
	turn: 1,
	at: T0.toISOString(),
	segments: [["browser", "routines"]],
	lastUsed: { browser: 1, routines: 1 },
	toolOrder: ["memory", "navigate", "list_routines"],
	...over,
});

describe("planStickyGroups", () => {
	it("primeiro turno: nada carregado, nada a seguir", () => {
		const plan = planStickyGroups({ prior: undefined, now: T0 });
		expect(plan).toMatchObject({ turn: 1, carriedSegments: [], toolOrder: [] });
		expect([...plan.carriedGroups]).toEqual([]);
	});

	it("turno seguinte mantém blocos, grupos e ordem do anterior", () => {
		const plan = planStickyGroups({ prior: state(), now: after(60_000) });
		expect(plan.turn).toBe(2);
		expect(plan.carriedSegments).toEqual([["browser", "routines"]]);
		expect([...plan.carriedGroups].sort()).toEqual(["browser", "routines"]);
		expect(plan.toolOrder).toEqual(["memory", "navigate", "list_routines"]);
		expect([...plan.expired]).toEqual([]);
	});

	it(`grupo sem uso há mais de ${STICKY_TOOL_TURNS} turnos sai; o usado fica`, () => {
		const prior = state({ turn: 6, lastUsed: { browser: 6, routines: 1 } });
		const plan = planStickyGroups({ prior, now: after(60_000) });
		expect(plan.turn).toBe(7);
		expect(plan.carriedSegments).toEqual([["browser"]]);
		expect([...plan.expired]).toEqual(["routines"]);
		expect(plan.lastUsed).toEqual({ browser: 6 });
		// no limite (5 turnos depois do último uso) ainda fica
		expect(planStickyGroups({ prior: state({ turn: 5, lastUsed: { browser: 5, routines: 1 } }), now: after(60_000) }).carriedSegments).toEqual([["browser", "routines"]]);
	});

	it("conversa parada além da janela recomeça do zero", () => {
		const plan = planStickyGroups({ prior: state(), now: after(STICKY_TOOL_IDLE_MS + 1) });
		expect(plan.carriedSegments).toEqual([]);
		expect([...plan.carriedGroups]).toEqual([]);
		expect([...plan.expired].sort()).toEqual(["browser", "routines"]);
		expect(plan.toolOrder).toEqual([]);
	});

	it("grupo carregado no meio de um turno (sem bloco no prompt) também segue e expira", () => {
		const prior = state({ segments: [["browser"]], lastUsed: { browser: 2, desktop: 2 }, turn: 2 });
		expect([...planStickyGroups({ prior, now: after(1) }).carriedGroups].sort()).toEqual(["browser", "desktop"]);
		expect([...planStickyGroups({ prior: { ...prior, turn: 8, lastUsed: { browser: 8, desktop: 2 } }, now: after(1) }).expired]).toEqual(["desktop"]);
	});

	it("retomada do mesmo run: mesmo turno, nada expira; grupo desconhecido é ignorado", () => {
		const plan = planStickyGroups({ prior: state({ turn: 9, segments: [["browser", "nao_existe"]], lastUsed: { browser: 1 } }), now: after(STICKY_TOOL_IDLE_MS * 3), resume: true });
		expect(plan.turn).toBe(9);
		expect(plan.carriedSegments).toEqual([["browser"]]);
		expect([...plan.expired]).toEqual([]);
	});
});

describe("arrangeGroupSegments", () => {
	it("sem estado anterior: um bloco na ordem canônica (o mesmo prompt de antes)", () => {
		expect(arrangeGroupSegments({ carried: [], groups: new Set(["routines", "browser"]) })).toEqual([["browser", "routines"]]);
		expect(arrangeGroupSegments({ carried: [], groups: new Set() })).toEqual([]);
	});

	it("grupo novo vai num bloco no fim, sem reordenar os anteriores", () => {
		expect(arrangeGroupSegments({ carried: [["routines"]], groups: new Set(["routines", "browser"]) })).toEqual([["routines"], ["browser"]]);
	});

	it("nada novo: os mesmos blocos; grupo que saiu some do seu bloco", () => {
		expect(arrangeGroupSegments({ carried: [["browser", "routines"], ["files"]], groups: new Set(["browser", "routines", "files"]) })).toEqual([["browser", "routines"], ["files"]]);
		expect(arrangeGroupSegments({ carried: [["browser", "routines"], ["files"]], groups: new Set(["browser", "files"]) })).toEqual([["browser"], ["files"]]);
	});

	it("grupo já carregado sem bloco não ganha bloco", () => {
		expect(arrangeGroupSegments({ carried: [["browser"]], groups: new Set(["browser", "desktop"]), exclude: new Set(["desktop"]) })).toEqual([["browser"]]);
	});
});

describe("orderByPrior", () => {
	it("mantém a ordem anterior e põe o novo no fim", () => {
		expect(orderByPrior(["c", "a", "x", "b", "y"], (name) => name, ["a", "b", "c"])).toEqual(["a", "b", "c", "x", "y"]);
		expect(orderByPrior(["b", "a"], (name) => name, [])).toEqual(["b", "a"]);
	});
});

describe("nextToolCacheState", () => {
	it("grupos usados renovam o prazo neste turno", () => {
		const plan = planStickyGroups({ prior: state({ turn: 3, lastUsed: { browser: 3, routines: 1 } }), now: after(1) });
		const next = nextToolCacheState({ plan, now: after(2), segments: plan.carriedSegments, used: ["routines", "nao_existe"], toolOrder: ["memory"] });
		expect(next).toEqual({ turn: 4, at: after(2).toISOString(), segments: [["browser", "routines"]], lastUsed: { browser: 3, routines: 4 }, toolOrder: ["memory"] });
	});
});
