import { describe, expect, it } from "vitest";
import { AUTONOMY_LEVELS } from "../autonomy.js";
import { childPolicy, HELPER_DENIED_EFFECTS, lowerAutonomy, type RunPolicy } from "./child-policy.js";
import { decide } from "./decide.js";
import { EFFECT_CLASSES, type DecideInput, type PolicyRule, type Verdict } from "./types.js";

const now = new Date("2026-11-06T12:00:00Z");
const mandate = { id: "m1", maxAmount: 100, currency: "BRL", merchants: ["loja"], expiresAt: new Date("2026-12-01T00:00:00Z").toISOString(), usesLeft: 3 } as unknown as NonNullable<RunPolicy["mandate"]>;
const mother = (over: Partial<RunPolicy> = {}): RunPolicy => ({ surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [], ...over });
const taintFree = { untrustedReadInRun: false, argsCarryUntrusted: false };
const verdictOf = (policy: RunPolicy, effect: DecideInput["effect"], toolName = "some_tool", taint = taintFree): Verdict => decide({ ...policy, effect, taint, now, action: { toolName } });
// Quanto mais alto, mais restrito.
const strictness = (v: Verdict) => ({ run: 0, approve: 1, handoff: 1, hidden: 2 })[v.kind];

describe("childPolicy: tabela de casos", () => {
	it("superfície subagente, sem dono presente, mesma autonomia da mãe", () => {
		for (const autonomy of AUTONOMY_LEVELS) {
			const child = childPolicy(mother({ autonomy }));
			expect(child).toMatchObject({ surface: "subagent", ownerPresent: false, autonomy });
		}
	});

	it("autonomia pedida só pode baixar", () => {
		expect(childPolicy(mother({ autonomy: "autonomous" }), { autonomy: "balanced" }).autonomy).toBe("balanced");
		expect(childPolicy(mother({ autonomy: "autonomous" }), { autonomy: "always_ask" }).autonomy).toBe("always_ask");
		expect(childPolicy(mother({ autonomy: "balanced" }), { autonomy: "autonomous" }).autonomy).toBe("balanced");
		expect(childPolicy(mother({ autonomy: "always_ask" }), { autonomy: "autonomous" }).autonomy).toBe("always_ask");
	});

	it("lowerAutonomy é a menor das duas", () => {
		expect(lowerAutonomy("autonomous", "always_ask")).toBe("always_ask");
		expect(lowerAutonomy("balanced", "balanced")).toBe("balanced");
		expect(lowerAutonomy("balanced", "autonomous")).toBe("balanced");
	});

	it("mandato da mãe não é herdado", () => {
		const child = childPolicy(mother({ mandate }));
		expect(child.mandate).toBeUndefined();
		expect("mandate" in child).toBe(false);
	});

	it("regras do dono herdadas, na ordem, com as do ajudante por último; approve vira deny (sem a quem pedir)", () => {
		const rules: PolicyRule[] = [
			{ match: "web_*", verdict: "run" },
			{ match: "note_*", verdict: "approve" },
			{ match: "mail_*", verdict: "deny" },
		];
		const child = childPolicy(mother({ rules }));
		expect(child.rules.slice(0, 3)).toEqual([
			{ match: "web_*", verdict: "run" },
			{ match: "note_*", verdict: "deny" },
			{ match: "mail_*", verdict: "deny" },
		]);
		expect(child.rules.slice(3).map((r) => r.effect)).toEqual([...HELPER_DENIED_EFFECTS]);
		// a lista da mãe não é alterada
		expect(rules[1]?.verdict).toBe("approve");
	});

	it("o ajudante só lê: todo efeito que não é leitura fica hidden, até com autonomia total e regra `run` do dono", () => {
		const child = childPolicy(mother({ autonomy: "autonomous", rules: [{ match: "*", verdict: "run" }] }));
		expect(verdictOf(child, "read").kind).toBe("run");
		for (const effect of EFFECT_CLASSES.filter((e) => e !== "read")) expect(verdictOf(child, effect).kind, effect).toBe("hidden");
	});

	it("leitura com regra deny do dono continua escondida no filho", () => {
		const child = childPolicy(mother({ rules: [{ match: "private_*", verdict: "deny" }] }));
		expect(verdictOf(child, "read", "private_notes").kind).toBe("hidden");
		expect(verdictOf(child, "read", "web_search").kind).toBe("run");
	});

	it("taint da mãe (herdado como fato) segue valendo no filho: leitura com saída a terceiro e a trifeta fecha", () => {
		const child = childPolicy(mother());
		const trifecta = { untrustedReadInRun: true, argsCarryUntrusted: false, privateReadInRun: true };
		expect(decide({ ...child, effect: "read", egress: true, taint: trifecta, now, action: { toolName: "web_search" } }).kind).toBe("hidden");
		expect(decide({ ...child, effect: "read", egress: true, taint: { ...trifecta, privateReadInRun: false }, now, action: { toolName: "web_search" } }).kind).toBe("run");
	});

	it("é pura: não muda a entrada e dá o mesmo resultado", () => {
		const input = mother({ rules: [{ match: "x", verdict: "approve" }] });
		const snapshot = structuredClone(input);
		expect(childPolicy(input)).toEqual(childPolicy(input));
		expect(input).toEqual(snapshot);
	});
});

describe("childPolicy: nunca concede mais que a mãe", () => {
	const mothers: RunPolicy[] = [];
	for (const surface of ["chat", "api", "agenda", "routine", "subagent", "bot_to_bot"] as const) {
		for (const ownerPresent of [true, false]) {
			for (const autonomy of AUTONOMY_LEVELS) {
				mothers.push(mother({ surface, ownerPresent, autonomy, rules: [{ match: "web_*", verdict: "run" }, { match: "send_*", verdict: "approve" }], mandate }));
			}
		}
	}
	const taints = [taintFree, { untrustedReadInRun: true, argsCarryUntrusted: false }, { untrustedReadInRun: true, argsCarryUntrusted: true, privateReadInRun: true }];

	it("para toda combinação, o veredito do filho é igual ou mais restrito que o da mãe", () => {
		let checked = 0;
		for (const parent of mothers) {
			const child = childPolicy(parent);
			for (const effect of EFFECT_CLASSES) {
				for (const taint of taints) {
					for (const toolName of ["web_search", "send_mail", "other"]) {
						const a = verdictOf(parent, effect, toolName, taint);
						const b = verdictOf(child, effect, toolName, taint);
						expect(strictness(b), `${parent.surface}/${parent.ownerPresent}/${parent.autonomy} ${effect} ${toolName}: mãe ${a.kind}, filho ${b.kind}`).toBeGreaterThanOrEqual(strictness(a));
						checked++;
					}
				}
			}
		}
		expect(checked).toBe(mothers.length * EFFECT_CLASSES.length * taints.length * 3);
	});
});
