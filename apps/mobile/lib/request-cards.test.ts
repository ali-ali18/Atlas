import { describe, expect, it } from "vitest";
import { applyRunEvent, createLiveState } from "./chat-live";
import { parseChat, serializeChat } from "./chat-cache";
import { ChatApiError, resumeRun, saveVaultLogin, saveVaultSecrets } from "./chat-api";
import { cardKey, dedupeKeys, reconcile, sessionMessageToItem } from "./chat-thread";
import type { ChatItem } from "./chat-types";
import type { ApiFetch } from "./home-sync";
import {
	canSaveSecrets,
	connectorCanAuthorize,
	connectorNote,
	connectorOf,
	drawerFields,
	drawerSave,
	hostOf,
	initialOf,
	isVaultSecretsRequest,
	loginOutcome,
	loginToItem,
	loginVariant,
	resolveIconUri,
	secretEntries,
	secretsBadge,
	secretsToItem,
	siteDomains,
	validLoginCode,
	vaultErrorText,
	vaultLoginBody,
} from "./request-cards";

const row = (id: string, role: string, content: unknown) => ({ id, conversationId: "c1", role, content: JSON.stringify(content), createdAt: "2026-11-01T10:00:00.000Z" }) as never;
const connector = { kind: "native", id: "github", name: "GitHub", description: "Repositórios e issues", icon: "/connectors/github.svg" } as const;
const pageLogin = { v: 1, kind: "login", loginId: "lg1", site: "GitHub", url: "https://www.github.com/login", runId: "r1", status: "pending" as const };
const vaultInfo = { environmentId: "vault", repo: "", names: ["OPENAI_API_KEY", "STRIPE_KEY"], reason: "Preciso das chaves" };

describe("parse do cartão de login (gravado)", () => {
	it("login com conector vira o cartão de conectar app", () => {
		const item = sessionMessageToItem(row("m1", "login", { ...pageLogin, connector }));
		expect(item).toMatchObject({ id: "m1", kind: "login", loginId: "lg1", status: "pending", runId: "r1", connector: { name: "GitHub" } });
		expect(loginVariant(item as never)).toBe("connector");
	});
	it("cartão antigo (só o slug do Composio) também é de conector, aberto como Composio", () => {
		const item = sessionMessageToItem(row("m2", "login", { ...pageLogin, composioToolkit: "gmail" })) as Extract<ChatItem, { kind: "login" }>;
		expect(loginVariant(item)).toBe("connector");
		expect(connectorOf(item)).toMatchObject({ kind: "composio", id: "gmail" });
	});
	it("login sem conector é o cartão de página, com código e Cofre quando o contrato manda", () => {
		const item = sessionMessageToItem(row("m3", "login", { ...pageLogin, codeField: true, vault: { name: "gh", label: "GitHub", domain: "github.com", username: "ana" } })) as Extract<ChatItem, { kind: "login" }>;
		expect(loginVariant(item)).toBe("page");
		expect(item).toMatchObject({ codeField: true, vault: { name: "gh" } });
	});
	it("o cartão nunca carrega credencial: só os campos do contrato passam", () => {
		const item = loginToItem("x", { ...pageLogin, status: "pending", password: "123" } as never);
		expect(JSON.stringify(item)).not.toContain("123");
	});
});

describe("parse do cartão de login (ao vivo)", () => {
	it("o evento `login` vira o mesmo cartão, com a mesma identidade do gravado", () => {
		const state = applyRunEvent(createLiveState(), { type: "login", loginId: "lg1", site: "GitHub", url: "https://github.com/login", connector } as never);
		const live = state.items[0]!;
		expect(live).toMatchObject({ kind: "login", loginId: "lg1", status: "pending" });
		const persisted = sessionMessageToItem(row("m1", "login", { ...pageLogin, connector }))!;
		expect(cardKey(live)).toBe(cardKey(persisted));
		// o gravado manda; o ao vivo com a mesma identidade não aparece de novo
		expect(reconcile([persisted], [live])).toEqual([persisted]);
		expect(dedupeKeys([persisted, live])).toHaveLength(1);
	});
	it("o replay do stream não volta um pedido resolvido a pendente", () => {
		let state = applyRunEvent(createLiveState(), { type: "login", loginId: "lg1", site: "s", url: "https://s.com", status: "pending" } as never);
		state = applyRunEvent(state, { type: "login", loginId: "lg1", site: "s", url: "https://s.com", status: "done" } as never);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({ status: "done" });
		state = applyRunEvent(state, { type: "login", loginId: "lg1", site: "s", url: "https://s.com", status: "pending" } as never);
		expect(state.items[0]).toMatchObject({ status: "done" });
	});
});

describe("parse do cartão de segredo", () => {
	it("confirm com segredos do Cofre vira o cartão de segredo (só os nomes)", () => {
		const item = sessionMessageToItem(row("m4", "confirm", { v: 1, kind: "confirm", confirmId: "k1", title: "Chaves", description: "Para publicar", status: "pending", secretsRequest: vaultInfo }));
		expect(item).toMatchObject({ kind: "secrets", confirmId: "k1", names: ["OPENAI_API_KEY", "STRIPE_KEY"], title: "Chaves", description: "Para publicar", status: "pending" });
	});
	it("segredos de ambiente de código (não é o Cofre) seguem no web", () => {
		const item = sessionMessageToItem(row("m5", "confirm", { v: 1, kind: "confirm", confirmId: "k2", title: "Env", status: "pending", secretsRequest: { ...vaultInfo, environmentId: "env-1", repo: "a/b" } }));
		expect(item).toMatchObject({ kind: "web-card", card: "approval" });
		expect(isVaultSecretsRequest({ ...vaultInfo, environmentId: "env-1" })).toBe(false);
		expect(isVaultSecretsRequest({ ...vaultInfo, names: [] })).toBe(false);
	});
	it("ao vivo: mesma identidade do gravado (`confirm|id`), sem duplicar", () => {
		const state = applyRunEvent(createLiveState(), { type: "confirm", confirmId: "k1", title: "Chaves", secretsRequest: vaultInfo } as never);
		expect(state.paused).toBe(true);
		const live = state.items[0]!;
		expect(live).toMatchObject({ kind: "secrets", status: "pending" });
		const persisted = secretsToItem("m4", { confirmId: "k1", title: "Chaves", status: "approved", secretsRequest: vaultInfo })!;
		expect(reconcile([persisted], [live])).toEqual([persisted]);
	});
});

describe("o segredo não vai para o cache nem para o item", () => {
	const names = vaultInfo.names;
	it("o item do chat só tem nomes; o valor digitado nunca entra nele", () => {
		const values = { OPENAI_API_KEY: "sk-super-secreto", STRIPE_KEY: "" };
		const item = secretsToItem("s", { confirmId: "k", title: "t", secretsRequest: vaultInfo })!;
		expect(JSON.stringify(item)).not.toContain("sk-super-secreto");
		expect(secretEntries(names, values)).toEqual([{ name: "OPENAI_API_KEY", value: "sk-super-secreto" }]);
	});
	it("pendente não vai ao disco; resolvido vai só com nomes e desfecho", () => {
		const pending = secretsToItem("s1", { confirmId: "k1", title: "t", secretsRequest: vaultInfo })!;
		const saved = { ...secretsToItem("s2", { confirmId: "k2", title: "t2", secretsRequest: vaultInfo })!, status: "approved" as const };
		const text = serializeChat([pending, saved], 1);
		const back = parseChat(text, 1)!.items;
		expect(back).toHaveLength(1);
		expect(back[0]).toMatchObject({ kind: "secrets", confirmId: "k2", status: "approved", names });
		expect(text).not.toMatch(/value|senha|password/i);
	});
	it("login pendente não vai ao disco; resolvido vai sem credencial, vault nem código", () => {
		const pending = loginToItem("l1", { ...pageLogin, status: "pending" });
		const done = loginToItem("l2", { ...pageLogin, loginId: "lg2", status: "done", codeField: true, vault: { name: "gh", label: "x", domain: "github.com", username: "ana" }, connector });
		const text = serializeChat([pending, done], 1);
		const back = parseChat(text, 1)!.items;
		expect(back).toHaveLength(1);
		expect(back[0]).toMatchObject({ kind: "login", loginId: "lg2", status: "done" });
		expect(back[0]).not.toHaveProperty("vault");
		expect(back[0]).not.toHaveProperty("codeField");
		expect(text).not.toContain("ana");
	});
});

describe("segredo: botão e desfecho", () => {
	const names = ["A", "B"];
	it("Salvar fica apagado até haver ao menos um valor", () => {
		expect(canSaveSecrets(names, {})).toBe(false);
		expect(canSaveSecrets(names, { A: "" })).toBe(false);
		expect(canSaveSecrets(names, { B: "x" })).toBe(true);
	});
	it("só os campos preenchidos são enviados, na ordem dos nomes", () => {
		expect(secretEntries(names, { B: "2", A: "1", C: "3" })).toEqual([{ name: "A", value: "1" }, { name: "B", value: "2" }]);
	});
	it("selo do desfecho", () => {
		expect(secretsBadge("pending")).toBeNull();
		expect(secretsBadge("approved")).toEqual({ tone: "success", label: "Salvo" });
		expect(secretsBadge("rejected")).toEqual({ tone: "muted", label: "Dispensado" });
		expect(secretsBadge("failed")).toMatchObject({ tone: "danger" });
	});
	it("erros em palavras simples, sem texto técnico", () => {
		expect(vaultErrorText(401)).toMatch(/sessão expirou/);
		expect(vaultErrorText(503)).toMatch(/Cofre/);
		expect(vaultErrorText(null)).toMatch(/conexão/);
		expect(vaultErrorText(500)).not.toMatch(/500|HTTP/);
	});
});

describe("conector: cartão", () => {
	it("só nativo e Composio autorizam pelo navegador; MCP próprio e API abrem no web", () => {
		expect(connectorCanAuthorize(connector)).toBe(true);
		expect(connectorCanAuthorize({ ...connector, kind: "composio" })).toBe(true);
		expect(connectorCanAuthorize({ ...connector, kind: "custom" })).toBe(false);
		expect(connectorCanAuthorize({ ...connector, kind: "api" })).toBe(false);
	});
	it("nota fora do cartão com o nome do bot", () => {
		expect(connectorNote("Atlas")).toBe("O Atlas sempre pergunta antes de fazer alterações. Desconecte quando quiser.");
		expect(connectorNote("  ")).toMatch(/^O bot sempre/);
	});
	it("resolvido mostra Conectado (ou Ativado, sem login); pendente não tem selo", () => {
		const base = loginToItem("l", { ...pageLogin, connector });
		expect(loginOutcome(base)).toBeNull();
		expect(loginOutcome({ ...base, status: "done" })).toEqual({ tone: "success", label: "Conectado" });
		expect(loginOutcome({ ...base, status: "done", connector: { ...connector, noAuth: true } })).toEqual({ tone: "success", label: "Ativado" });
	});
	it("ícone: caminho do app só com servidor, https externo, resto vira inicial", () => {
		expect(resolveIconUri("/connectors/github.svg", "https://atlas.example")).toBe("https://atlas.example/connectors/github.svg");
		expect(resolveIconUri("/connectors/github.svg", null)).toBeNull();
		expect(resolveIconUri("https://logo.example/x.png", null)).toBe("https://logo.example/x.png");
		expect(resolveIconUri("javascript:alert(1)", "https://a.b")).toBeNull();
		expect(resolveIconUri("//evil.example/x.svg", "https://a.b")).toBeNull();
		expect(initialOf("  gmail")).toBe("G");
		expect(initialOf("")).toBe("?");
	});
});

describe("login de página: gaveta e botões", () => {
	const base = loginToItem("l", pageLogin);
	it("domínios do preenchimento: do endereço e do Cofre, sem www nem repetição", () => {
		expect(hostOf("https://www.github.com/login")).toBe("github.com");
		expect(hostOf("github.com")).toBe("github.com");
		expect(hostOf("http://")).toBe("");
		expect(siteDomains(base)).toEqual(["github.com"]);
		expect(siteDomains({ ...base, vault: { name: "n", label: "", domain: "www.github.io" } })).toEqual(["github.com", "github.io"]);
	});
	it("sem Cofre nem captcha: oferece guardar usuário e senha; com código, o campo de código", () => {
		expect(drawerFields(base)).toMatchObject({ credentials: true, code: false, vault: null, captcha: false });
		expect(drawerFields({ ...base, codeField: true })).toMatchObject({ code: true, credentials: true });
	});
	it("com login do Cofre: não pede usuário nem senha; só entra pelo Cofre", () => {
		const vault = { name: "gh", label: "GitHub", domain: "github.com" };
		const fields = drawerFields({ ...base, vault });
		expect(fields).toMatchObject({ credentials: false, vault });
		expect(drawerSave(fields, { code: "", username: "", password: "" })).toEqual({ kind: "vault", enabled: true });
	});
	it("captcha e Cofre já tentado: nenhum campo, só abrir a tela", () => {
		expect(drawerFields({ ...base, reason: "captcha" })).toMatchObject({ credentials: false, code: false, captcha: true });
		expect(drawerFields({ ...base, vaultTried: "senha usada" })).toMatchObject({ credentials: false });
		expect(drawerSave(drawerFields({ ...base, reason: "captcha" }), { code: "", username: "", password: "" })).toEqual({ kind: "none", enabled: false });
	});
	it("Salvar: código válido tem prioridade; usuário e senha juntos; vazio fica apagado", () => {
		const fields = drawerFields({ ...base, codeField: true });
		expect(drawerSave(fields, { code: "12", username: "", password: "" })).toEqual({ kind: "code", enabled: false });
		expect(drawerSave(fields, { code: "123 456", username: "", password: "" })).toEqual({ kind: "code", enabled: true });
		expect(drawerSave(fields, { code: "", username: "ana", password: "" })).toMatchObject({ enabled: false });
		expect(drawerSave(fields, { code: "", username: "ana", password: "s" })).toEqual({ kind: "credentials", enabled: true });
	});
	it("código: 3 a 12 letras, números ou hífen (a regra do servidor)", () => {
		expect(validLoginCode("123456")).toBe(true);
		expect(validLoginCode("AB-12")).toBe(true);
		expect(validLoginCode("12")).toBe(false);
		expect(validLoginCode("1234567890123")).toBe(false);
		expect(validLoginCode("12$456")).toBe(false);
	});
	it("o corpo do Cofre usa o site do cartão e nome válido", () => {
		const body = vaultLoginBody(base, " ana@x.com ", "senha");
		expect(body).toMatchObject({ kind: "login", name: "github-com", siteUrl: "https://www.github.com/login", username: "ana@x.com", password: "senha" });
		expect(body.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});
	it("selo do desfecho: Concluído, ou Verificado no captcha; pendente sem selo", () => {
		expect(loginOutcome(base)).toBeNull();
		expect(loginOutcome({ ...base, status: "done" })).toEqual({ tone: "success", label: "Concluído" });
		expect(loginOutcome({ ...base, status: "done", reason: "captcha" })).toEqual({ tone: "success", label: "Verificado" });
	});
});

describe("chamadas: contrato do web", () => {
	function fake(status = 200, payload: unknown = {}) {
		const calls: Array<{ path: string; method?: string; body: unknown }> = [];
		const apiFetch: ApiFetch = async (path, init) => {
			calls.push({ path, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
			return new Response(JSON.stringify(payload), { status });
		};
		return { apiFetch, calls };
	}
	it("resume: sem opção não manda corpo; Cofre e código vão como o web manda", async () => {
		const { apiFetch, calls } = fake(202, { enqueued: true });
		expect(await resumeRun(apiFetch, "r 1")).toEqual({ enqueued: true });
		await resumeRun(apiFetch, "r1", { via: "vault" });
		await resumeRun(apiFetch, "r1", { via: "code", code: "123456" });
		expect(calls.map((call) => [call.path, call.method, call.body])).toEqual([
			["/v1/runs/r%201/resume", "POST", undefined],
			["/v1/runs/r1/resume", "POST", { via: "vault" }],
			["/v1/runs/r1/resume", "POST", { via: "code", code: "123456" }],
		]);
	});
	it("segredos: POST /v1/vault/secrets com `entries` e `mode: upsert`; erro sobe com o status", async () => {
		const { apiFetch, calls } = fake(201, { saved: [] });
		await saveVaultSecrets(apiFetch, [{ name: "A", value: "v" }]);
		expect(calls[0]).toEqual({ path: "/v1/vault/secrets", method: "POST", body: { entries: [{ name: "A", value: "v" }], mode: "upsert" } });
		const failing = fake(503, { error: "Cofre indisponível" });
		await expect(saveVaultSecrets(failing.apiFetch, [{ name: "A", value: "v" }])).rejects.toMatchObject({ status: 503 });
		await expect(saveVaultSecrets(failing.apiFetch, [])).rejects.toBeInstanceOf(ChatApiError);
	});
	it("login do Cofre: POST /v1/vault com kind login", async () => {
		const { apiFetch, calls } = fake(201, { item: {} });
		await saveVaultLogin(apiFetch, vaultLoginBody(loginToItem("l", pageLogin), "ana", "s"));
		expect(calls[0]).toMatchObject({ path: "/v1/vault", method: "POST", body: { kind: "login", username: "ana", password: "s" } });
	});
});
