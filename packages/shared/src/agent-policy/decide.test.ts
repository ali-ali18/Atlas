import { describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS } from "../autonomy.js";
import { decide, HANDOFF_ACTIONS } from "./decide.js";
import type { Mandate } from "./mandate.js";
import { EFFECT_CLASSES, NO_FREE_TEXT, SURFACES, type DecideInput, type EffectClass, type Surface } from "./types.js";

const now = new Date("2026-11-05T12:00:00Z");
const clean = { untrustedReadInRun: false, argsCarryUntrusted: false };
const mk = (over: Partial<DecideInput> = {}): DecideInput => ({
	effect: "read",
	surface: "chat",
	ownerPresent: true,
	autonomy: "balanced",
	rules: [],
	taint: clean,
	now,
	...over,
});
const kind = (over: Partial<DecideInput>) => decide(mk(over)).kind;

const NO_OWNER: Surface[] = ["agenda", "routine", "subagent", "bot_to_bot"];
const OWNER_ONLY: EffectClass[] = ["send", "money", "public_link", "credential", "destructive", "write_external"];

describe("matriz superfície x efeito x dono x autonomia", () => {
	for (const surface of SURFACES) {
		for (const effect of EFFECT_CLASSES) {
			for (const ownerPresent of [true, false]) {
				for (const autonomy of AUTONOMY_LEVELS) {
					const noOwner = !ownerPresent || NO_OWNER.includes(surface);
					let expected: string;
					if (noOwner && OWNER_ONLY.includes(effect)) expected = "hidden";
					else if (effect === "read" || effect === "draft") expected = "run";
					else if (effect === "write_internal") expected = autonomy === "always_ask" ? "approve" : "run";
					else if (effect === "write_external") expected = autonomy === "autonomous" ? "run" : "approve";
					else expected = "approve";
					it(`${surface} ${effect} dono=${ownerPresent} ${autonomy} -> ${expected}`, () => {
						expect(kind({ surface, effect, ownerPresent, autonomy })).toBe(expected);
					});
				}
			}
		}
	}
	it("o mesmo efeito dá o mesmo resultado em chat e api com dono (cláusula 16)", () => {
		for (const effect of EFFECT_CLASSES) expect(kind({ effect, surface: "api" })).toBe(kind({ effect, surface: "chat" }));
	});
});

describe("handoff", () => {
	for (const handoffKind of HANDOFF_ACTIONS) {
		it(`${handoffKind} é handoff com qualquer autonomia, superfície, regra e mandato`, () => {
			const mandate: Mandate = { maxAmount: 1e9, currency: "BRL", merchants: ["x"], until: "2030-01-01T00:00:00Z", usesLeft: 9 };
			for (const autonomy of AUTONOMY_LEVELS) {
				for (const surface of SURFACES) {
					const v = decide(mk({
						effect: "money", surface, autonomy, mandate, ownerPresent: surface === "chat",
						riskFacts: { amount: 1, currency: "BRL", merchant: "x" },
						rules: [{ match: "*", verdict: "run" }],
						action: { toolName: "t", handoffKind },
					}));
					expect(v.kind).toBe("handoff");
				}
			}
		});
	}
	it("handoffKind desconhecido não vira handoff", () => {
		expect(kind({ action: { toolName: "t", handoffKind: "other" } })).toBe("run");
	});
});

describe("taint", () => {
	const tainted = [{ untrustedReadInRun: true, argsCarryUntrusted: false }, { untrustedReadInRun: false, argsCarryUntrusted: true }];
	for (const taint of tainted) {
		for (const effect of ["send", "write_external", "public_link"] as const) {
			it(`${effect} com taint ${JSON.stringify(taint)} nunca roda (autonomous + regra run)`, () => {
				const v = decide(mk({ effect, taint, autonomy: "autonomous", rules: [{ match: "*", verdict: "run" }], action: { toolName: "x" } }));
				expect(v.kind).toBe("approve");
			});
		}
	}
	it("taint não atrapalha leitura nem escrita interna", () => {
		expect(kind({ effect: "read", taint: tainted[0]! })).toBe("run");
		expect(kind({ effect: "write_internal", taint: tainted[1]! })).toBe("run");
	});
	it("taint não derruba o hidden de superfície sem dono", () => {
		expect(kind({ effect: "send", surface: "routine", taint: tainted[0]! })).toBe("hidden");
	});
	it("taint anula o mandato", () => {
		const mandate: Mandate = { maxAmount: 100, currency: "BRL", merchants: ["x"], until: "2030-01-01T00:00:00Z", usesLeft: 1 };
		const riskFacts = { amount: 10, currency: "BRL", merchant: "x" };
		expect(kind({ effect: "money", mandate, riskFacts })).toBe("run");
		expect(kind({ effect: "money", mandate, riskFacts, taint: tainted[1]! })).toBe("approve");
	});
});

describe("regras do dono", () => {
	const action = { toolName: "mcp__crm__update" };
	it("a última que casa vence", () => {
		const run = { match: "mcp__crm__*", verdict: "run" as const };
		const approve = { match: "mcp__crm__update", verdict: "approve" as const };
		expect(kind({ effect: "write_external", action, rules: [approve, run] })).toBe("run");
		expect(kind({ effect: "write_external", action, rules: [run, approve] })).toBe("approve");
	});
	it("regra que não casa é ignorada; filtro de efeito é respeitado", () => {
		expect(kind({ effect: "write_external", action, rules: [{ match: "other", verdict: "run" }] })).toBe("approve");
		expect(kind({ effect: "write_external", action, rules: [{ match: "*", effect: "draft", verdict: "run" }] })).toBe("approve");
	});
	it("approve aperta qualquer efeito, inclusive leitura", () => {
		expect(kind({ effect: "read", action, rules: [{ match: "*", verdict: "approve" }] })).toBe("approve");
		expect(kind({ effect: "write_internal", action, rules: [{ match: "*", verdict: "approve" }] })).toBe("approve");
	});
	it("deny esconde a tool", () => {
		expect(kind({ effect: "read", action, rules: [{ match: "mcp__*", verdict: "deny" }] })).toBe("hidden");
	});
	it("run afrouxa draft, write_internal (always_ask) e write_external", () => {
		const rules = [{ match: "*", verdict: "run" as const }];
		expect(kind({ effect: "write_internal", autonomy: "always_ask", action, rules })).toBe("run");
		expect(kind({ effect: "write_external", action, rules })).toBe("run");
	});
	for (const effect of ["send", "money", "credential", "public_link", "destructive"] as const) {
		it(`run NÃO afrouxa ${effect}`, () => {
			expect(kind({ effect, autonomy: "autonomous", action, rules: [{ match: "*", verdict: "run" }] })).toBe("approve");
		});
	}
	it("run não traz de volta o que a superfície escondeu", () => {
		expect(kind({ effect: "write_external", surface: "routine", action, rules: [{ match: "*", verdict: "run" }] })).toBe("hidden");
	});
	it("sem action.toolName nenhuma regra casa", () => {
		expect(kind({ effect: "write_external", rules: [{ match: "*", verdict: "run" }] })).toBe("approve");
	});
});

describe("mandato em decide", () => {
	const mandate: Mandate = { maxAmount: 100, currency: "BRL", merchants: ["loja"], until: "2026-11-06T00:00:00Z", usesLeft: 1 };
	const facts = { amount: 100, currency: "BRL", merchant: "loja" };
	it("válido (no limite exato) roda com motivo mandate", () => {
		expect(decide(mk({ effect: "money", mandate, riskFacts: facts }))).toEqual({ kind: "run", reason: "mandate" });
	});
	it.each([
		["acima do valor", { ...facts, amount: 100.01 }, mandate],
		["outra loja", { ...facts, merchant: "outra" }, mandate],
		["outra moeda", { ...facts, currency: "USD" }, mandate],
		["vencido", facts, { ...mandate, until: "2026-11-05T12:00:00Z" }],
		["sem usos", facts, { ...mandate, usesLeft: 0 }],
	])("%s vira approve", (_n, riskFacts, m) => {
		expect(kind({ effect: "money", mandate: m, riskFacts })).toBe("approve");
	});
	it("sem riskFacts completos não libera", () => {
		expect(kind({ effect: "money", mandate })).toBe("approve");
		expect(kind({ effect: "money", mandate, riskFacts: { amount: 1 } })).toBe("approve");
	});
	it("mandato nunca libera destructive/credential nem esconde menos", () => {
		expect(kind({ effect: "destructive", mandate, riskFacts: facts })).toBe("approve");
		expect(kind({ effect: "credential", mandate, riskFacts: facts })).toBe("approve");
		expect(kind({ effect: "money", surface: "routine", mandate, riskFacts: facts })).toBe("hidden");
	});
});

describe("sem texto livre (cláusula 7)", () => {
	it("DecideInput não tem campo de texto livre (guarda de compilação em types.ts)", () => {
		expect(NO_FREE_TEXT).toBe(true);
	});
});

describe("egress (auditoria F1, S2)", () => {
	const tainted = { untrustedReadInRun: true, argsCarryUntrusted: false };
	const trifecta = { untrustedReadInRun: true, argsCarryUntrusted: false, privateReadInRun: true };
	it("read com egress: só a trifeta completa (não confiável + privado) pede aprovação; pesquisa pura na web roda", () => {
		expect(kind({ effect: "read", egress: true })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: tainted })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: { untrustedReadInRun: false, argsCarryUntrusted: true } })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: { untrustedReadInRun: false, argsCarryUntrusted: false, privateReadInRun: true } })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: trifecta })).toBe("approve");
	});
	it("campos ThisRun mandam na saída; ausentes caem nos herdados; envio segue nos herdados", () => {
		const inherited = { untrustedReadInRun: true, argsCarryUntrusted: false, privateReadInRun: true };
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: false, privateReadThisRun: false } })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: true, privateReadThisRun: false } })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: false, privateReadThisRun: true } })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: true, privateReadThisRun: true } })).toBe("approve");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: true } })).toBe("approve");
		expect(kind({ effect: "read", egress: true, taint: inherited })).toBe("approve");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: false, privateReadThisRun: false }, surface: "routine" })).toBe("hidden");
		expect(kind({ effect: "read", egress: true, taint: { ...inherited, untrustedReadThisRun: true, privateReadThisRun: true }, surface: "routine" })).toBe("hidden");
		expect(kind({ effect: "send", taint: { ...inherited, untrustedReadThisRun: false, privateReadThisRun: false } })).toBe("approve");
	});
	it("sem dono o recorte 'deste run' não vale: trifeta herdada da conversa fica fora, mesmo com ThisRun falso; com dono presente roda", () => {
		const contaminated = { untrustedReadInRun: true, argsCarryUntrusted: false, privateReadInRun: true, untrustedReadThisRun: false, privateReadThisRun: false };
		expect(kind({ effect: "read", egress: true, taint: contaminated, ownerPresent: false })).toBe("hidden");
		expect(kind({ effect: "read", egress: true, taint: contaminated, surface: "agenda" })).toBe("hidden");
		expect(kind({ effect: "read", egress: true, taint: contaminated, ownerPresent: true })).toBe("run");
		// sem contaminação herdada, sem dono continua rodando (pesquisa pura)
		expect(kind({ effect: "read", egress: true, taint: { untrustedReadInRun: false, argsCarryUntrusted: false }, ownerPresent: false })).toBe("run");
	});
	it("subagente: sinais efetivos da mãe valem para a saída, mas envio, escrita externa, link público e confirm seguem vendo a conversa contaminada", () => {
		const child = { untrustedReadInRun: true, argsCarryUntrusted: false, privateReadInRun: true, untrustedReadThisRun: false, privateReadThisRun: false, untrustedEgressInherited: false, privateEgressInherited: false };
		const base = { ownerPresent: false, surface: "subagent" as const };
		expect(kind({ ...base, effect: "read", egress: true, taint: child })).toBe("run");
		// o que o próprio filho leu conta
		expect(kind({ ...base, effect: "read", egress: true, taint: { ...child, untrustedReadThisRun: true, privateReadThisRun: true } })).toBe("hidden");
		// mãe sem dono contaminada: efetivo verdadeiro, fica fora
		expect(kind({ ...base, effect: "read", egress: true, taint: { ...child, untrustedEgressInherited: true, privateEgressInherited: true } })).toBe("hidden");
		// escrita/envio/link: sem dono continuam fora; confirm when_untrusted continua olhando a conversa
		for (const effect of ["write_external", "send", "public_link"] as const) expect(kind({ ...base, effect, taint: child })).toBe("hidden");
		expect(kind({ ...base, effect: "read", confirm: "when_untrusted", taint: child })).toBe("hidden");
	});
	it("trifeta sem dono (rotina, ou dono ausente) fica fora em vez de estacionar com cartão que ninguém vê", () => {
		expect(kind({ effect: "read", egress: true, taint: trifecta, surface: "routine" })).toBe("hidden");
		expect(kind({ effect: "read", egress: true, taint: trifecta, ownerPresent: false })).toBe("hidden");
		expect(kind({ effect: "read", egress: true, taint: tainted, surface: "routine" })).toBe("run");
	});
	it("read sem egress continua rodando com taint, e regra 'run' do dono não afrouxa o egress com taint", () => {
		expect(kind({ effect: "read", taint: tainted })).toBe("run");
		expect(kind({ effect: "read", egress: true, taint: trifecta, rules: [{ match: "*", verdict: "run" }] })).toBe("approve");
	});
});

describe("confirm declarado pela tool", () => {
	const tainted = { untrustedReadInRun: true, argsCarryUntrusted: false };
	const allowAll = [{ match: "*", verdict: "run" as const }];
	it("always: run vira approve em qualquer autonomia, e regra run do dono não afrouxa", () => {
		for (const autonomy of AUTONOMY_LEVELS) expect(kind({ effect: "write_internal", confirm: "always", autonomy })).toBe("approve");
		expect(decide(mk({ effect: "write_internal", confirm: "always", autonomy: "autonomous" }))).toMatchObject({ kind: "approve", reason: "owner confirms this action" });
		expect(kind({ effect: "write_internal", confirm: "always", autonomy: "autonomous", rules: allowAll })).toBe("approve");
		expect(kind({ effect: "write_internal", confirm: "always", rules: [{ match: "x", verdict: "deny" }], action: { toolName: "x" } })).toBe("hidden");
	});
	it("always sem dono (superfície ou ownerPresent=false): hidden", () => {
		for (const surface of NO_OWNER) expect(kind({ effect: "write_internal", confirm: "always", surface })).toBe("hidden");
		expect(kind({ effect: "write_internal", confirm: "always", ownerPresent: false })).toBe("hidden");
	});
	it("when_untrusted: sem leitura não confiável nada muda", () => {
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", autonomy: "autonomous" })).toBe("run");
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", surface: "routine" })).toBe("run");
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", taint: { untrustedReadInRun: false, argsCarryUntrusted: true } })).toBe("run");
	});
	it("when_untrusted com leitura não confiável: approve, regra run não afrouxa, sem dono hidden", () => {
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", autonomy: "autonomous", taint: tainted })).toBe("approve");
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", autonomy: "autonomous", taint: tainted, rules: allowAll })).toBe("approve");
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", taint: tainted, surface: "routine" })).toBe("hidden");
		expect(kind({ effect: "write_internal", confirm: "when_untrusted", taint: tainted, ownerPresent: false })).toBe("hidden");
	});
	it("regra approve do dono continua apertando; sem confirm a regra run afrouxa como antes", () => {
		expect(kind({ effect: "write_internal", rules: [{ match: "*", verdict: "approve" }], action: { toolName: "x" } })).toBe("approve");
		expect(kind({ effect: "write_internal", autonomy: "always_ask", rules: allowAll, action: { toolName: "x" } })).toBe("run");
	});
});
