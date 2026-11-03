import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// O noVNC faz `Log.Info(`connecting to ${url}`)` ao conectar, e a URL do WebSocket leva o token. A página liga o log em
// "none" antes de qualquer conexão (entrada do bundle em scripts/build-novnc-bundle.mjs).
describe("log do noVNC não pode vazar o endereço do WebSocket (token)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("o núcleo do pacote loga a URL no nível 'info' (por isso o bundle desliga o log)", async () => {
		const calls: string[] = [];
		const fake = (name: string) => (...args: unknown[]) => calls.push(`${name}:${args.join(" ")}`);
		const console_ = { debug: fake("debug"), info: fake("info"), warn: fake("warn"), error: fake("error") };
		vi.stubGlobal("window", { console: console_, Error });
		vi.stubGlobal("console", console_);
		const Log = await import(path.join(root, "node_modules/@novnc/novnc/core/util/logging.js"));
		Log.initLogging("info");
		Log.Info("connecting to wss://h/v1/x?t=SEGREDO");
		expect(calls.join("\n")).toContain("SEGREDO");
	});

	it('com initLogging("none") nenhum nível chega ao console, nem com a URL com token', async () => {
		const calls: string[] = [];
		const fake = (name: string) => (...args: unknown[]) => calls.push(`${name}:${args.join(" ")}`);
		const console_ = { debug: fake("debug"), info: fake("info"), warn: fake("warn"), error: fake("error") };
		vi.stubGlobal("window", { console: console_, Error });
		vi.stubGlobal("console", console_);
		const Log = await import(path.join(root, "node_modules/@novnc/novnc/core/util/logging.js"));
		Log.initLogging("none");
		Log.Debug("connecting to wss://h/v1/x?t=SEGREDO");
		Log.Info("connecting to wss://h/v1/x?t=SEGREDO");
		Log.Warn("connecting to wss://h/v1/x?t=SEGREDO");
		Log.Error("connecting to wss://h/v1/x?t=SEGREDO");
		expect(calls).toEqual([]);
	});

	it('a entrada do bundle chama initLogging("none") antes de expor o RFB, e só nesse nível', () => {
		const script = readFileSync(path.join(root, "scripts/build-novnc-bundle.mjs"), "utf8");
		const calls = [...script.matchAll(/Log\.initLogging\(([^)]*)\)/g)].map((m) => m[1]);
		expect(calls).toEqual(['"none"']);
		expect(script.indexOf('Log.initLogging("none")')).toBeLessThan(script.indexOf("window.NoVNC = { RFB }"));
		expect(script).toContain("core\", \"util\", \"logging.js\"");
	});
});
