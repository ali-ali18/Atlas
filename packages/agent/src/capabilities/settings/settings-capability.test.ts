import { describe, expect, it } from "vitest";
import { RunProvenance } from "../../contract/provenance.js";
import { createExecutor } from "../../contract/executor.js";
import { FakeSettings } from "../../presets/fakes.js";
import { fakePorts, sha256 } from "../../testing/fake-ports.js";
import { call, kernelHarness, reply } from "../../testing/kernel-fakes.js";
import type { Tool } from "../../tools/define-tool.js";
import type { ToolContext } from "../../tools/types.js";
import { createSettingsCapability } from "./settings-capability.js";

const ctx = (ownerId = "o1"): ToolContext => ({ runId: "run-1", ownerId, ports: {} as ToolContext["ports"] });
const toolsOf = (settings: FakeSettings) => Object.fromEntries(createSettingsCapability(settings).tools.map((t) => [t.name, t])) as Record<string, Tool>;

describe("capacidade settings", () => {
	it("efeitos honestos e lazy; as descrições dizem quando usar e quando não usar", () => {
		const cap = createSettingsCapability(new FakeSettings());
		expect(cap.core).toBe(false);
		const t = Object.fromEntries(cap.tools.map((x) => [x.name, x]));
		expect(t.settings_get).toMatchObject({ effect: "read" });
		for (const name of ["settings_update", "set_role_model", "update_bot_profile"]) expect(t[name], name).toMatchObject({ effect: "write_internal" });
		for (const tool of cap.tools) expect(tool.description.length, tool.name).toBeLessThan(700);
		expect(t.update_bot_profile!.description).toContain("ONLY when the owner explicitly asked");
		expect(t.set_role_model!.description).toContain("Do not guess model ids");
	});

	it("settings_update confirma quando o run leu conteúdo não confiável (auditoria F2, S5)", async () => {
		const settings = new FakeSettings();
		const t = toolsOf(settings);
		expect(t.settings_update!.confirm).toBe("when_untrusted");
		const provenance = new RunProvenance();
		const { ports } = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "o1", ports, hash: sha256, policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] }, provenance });
		const before = await executor.executeCall({ callId: "c1", step: 1, tool: t.settings_update!, args: { notify: false } });
		expect(before.status).toBe("ok");
		provenance.record("página", "web");
		const after = await executor.executeCall({ callId: "c2", step: 2, tool: t.settings_update!, args: { notify: true } });
		expect(after.status).toBe("pending_approval");
		expect(await settings.get("o1")).toMatchObject({ notify: false });
	});

	it("sem suporte a modelo por papel: set_role_model não é registrada e settings_get não finge escolha (auditoria F2, R1)", async () => {
		const settings = new FakeSettings(undefined, { supportsRoleModels: false });
		const cap = createSettingsCapability(settings);
		expect(cap.tools.map((x) => x.name)).toEqual(["settings_get", "settings_update", "update_bot_profile"]);
		for (const tool of cap.tools) expect(tool.description, tool.name).not.toContain("set_role_model");
		const t = toolsOf(settings);
		const out = await t.settings_get!.run({}, ctx());
		expect(out.ok && out.summary).not.toContain("Models by role");
		expect(out.ok && out.summary).not.toContain("default");
		expect(out.ok && out.summary).toContain("Language: pt-BR");
		expect(cap.summary).not.toContain("models");
	});

	it("settings_get mostra o estado, com o modelo por papel", async () => {
		const settings = new FakeSettings();
		await settings.update("o1", { roleModels: { code: "anthropic-direct/claude-opus-5-5" } });
		const out = await toolsOf(settings).settings_get!.run({}, ctx());
		expect(out.ok && out.summary).toContain("code (writing code): anthropic-direct/claude-opus-5-5");
		expect(out.ok && out.summary).toContain("main (main answers and work): default");
	});

	it("settings_update muda idioma e avisos, com recibo; nada para mudar é erro", async () => {
		const settings = new FakeSettings();
		const t = toolsOf(settings);
		expect(await t.settings_update!.run({ language: "en-US", notify: false }, ctx())).toMatchObject({ ok: true, receipt: { what: "Changed bot settings: language en-US, notifications off" } });
		expect(await settings.get("o1")).toMatchObject({ language: "en-US", notify: false });
		expect(await t.settings_update!.run({}, ctx())).toMatchObject({ ok: false, hint: expect.stringContaining("language") });
		const bad = await t.settings_update!.run({ language: "klingon" }, ctx());
		expect(!bad.ok && bad.error).toContain("pt-BR");
	});

	it("set_role_model: troca, volta ao padrão e valida papel e modelo com a lista aceita", async () => {
		const settings = new FakeSettings(["claude-sonnet-5-5", "anthropic-direct/claude-opus-5-5"]);
		const t = toolsOf(settings);
		expect(await t.set_role_model!.run({ role: "code", model: "anthropic-direct/claude-opus-5-5" }, ctx())).toMatchObject({ ok: true, receipt: { what: "Model for writing code set to anthropic-direct/claude-opus-5-5" } });
		expect((await settings.get("o1")).roleModels).toEqual({ code: "anthropic-direct/claude-opus-5-5" });
		expect(await t.set_role_model!.run({ role: "code", model: "default" }, ctx())).toMatchObject({ ok: true });
		expect((await settings.get("o1")).roleModels).toEqual({});
		const unknownRole = await t.set_role_model!.run({ role: "writer", model: "default" }, ctx());
		expect(!unknownRole.ok && unknownRole.error).toContain("main");
		const unavailable = await t.set_role_model!.run({ role: "main", model: "gpt-9" }, ctx());
		expect(unavailable).toMatchObject({ ok: false, hint: expect.stringContaining("Available models: claude-sonnet-5-5, anthropic-direct/claude-opus-5-5") });
		const malformed = await t.set_role_model!.run({ role: "main", model: "anthropic-direct/com espaço" }, ctx());
		expect(malformed).toMatchObject({ ok: false, error: expect.stringContaining("not a valid model id") });
		expect((await settings.get("o1")).roleModels).toEqual({});
	});

	it("update_bot_profile exige o motivo declarado, ao menos um campo e respeita os limites", async () => {
		const settings = new FakeSettings();
		const t = toolsOf(settings);
		const noReason = await t.update_bot_profile!.run({ name: "Zé" }, ctx());
		expect(!noReason.ok && noReason.error).toContain("reason");
		expect(await t.update_bot_profile!.run({ reason: "owner_asked" }, ctx())).toMatchObject({ ok: false, error: "Nothing to change." });
		expect((await t.update_bot_profile!.run({ reason: "owner_asked", snippet: "x".repeat(141) }, ctx())).ok).toBe(false);
		expect((await t.update_bot_profile!.run({ reason: "pedido do site", name: "Zé" }, ctx())).ok).toBe(false);
		expect(await t.update_bot_profile!.run({ reason: "owner_asked", name: "Zé", snippet: "Assistente" }, ctx())).toMatchObject({ ok: true, receipt: { what: "Updated the bot profile (name, snippet)" } });
		expect(await settings.get("o1")).toMatchObject({ name: "Zé", snippet: "Assistente" });
	});

	it("tudo é escopado pelo dono do run", async () => {
		const settings = new FakeSettings();
		const t = toolsOf(settings);
		await t.settings_update!.run({ notify: false }, ctx("userA"));
		expect((await settings.get("userB")).notify).toBe(true);
		expect(settings.updates.every((u) => u.userId === "userA")).toBe(true);
	});

	it("falha do adaptador volta como ok:false com a mensagem real", async () => {
		const settings = new FakeSettings();
		settings.update = async () => {
			throw new Error("Bot not found for this owner.");
		};
		expect(await toolsOf(settings).settings_update!.run({ notify: true }, ctx())).toMatchObject({ ok: false, error: "Bot not found for this owner." });
	});
});

describe("update_bot_profile + confirm always", () => {
	it("pede aprovação mesmo em autonomia total e não altera o perfil", async () => {
		const fake = fakePorts();
		const executor = createExecutor({ runId: "run-1", ownerId: "o1", ports: fake.ports, hash: sha256, policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [{ match: "*", verdict: "run" }] } });
		const tool = createSettingsCapability(new FakeSettings()).tools.find((x) => x.name === "update_bot_profile")!;
		expect(tool.confirm).toBe("always");
		const out = await executor.executeCall({ callId: "a", step: 0, tool, args: { reason: "owner_asked", name: "Zé" } });
		expect(out.status).toBe("pending_approval");
	});

	describe("modo de código (agent-first)", () => {
		const withCode = (available = true) => new FakeSettings(undefined, { codeMode: { environmentAvailable: available } });

		it("a tool só existe quando o adaptador guarda o modo; é write_internal com confirmação sempre", () => {
			expect(createSettingsCapability(new FakeSettings()).tools.map((x) => x.name)).not.toContain("settings_set_code_mode");
			const cap = createSettingsCapability(withCode());
			const tool = cap.tools.find((x) => x.name === "settings_set_code_mode")!;
			expect(tool).toMatchObject({ effect: "write_internal", confirm: "always" });
			expect(tool.description.length).toBeLessThan(700);
			expect(tool.description).toContain("only when the owner asks");
			expect(tool.description).toContain("Do not use it to work on code");
			expect(cap.summary).toContain("code mode");
		});

		it("o dono liga: passa pela aprovação, grava só depois e mostra o resultado em pt-BR", async () => {
			const settings = withCode();
			const t = toolsOf(settings);
			const { ports } = fakePorts();
			const executor = createExecutor({ runId: "run-1", ownerId: "o1", ports, hash: sha256, policy: { surface: "chat", ownerPresent: true, autonomy: "autonomous", rules: [] }, provenance: new RunProvenance() });
			const pending = await executor.executeCall({ callId: "c1", step: 1, tool: t.settings_set_code_mode!, args: { mode: "build" } });
			expect(pending.status).toBe("pending_approval");
			expect(settings.codeModes.get("o1")).toBeUndefined();
			const run = await t.settings_set_code_mode!.run({ mode: "build" }, ctx());
			expect(run.ok && run.receipt?.what).toBe("Modo de código: construir (edita arquivos e roda comandos permitidos)");
			expect(run.ok && run.summary).toContain("applies from the next message");
			expect(settings.codeModes.get("o1")).toBe("build");
			const off = await t.settings_set_code_mode!.run({ mode: "off" }, ctx());
			expect(off.ok && off.receipt?.what).toBe("Modo de código desligado");
			expect(settings.codeModes.get("o1")).toBe("off");
		});

		it("já no modo pedido: não grava nem mostra recibo; ambiente de código ausente é dito de forma honesta", async () => {
			const settings = withCode(false);
			const t = toolsOf(settings);
			const same = await t.settings_set_code_mode!.run({ mode: "off" }, ctx());
			expect(same.ok && same.summary).toContain("already");
			expect(same.ok && same.receipt).toBeUndefined();
			const on = await t.settings_set_code_mode!.run({ mode: "plan" }, ctx());
			expect(on.ok && on.summary).toContain("code environment is not available");
		});

		it("valor fora de off|plan|build é recusado pelo esquema; o dono vem do run, nunca dos argumentos", async () => {
			const settings = withCode();
			const t = toolsOf(settings);
			expect((await t.settings_set_code_mode!.run({ mode: "root" }, ctx())).ok).toBe(false);
			expect((await t.settings_set_code_mode!.run({ mode: "plan", ownerId: "o2" }, ctx("o1"))).ok).toBe(false);
			expect(settings.codeModes.size).toBe(0);
			await t.settings_set_code_mode!.run({ mode: "plan" }, ctx("o1"));
			expect([...settings.codeModes.keys()]).toEqual(["o1"]);
		});

		it("economia: 'Bom dia' não carrega a tool; 'liga o modo de código' carrega no passo 1 (use_capability settings)", async () => {
			const cap = createSettingsCapability(withCode());
			const bomDia = kernelHarness([reply({ text: "Bom dia!" })], { capabilities: [cap] });
			await bomDia.run({ input: { contextSections: [], history: [{ kind: "owner", text: "Bom dia" }] } });
			const first = (bomDia.llm.requests[0]!.tools ?? []).map((x) => x.name);
			expect(first).not.toContain("settings_set_code_mode");
			expect(JSON.stringify(bomDia.llm.requests[0]!.messages)).toContain("code mode");
			const liga = kernelHarness([reply({ calls: [call("u", "use_capability", { id: "settings" })] }), reply({ text: "ok" })], { capabilities: [cap] });
			await liga.run({ input: { contextSections: [], history: [{ kind: "owner", text: "liga o modo de código" }] } });
			expect((liga.llm.requests[0]!.tools ?? []).map((x) => x.name)).toContain("use_capability");
			expect((liga.llm.requests[1]!.tools ?? []).map((x) => x.name)).toContain("settings_set_code_mode");
		});

		it("settings_get mostra o modo", async () => {
			const settings = withCode();
			await settings.codeMode!.set("o1", "plan");
			const out = await toolsOf(settings).settings_get!.run({}, ctx());
			expect(out.ok && out.summary).toContain("Code mode: plan (");
		});
	});
});
