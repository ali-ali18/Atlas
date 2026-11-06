import { type DecideInput } from "@workspace/shared";
import { describe, expect, it } from "vitest";
import { type AuthorizeFacts, authorize } from "./authorize.js";

type KeysDeep<T> = T extends object ? keyof T | { [K in keyof T]: KeysDeep<T[K]> }[keyof T] : never;
type FreeText = "text" | "message" | "objective" | "content" | "body" | "prompt" | "subject" | "summary" | "result" | "output";

describe("autorizador não lê conteúdo (cláusula 7)", () => {
	it("a entrada não tem campo de texto livre nem de resultado (guarda de tipo)", () => {
		const ok: [Extract<KeysDeep<AuthorizeFacts>, FreeText>] extends [never] ? true : false = true;
		expect(ok).toBe(true);
	});

	it("conteúdo extra não compila na entrada", () => {
		const facts: AuthorizeFacts = { surface: "chat", ownerPresent: true, autonomy: "balanced", rules: [], effect: "read", toolName: "x", taint: { untrustedReadInRun: false, argsCarryUntrusted: false }, now: new Date(0) };
		// @ts-expect-error o autorizador não aceita conteúdo de resultado
		const withContent: AuthorizeFacts = { ...facts, content: "corpo do e-mail" };
		expect(authorize(facts).kind).toBe("run");
		expect(withContent).toBeDefined();
	});

	it("DecideInput continua sem texto livre", () => {
		const ok: [Extract<KeysDeep<DecideInput>, FreeText>] extends [never] ? true : false = true;
		expect(ok).toBe(true);
	});
});
