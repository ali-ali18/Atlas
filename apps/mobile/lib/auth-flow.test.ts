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
		expect(redirectFor("no-server", "/connect")).toBeNull();
		expect(redirectFor("no-server", "/login")).toBe("/connect");
		expect(redirectFor("no-server", "/")).toBe("/connect");
	});
	it("sem sessão, só o Login (nem a home)", () => {
		expect(redirectFor("signed-out", "/login")).toBeNull();
		expect(redirectFor("signed-out", "/connect")).toBe("/login");
		expect(redirectFor("signed-out", "/")).toBe("/login");
		expect(redirectFor("signed-out", "/syncing")).toBe("/login");
	});
	it("com sessão e carregado, o chat e a home ficam; as telas de entrada voltam à home", () => {
		expect(redirectFor("signed-in", "/chat/abc", true)).toBeNull();
		expect(redirectFor("signed-in", "/", true)).toBeNull();
		expect(redirectFor("signed-in", "/login", true)).toBe("/");
		expect(redirectFor("signed-in", "/chat/abc", false)).toBe("/syncing");
	});
	it("com sessão e sem carregar, vai ao carregamento (inclusive abrindo direto na home)", () => {
		expect(redirectFor("signed-in", "/syncing", false)).toBeNull();
		expect(redirectFor("signed-in", "/login", false)).toBe("/syncing");
		expect(redirectFor("signed-in", "/", false)).toBe("/syncing");
		expect(redirectFor("signed-in", "/connect")).toBe("/syncing");
	});
	it("carregado, vai para a home e não volta às telas de entrada", () => {
		expect(redirectFor("signed-in", "/syncing", true)).toBe("/");
		expect(redirectFor("signed-in", "/login", true)).toBe("/");
		expect(redirectFor("signed-in", "/connect", true)).toBe("/");
		expect(redirectFor("signed-in", "/", true)).toBeNull();
		expect(redirectFor("signed-in", "/conversas", true)).toBeNull();
	});
});
