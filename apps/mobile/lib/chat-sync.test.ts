import { describe, expect, it } from "vitest";
import { initialSync, syncLine, syncReducer, type SyncAction } from "./chat-sync";

const run = (...actions: SyncAction["type"][]) => actions.reduce((state, type) => syncReducer(state, { type }), initialSync);

describe("estado da sincronização", () => {
	it("começa parado, sem linha", () => {
		expect(syncLine(initialSync)).toBeNull();
	});
	it("verifica e some quando termina", () => {
		expect(syncLine(run("start"))).toEqual({ kind: "checking", text: "Verificando novas mensagens…" });
		expect(syncLine(run("start", "success"))).toBeNull();
	});
	it("duas conferências em voo: a linha só some quando a última termina", () => {
		const state = run("start", "start", "success");
		expect(state.phase).toBe("checking");
		expect(run("start", "start", "success", "success").phase).toBe("idle");
	});
	it("falha de rede mostra um 'Sem conexão' discreto; falha do servidor some sem alarde", () => {
		expect(syncLine(run("start", "network-failure"))).toEqual({ kind: "offline", text: "Sem conexão" });
		expect(syncLine(run("start", "failure"))).toBeNull();
	});
	it("a próxima conferência troca 'sem conexão' por 'verificando' e uma boa limpa", () => {
		expect(run("start", "network-failure", "start").phase).toBe("checking");
		expect(run("start", "network-failure", "start", "success").phase).toBe("idle");
	});
	it("nunca fica com contagem negativa", () => {
		expect(run("success", "failure").inFlight).toBe(0);
		expect(run("start", "reset")).toEqual(initialSync);
	});
});
