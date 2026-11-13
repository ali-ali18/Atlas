import { describe, expect, it } from "vitest";
import { parseLoginRequestInfo, parseSecretsRequestInfo } from "./dev-env-auto.js";
import { loginFieldDecls, loginFieldsView, mergeLoginFields, parseLoginFieldDecls, readStoredLoginFields } from "./vault-login.js";

const f = (key: string, value = "v", secret = false) => ({ key, label: key.toUpperCase(), secret, value });

describe("parseLoginFieldDecls", () => {
	it("aceita campos declarados (chave, rótulo, secreto) e devolve nessa ordem", () => {
		expect(parseLoginFieldDecls([{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }])).toEqual({
			fields: [{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }],
		});
	});

	it("recusa vazio, excesso, chave inválida ou repetida, rótulo vazio, secreto ausente e propriedade desconhecida, dizendo o aceito", () => {
		const bad: unknown[] = [
			undefined,
			[],
			Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: "L", secret: false })),
			[{ key: "com espaço", label: "L", secret: false }],
			[{ key: "a", label: "L", secret: false }, { key: "a", label: "M", secret: true }],
			[{ key: "a", label: "  ", secret: false }],
			[{ key: "a", label: "L" }],
			[{ key: "a", label: "L", secret: false, value: "oops" }],
			["a"],
		];
		for (const raw of bad) expect(parseLoginFieldDecls(raw)).toHaveProperty("error");
	});
});

describe("mergeLoginFields", () => {
	it("acrescenta campos novos sem apagar os anteriores; mesma chave troca valor e sigilo", () => {
		const merged = mergeLoginFields([f("email", "a@x"), f("senha", "velha", true)], [f("senha", "nova", true), f("cpf", "1", true)]);
		expect(merged.map((x) => [x.key, x.value])).toEqual([["email", "a@x"], ["senha", "nova"], ["cpf", "1"]]);
	});

	it("não muta os argumentos", () => {
		const a = [f("a")];
		mergeLoginFields(a, [f("b")]);
		expect(a).toHaveLength(1);
	});
});

describe("loginFieldsView (compatibilidade com login antigo)", () => {
	it("usuário em claro vira `username` (não secreto) e a senha cifrada vira `password` (secreta), sem migrar", () => {
		expect(loginFieldsView({ username: "dono@x", password: "s3nh4" })).toEqual([
			{ key: "username", label: "Usuário", secret: false, value: "dono@x" },
			{ key: "password", label: "Senha", secret: true, value: "s3nh4" },
		]);
	});

	it("campo declarado com a mesma chave vence o legado; login novo não ganha campos legados vazios", () => {
		expect(loginFieldsView({ username: "velho", password: "velha", fields: [f("username", "novo"), f("password", "nova", true)] }).map((x) => x.value)).toEqual(["novo", "nova"]);
		expect(loginFieldsView({ fields: [f("email")] }).map((x) => x.key)).toEqual(["email"]);
	});
});

describe("loginFieldDecls e readStoredLoginFields", () => {
	it("a declaração não leva o valor", () => {
		expect(JSON.stringify(loginFieldDecls([f("cpf", "123", true)]))).not.toContain("123");
	});

	it("dado corrompido do selado vira lista vazia ou descarta o item ruim", () => {
		expect(readStoredLoginFields(undefined)).toEqual([]);
		expect(readStoredLoginFields("x")).toEqual([]);
		expect(readStoredLoginFields([{ key: "ok", value: "v", label: "Ok", secret: false }, { key: "mau chave", value: "v" }, { key: "sem", value: 3 }, null])).toEqual([{ key: "ok", label: "Ok", secret: false, value: "v" }]);
	});
});

describe("pedido de login no cartão (SecretsRequestInfo)", () => {
	const login = { site: "plataforma.example", name: "plataforma", fields: [{ key: "nome", label: "Nome", secret: false }, { key: "cpf", label: "CPF", secret: true }] };

	it("o cofre com `login` usa as chaves dos campos como names e guarda o login", () => {
		const info = parseSecretsRequestInfo({ environmentId: "vault", repo: "", names: ["ignorado"], reason: "x", login });
		expect(info).toEqual({ environmentId: "vault", repo: "", names: ["nome", "cpf"], reason: "x", login });
	});

	it("login inválido (sem site, sem campos) cai no pedido simples; fora do cofre `login` é ignorado", () => {
		expect(parseLoginRequestInfo({ site: "", fields: login.fields })).toBeUndefined();
		expect(parseLoginRequestInfo({ site: "a.example", fields: [] })).toBeUndefined();
		expect(parseSecretsRequestInfo({ environmentId: "vault", repo: "", names: ["a"], reason: "", login: { site: "", fields: [] } })?.login).toBeUndefined();
		expect(parseSecretsRequestInfo({ environmentId: "env-1", repo: "r", names: ["A"], reason: "", login })?.login).toBeUndefined();
	});
});
