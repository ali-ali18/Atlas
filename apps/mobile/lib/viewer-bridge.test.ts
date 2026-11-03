import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { bridgeCall, parseBridgeMessage } from "./viewer-bridge";

describe("mensagens da página para o app", () => {
	it("aceita os tipos conhecidos", () => {
		for (const t of ["ready", "connected", "securityfailure", "credentialsrequired", "error"]) {
			expect(parseBridgeMessage(JSON.stringify({ t }))).toEqual({ t });
		}
		expect(parseBridgeMessage('{"t":"disconnected","clean":true}')).toEqual({ t: "disconnected", clean: true });
		expect(parseBridgeMessage('{"t":"disconnected","clean":false}')).toEqual({ t: "disconnected", clean: false });
	});
	it("descarta campos extras (o evento sai só com o que é conhecido)", () => {
		expect(parseBridgeMessage('{"t":"error","detail":"wss://x/?t=SEGREDO"}')).toEqual({ t: "error" });
	});
	it("ignora mensagem desconhecida ou malformada", () => {
		for (const raw of ['{"t":"hack"}', '{"t":1}', "{}", "[]", "null", "42", '"connected"', "não é json", "", '{"t":"disconnected"}', '{"t":"disconnected","clean":"yes"}', undefined, null, 5, {}, "x".repeat(300)]) {
			expect(parseBridgeMessage(raw)).toBeNull();
		}
	});
});

describe("chamadas do app para a página", () => {
	it("monta a chamada com os argumentos em JSON, terminando em true", () => {
		expect(bridgeCall("setViewOnly", false)).toBe("window.__bridge&&window.__bridge.setViewOnly.apply(null,[false]);true;");
		expect(bridgeCall("keys", [97, 0xff0d])).toBe("window.__bridge&&window.__bridge.keys.apply(null,[[97,65293]]);true;");
	});
	it("texto com aspas, quebras e barras não escapa do argumento", () => {
		const hostile = `wss://h/p?t=a"b'c\n </script>\\`;
		const calls: unknown[][] = [];
		const context = vm.createContext({ window: { __bridge: { connect: (...args: unknown[]) => calls.push(args) } } });
		vm.runInContext(bridgeCall("connect", hostile, true), context);
		expect(calls).toEqual([[hostile, true]]);
	});
	it("sem a ponte na página não lança", () => {
		const context = vm.createContext({ window: {} });
		expect(() => vm.runInContext(bridgeCall("disconnect"), context)).not.toThrow();
	});
});
