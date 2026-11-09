import { describe, expect, it } from "vitest";
import { describeRoutineLoginPermission, loginPermissionAllowsPage, parseRoutineLoginAccess, parseRoutineLoginPermission } from "./routine-login-permission.js";

describe("parseRoutineLoginAccess", () => {
	it("normaliza o site (www, esquema, caminho)", () => {
		const parsed = parseRoutineLoginAccess({ login: "banco", site: "https://www.Banco.example/entrar?x=1" });
		expect(parsed).toEqual({ ok: true, permission: { login: "banco", site: "banco.example" } });
	});
	it("recusa campo desconhecido, login inválido e site ilegível, com o que é aceito", () => {
		expect(parseRoutineLoginAccess({ login: "banco", site: "a.example", extra: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("Accepted: login, site") });
		expect(parseRoutineLoginAccess({ login: "com espaço", site: "a.example" })).toMatchObject({ ok: false });
		expect(parseRoutineLoginAccess({ login: "banco", site: "" })).toMatchObject({ ok: false });
		expect(parseRoutineLoginAccess("banco")).toMatchObject({ ok: false });
	});
});

describe("parseRoutineLoginPermission", () => {
	it("lê o que foi gravado e ignora lixo", () => {
		expect(parseRoutineLoginPermission({ login: "banco", site: "www.banco.example", approvedAt: "2026-11-09T10:00:00.000Z" })).toEqual({ login: "banco", site: "banco.example", approvedAt: "2026-11-09T10:00:00.000Z" });
		expect(parseRoutineLoginPermission(null)).toBeNull();
		expect(parseRoutineLoginPermission({ login: "banco" })).toBeNull();
		expect(parseRoutineLoginPermission([])).toBeNull();
	});
});

describe("loginPermissionAllowsPage", () => {
	const permission = { site: "banco.example" };
	it("aceita o mesmo site, com ou sem www e qualquer caminho", () => {
		expect(loginPermissionAllowsPage(permission, "https://www.banco.example/entrar")).toBe(true);
		expect(loginPermissionAllowsPage(permission, "https://banco.example/")).toBe(true);
	});
	it("recusa outro site, subdomínio e parecido", () => {
		expect(loginPermissionAllowsPage(permission, "https://banco.example.evil.test/")).toBe(false);
		expect(loginPermissionAllowsPage(permission, "https://app.banco.example/")).toBe(false);
		expect(loginPermissionAllowsPage(permission, "about:blank")).toBe(false);
	});
});

it("descreve a permissão em frase", () => {
	expect(describeRoutineLoginPermission({ login: "banco", site: "banco.example" })).toBe("o login banco para entrar em banco.example");
});
