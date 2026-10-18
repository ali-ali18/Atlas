import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRunBase } from "./run-setup.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function tracker() {
	let running = 0;
	let peak = 0;
	const order: string[] = [];
	const step = <T>(name: string, value: T, fail?: Error) => async () => {
		running += 1;
		peak = Math.max(peak, running);
		order.push(`start:${name}`);
		await tick();
		running -= 1;
		order.push(`end:${name}`);
		if (fail) throw fail;
		return value;
	};
	return { step, peak: () => peak, order };
}

test("L10: leituras independentes rodam juntas e o resultado é o mesmo da ordem serial", async () => {
	const t = tracker();
	const base = await loadRunBase({
		getSettings: t.step("settings", { sandboxAutoStart: true }),
		defaultSettings: { sandboxAutoStart: false },
		getCheckpoint: t.step("checkpoint", { nextStepIndex: 3 }),
		getBotPolicy: t.step("policy", { p: 1 }),
		getLanguage: t.step("language", "en-US"),
		resolveAutonomy: t.step("autonomy", { level: "balanced" }),
		loadMcp: t.step("mcp", { tools: 2 }),
	});
	assert.deepEqual(base, {
		settings: { sandboxAutoStart: true },
		checkpoint: { nextStepIndex: 3 },
		rawBotPolicy: { p: 1 },
		language: "en-US",
		autonomy: { level: "balanced" },
		mcp: { tools: 2 },
	});
	assert.equal(t.peak(), 5, "5 leituras simultâneas (settings, checkpoint, política, idioma, autonomia)");
	// Conectores dependem da autonomia: só começam depois dela terminar.
	assert.ok(t.order.indexOf("start:mcp") > t.order.indexOf("end:autonomy"));
});

test("L10: falha de settings usa o padrão; falha de conectores segue sem conectores", async () => {
	const t = tracker();
	const errors: string[] = [];
	const base = await loadRunBase({
		getSettings: t.step("settings", { sandboxAutoStart: true }, new Error("settings down")),
		defaultSettings: { sandboxAutoStart: false },
		onSettingsError: (error) => errors.push((error as Error).message),
		getCheckpoint: t.step("checkpoint", null),
		getBotPolicy: t.step("policy", null),
		getLanguage: t.step("language", "pt-BR"),
		resolveAutonomy: t.step("autonomy", "a"),
		loadMcp: t.step("mcp", "m", new Error("mcp down")),
		onMcpError: (error) => errors.push((error as Error).message),
	});
	assert.deepEqual(base.settings, { sandboxAutoStart: false });
	assert.equal(base.mcp, null);
	assert.deepEqual(errors.sort(), ["mcp down", "settings down"]);
});

test("L10: falha de leitura obrigatória rejeita o setup (sem engolir)", async () => {
	const t = tracker();
	await assert.rejects(
		loadRunBase({
			getSettings: t.step("settings", {}),
			defaultSettings: {},
			getCheckpoint: t.step("checkpoint", null, new Error("checkpoint down")),
			getBotPolicy: t.step("policy", null),
			getLanguage: t.step("language", "pt-BR"),
			resolveAutonomy: t.step("autonomy", "a"),
			loadMcp: t.step("mcp", "m"),
		}),
		/checkpoint down/,
	);
});
