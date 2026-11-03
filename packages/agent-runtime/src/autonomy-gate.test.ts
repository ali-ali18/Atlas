import { describe, expect, it } from "vitest";
import { isReadOnlyConnectorOrigin, isUnattendedOrigin } from "./autonomy-gate.js";

describe("origens em que o conector só entrega leitura", () => {
	it("rotina, webhook, proativo, e-mail e bot→bot entram; chat e subagente não", () => {
		for (const origin of ["routine", "webhook", "proactive", "email", "bot"]) expect(isReadOnlyConnectorOrigin(origin), origin).toBe(true);
		for (const origin of ["chat", "subagent", "api", undefined]) expect(isReadOnlyConnectorOrigin(origin), String(origin)).toBe(false);
	});
	it("subagente continua sem humano para as demais regras (sem confirmação)", () => {
		expect(isUnattendedOrigin("subagent")).toBe(true);
	});
});
