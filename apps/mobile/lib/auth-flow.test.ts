import { describe, expect, it } from "vitest";
import { phaseOf, redirectFor } from "./auth-flow";

describe("phaseOf", () => {
	const base = { loaded: true, serverUrl: "https://a.test", sessionPending: false, hasSession: false };
	it("espera o endereço salvo carregar", () => expect(phaseOf({ ...base, loaded: false })).toBe("loading"));
	it("sem servidor", () => expect(phaseOf({ ...base, serverUrl: null })).toBe("no-server"));
	it("verificando a sessão", () => expect(phaseOf({ ...base, sessionPending: true })).toBe("loading"));
	it("sessão em cache vale enquanto confere", () => expect(phaseOf({ ...base, sessionPending: true, hasSession: true })).toBe("signed-in"));
	it("sem sessão", () => expect(phaseOf(base)).toBe("signed-out"));
	it("com sessão", () => expect(phaseOf({ ...base, hasSession: true })).toBe("signed-in"));
});

describe("redirectFor", () => {
	it("não mexe enquanto carrega", () => expect(redirectFor("loading", "/login")).toBeNull());
	it("sem servidor, só a Conexão", () => {
		expect(redirectFor("no-server", "/")).toBeNull();
		expect(redirectFor("no-server", "/login")).toBe("/");
		expect(redirectFor("no-server", "/home")).toBe("/");
	});
	it("sem sessão, só o Login (nem a tela de conectado)", () => {
		expect(redirectFor("signed-out", "/login")).toBeNull();
		expect(redirectFor("signed-out", "/")).toBe("/login");
		expect(redirectFor("signed-out", "/home")).toBe("/login");
		expect(redirectFor("signed-out", "/syncing")).toBe("/login");
	});
	it("com sessão, Sincronizando e Conectado", () => {
		expect(redirectFor("signed-in", "/syncing")).toBeNull();
		expect(redirectFor("signed-in", "/home")).toBeNull();
		expect(redirectFor("signed-in", "/chat/abc")).toBeNull();
		expect(redirectFor("signed-in", "/chatter")).toBe("/syncing");
		expect(redirectFor("signed-in", "/connected")).toBe("/syncing");
		expect(redirectFor("signed-in", "/login")).toBe("/syncing");
		expect(redirectFor("signed-in", "/")).toBe("/syncing");
	});
});
