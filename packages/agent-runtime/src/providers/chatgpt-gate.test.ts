import { describe, expect, it } from "vitest";
import { accountChatgptGate, envChatgptGate } from "./chatgpt-gate.js";

const configs: Record<string, unknown> = {
	on: { v: 1, providers: { chatgptEnabled: true } },
	off: { v: 1, providers: { chatgptEnabled: false } },
	other: { v: 1, models: { default: "a/b" } },
};
const load = async (userId: string) => (configs[userId] ?? { v: 1 }) as never;

describe("porta do plano ChatGPT", () => {
	it("env é só o padrão: desligado por omissão, ligado com true", async () => {
		expect(await envChatgptGate({})("x")).toEqual({ enabled: false, source: "default" });
		expect(await envChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "true" })("x")).toEqual({ enabled: true, source: "env" });
		expect(await envChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "false" })("x")).toEqual({ enabled: false, source: "env" });
	});

	it("a conta vence o env nos dois sentidos", async () => {
		const offEnv = accountChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "false" }, load);
		expect(await offEnv("on")).toEqual({ enabled: true, source: "user" });
		const onEnv = accountChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "true" }, load);
		expect(await onEnv("off")).toEqual({ enabled: false, source: "user" });
	});

	it("sem escolha do usuário herda o env; cada usuário tem a sua porta", async () => {
		const gate = accountChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "true" }, load);
		expect(await gate("other")).toEqual({ enabled: true, source: "env" });
		expect(await gate("ninguem")).toEqual({ enabled: true, source: "env" });
		expect((await gate("off")).enabled).toBe(false);
		expect((await gate("on")).enabled).toBe(true);
	});

	it("falha ao ler a conta cai no env, nunca liga por engano", async () => {
		const failing = async () => {
			throw new Error("db fora");
		};
		expect(await accountChatgptGate({}, failing)("on")).toEqual({ enabled: false, source: "default" });
		expect((await accountChatgptGate({ ATLAS_PROVIDER_CHATGPT_ENABLED: "true" }, failing)("on")).enabled).toBe(true);
	});
});
