import { childPolicy, decide, type RunPolicy } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { createCodeCapability } from "../capabilities/code/index.js";
import { createShoppingCapability } from "../capabilities/shopping/index.js";
import { FakeShopping, FakeSearch } from "./fakes.js";
import type { Tool } from "../tools/define-tool.js";
import { applyPolicyPreset, BUILD_UNATTENDED_RULES, isPolicyPresetId, PLAN_RULES, POLICY_PRESET_IDS } from "./policy-presets.js";

const chat: RunPolicy = { surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [] };
const agenda: RunPolicy = { surface: "agenda", ownerPresent: false, autonomy: "balanced", rules: [] };
const clean = { untrustedReadInRun: false, argsCarryUntrusted: false };

const tools = new Map(createCodeCapability().tools.map((t) => [t.name, t]));
const tool = (name: string): Tool => tools.get(name)!;

const ARGS: Record<string, unknown> = {
	code_session: { repo: "acme/loja" },
	code_list: { sessionId: "s" },
	code_read: { sessionId: "s", path: "src/a.js" },
	code_edit: { sessionId: "s", path: "src/a.js", old: "a", new: "b" },
	code_write: { sessionId: "s", path: "src/a.js", content: "x" },
	code_shell_read: { sessionId: "s", cmd: "git log --oneline" },
	code_shell_run: { sessionId: "s", cmd: "pnpm install" },
	code_test: { sessionId: "s", cmd: "pnpm exec vitest run a.test.js" },
	code_git_status: { sessionId: "s" },
	code_diff: { sessionId: "s" },
};
const nameOf = (key: string) => (key.startsWith("code_shell") ? "code_shell" : key);

function verdicts(policy: RunPolicy, over: { taint?: boolean } = {}) {
	const out: Record<string, string> = {};
	for (const [key, args] of Object.entries(ARGS)) {
		const t = tool(nameOf(key));
		out[key] = decide({ effect: t.effectFor(args), surface: policy.surface, ownerPresent: policy.ownerPresent, autonomy: policy.autonomy, rules: policy.rules, taint: { untrustedReadInRun: over.taint === true, argsCarryUntrusted: false }, now: new Date(0), action: { toolName: t.name } }).kind;
	}
	return out;
}

describe("presets de política: plan e build", () => {
	it("ids e guarda de tipo", () => {
		expect([...POLICY_PRESET_IDS]).toEqual(["plan", "build"]);
		expect(isPolicyPresetId("plan")).toBe(true);
		expect(isPolicyPresetId("x")).toBe(false);
	});

	it("plan: lê, lista, olha o diff e roda comando só de leitura; NÃO edita, não escreve, não roda teste nem comando que muda coisa", () => {
		const v = verdicts(applyPolicyPreset("plan", chat));
		expect(v).toEqual({ code_session: "run", code_list: "run", code_read: "run", code_edit: "hidden", code_write: "hidden", code_shell_read: "run", code_shell_run: "hidden", code_test: "hidden", code_git_status: "run", code_diff: "run" });
	});

	it("plan vale mesmo com regra `run` do dono por cima e com autonomia total", () => {
		const loose: RunPolicy = { ...chat, autonomy: "autonomous", rules: [{ match: "code_*", verdict: "run" }, { match: "*", verdict: "run" }] };
		const v = verdicts(applyPolicyPreset("plan", loose));
		expect(v.code_edit).toBe("hidden");
		expect(v.code_write).toBe("hidden");
		expect(v.code_test).toBe("hidden");
	});

	it("plan também esconde o que sai do Atlas em tool de outra capacidade (envio, escrita externa), mas não toca a leitura", () => {
		const shop = createShoppingCapability({ ...new FakeShopping().ports, search: new FakeSearch([]) });
		const planned = applyPolicyPreset("plan", chat);
		const search = shop.tools.find((t) => t.name === "product_search")!;
		expect(decide({ effect: search.effect, ...planned, taint: clean, now: new Date(0), action: { toolName: "product_search" } }).kind).toBe("run");
		expect(decide({ effect: "send", ...planned, taint: clean, now: new Date(0), action: { toolName: "email_send" } }).kind).toBe("hidden");
		expect(decide({ effect: "write_external", ...planned, autonomy: "autonomous", taint: clean, now: new Date(0), action: { toolName: "calendar_create" } }).kind).toBe("hidden");
		// anotar continua livre: lista de tarefas é write_internal fora do código
		expect(decide({ effect: "write_internal", ...planned, taint: clean, now: new Date(0), action: { toolName: "task_list" } }).kind).toBe("run");
	});

	it("build com dono: edita e roda comando permitido; .env, comando fora da lista e ler segredo seguem pedindo o dono", () => {
		const policy = applyPolicyPreset("build", chat);
		expect(policy.rules).toEqual(chat.rules);
		const v = verdicts(policy);
		expect(v).toMatchObject({ code_edit: "run", code_write: "run", code_test: "run", code_shell_run: "run", code_shell_read: "run" });
		const envEdit = tool("code_edit");
		const asks = (args: unknown, t: Tool, autonomy: RunPolicy["autonomy"]) => decide({ effect: t.effectFor(args), ...policy, autonomy, taint: clean, now: new Date(0), action: { toolName: t.name } }).kind;
		expect(asks({ sessionId: "s", path: ".env", old: "a", new: "b" }, envEdit, "autonomous")).toBe("approve");
		expect(asks({ sessionId: "s", cmd: "python3 x.py" }, tool("code_shell"), "autonomous")).toBe("approve");
		expect(asks({ sessionId: "s", path: ".env" }, tool("code_read"), "autonomous")).toBe("approve");
	});

	it("build sem dono (agenda, rotina, subagente, bot a bot) só lê; as superfícies com dono ausente caem no mesmo piso", () => {
		for (const surface of ["agenda", "routine", "subagent", "bot_to_bot"] as const) {
			const v = verdicts(applyPolicyPreset("build", { ...agenda, surface }));
			expect(v, surface).toMatchObject({ code_edit: "hidden", code_write: "hidden", code_test: "hidden", code_shell_run: "hidden", code_read: "run", code_diff: "run", code_shell_read: "run" });
		}
		// dono ausente num chat (ex.: api sem sessão ao vivo)
		const noOwner = verdicts(applyPolicyPreset("build", { ...chat, ownerPresent: false }));
		expect(noOwner.code_edit).toBe("hidden");
	});

	it("não afrouxa os pisos: taint continua e as regras `deny` do dono ficam", () => {
		const denyEdit: RunPolicy = { ...chat, rules: [{ match: "code_edit", verdict: "deny" }] };
		expect(verdicts(applyPolicyPreset("build", denyEdit)).code_edit).toBe("hidden");
		const base = applyPolicyPreset("build", chat);
		expect(base.rules.length).toBe(chat.rules.length);
		expect(PLAN_RULES.every((r) => r.verdict === "deny")).toBe(true);
		expect(BUILD_UNATTENDED_RULES.every((r) => r.verdict === "deny")).toBe(true);
	});

	it("o filho nunca excede a mãe: ajudante de uma mãe em plan ou build só lê", () => {
		for (const id of ["plan", "build"] as const) {
			const mother = applyPolicyPreset(id, chat);
			const child = childPolicy(mother);
			const v = verdicts(child);
			expect(v.code_edit, id).toBe("hidden");
			expect(v.code_write, id).toBe("hidden");
			expect(v.code_test, id).toBe("hidden");
			expect(v.code_shell_run, id).toBe("hidden");
			expect(v.code_read, id).toBe("run");
			expect(child.autonomy).toBe(mother.autonomy);
		}
	});

	it("não muda a política original (função pura)", () => {
		const frozen = Object.freeze({ ...chat, rules: Object.freeze([]) as never });
		expect(() => applyPolicyPreset("plan", frozen)).not.toThrow();
		expect(chat.rules).toEqual([]);
	});
});
