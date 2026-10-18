import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { memoryVaultStore } from "./memory-store.js";
import { itemAad, newDataKey, openItem, rewrapDataKey, sealItem, unwrapDataKey, wrapDataKey } from "./envelope.js";
import { createRedactor } from "./redact.js";
import { injectSecretRefs, createSecretSession, secretToolPolicy, SecretRefError } from "./session.js";
import { base32Decode, hotp, parseTotpInput, totpAt } from "./totp.js";
import { VaultError, VaultService } from "./vault-service.js";
import { maskKnownSecrets } from "./mask.js";

beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("envelope", () => {
	it("cifra com a chave do usuário e AAD userId:itemId", () => {
		const key = newDataKey();
		const sealed = sealItem(key, itemAad("u1", "i1"), { value: "segredo-123456" });
		expect(sealed.startsWith("v2:")).toBe(true);
		expect(sealed).not.toContain("segredo-123456");
		expect(openItem<{ value: string }>(key, itemAad("u1", "i1"), sealed).value).toBe("segredo-123456");
		expect(() => openItem(key, itemAad("u2", "i1"), sealed)).toThrow();
		expect(() => openItem(key, itemAad("u1", "i2"), sealed)).toThrow();
		expect(() => openItem(newDataKey(), itemAad("u1", "i1"), sealed)).toThrow();
	});

	it("rotação da chave mestra reembrulha só a chave do usuário", () => {
		const oldMaster = Buffer.from(process.env.CONNECTOR_ENCRYPTION_KEY!, "base64");
		const dataKey = newDataKey();
		const wrapped = wrapDataKey(dataKey, oldMaster);
		const item = sealItem(dataKey, itemAad("u", "i"), { value: "abcdefgh" });
		const newMaster = randomBytes(32);
		process.env.CONNECTOR_ENCRYPTION_KEY = newMaster.toString("base64");
		process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS = oldMaster.toString("base64");
		try {
			// antiga ainda abre via PREVIOUS; depois do rewrap abre só com a nova
			expect(unwrapDataKey(wrapped).equals(dataKey)).toBe(true);
			const rewrapped = rewrapDataKey(wrapped);
			delete process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS;
			expect(unwrapDataKey(rewrapped).equals(dataKey)).toBe(true);
			expect(() => unwrapDataKey(wrapped)).toThrow();
			expect(openItem<{ value: string }>(unwrapDataKey(rewrapped), itemAad("u", "i"), item).value).toBe("abcdefgh");
		} finally {
			process.env.CONNECTOR_ENCRYPTION_KEY = oldMaster.toString("base64");
			delete process.env.CONNECTOR_ENCRYPTION_KEY_PREVIOUS;
		}
	});
});

describe("TOTP (RFC 6238)", () => {
	const secret = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
	it("vetores SHA-1 do apêndice B", () => {
		expect(secret.toString("utf8")).toBe("12345678901234567890");
		expect(hotp(secret, Math.floor(59 / 30), 8)).toBe("94287082");
		expect(hotp(secret, Math.floor(1111111109 / 30), 8)).toBe("07081804");
		expect(hotp(secret, Math.floor(2000000000 / 30), 8)).toBe("69279037");
	});
	it("totpAt com 6 dígitos e janela", () => {
		const result = totpAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000);
		expect(result.code).toBe("287082");
		expect(result.expiresInSec).toBe(1);
	});
	it("aceita otpauth:// e rejeita lixo", () => {
		const parsed = parseTotpInput("otpauth://totp/Site:eu@x.com?secret=gezd gnbv&issuer=Site&digits=8&period=60");
		expect(parsed).toMatchObject({ digits: 8, period: 60, algorithm: "sha1" });
		expect(parseTotpInput("não é base32 !!")).toBeNull();
		expect(parseTotpInput("otpauth://hotp/x?secret=ABC")).toBeNull();
	});
});

describe("redação", () => {
	it("literal, URL-encoded e base64", () => {
		const value = "p@ss w0rd/ç!";
		const redactor = createRedactor([{ value, marker: "{{secret:x}}" }]);
		expect(redactor.text(`a ${value} b`)).toBe("a {{secret:x}} b");
		expect(redactor.text(`?k=${encodeURIComponent(value)}`)).toBe("?k={{secret:x}}");
		expect(redactor.text(`auth ${Buffer.from(value).toString("base64")}`)).toBe("auth {{secret:x}}");
		expect(redactor.text(`b64url ${Buffer.from(value).toString("base64url")}`)).toBe("b64url {{secret:x}}");
		expect(redactor.deep({ a: [`x ${value}`], n: 1 })).toEqual({ a: ["x {{secret:x}}"], n: 1 });
	});
	it("ignora valores curtos demais", () => {
		expect(createRedactor([{ value: "ab", marker: "M" }]).text("ab ab")).toBe("ab ab");
	});
});

describe("cofre: CRUD, isolamento e criptografia", () => {
	it("guarda cifrado, lista só metadados e isola por dono", async () => {
		const store = memoryVaultStore();
		const vault = new VaultService(store);
		const meta = await vault.create("alice", { kind: "secret", name: "openai", description: "chave", payload: { value: "sk-super-secreto-123456" } });
		expect(JSON.stringify(store.rows)).not.toContain("sk-super-secreto-123456");
		expect(store.keys.has("alice")).toBe(true);
		expect(JSON.stringify(await vault.listMeta("alice"))).not.toContain("sk-super");
		// outro usuário: 404 em tudo
		await expect(vault.getMeta("bob", meta.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(vault.reveal("bob", meta.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(vault.update("bob", meta.id, { description: "x" })).rejects.toMatchObject({ code: "not_found" });
		await expect(vault.remove("bob", meta.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(vault.auditLog("bob", meta.id)).rejects.toMatchObject({ code: "not_found" });
		expect(await vault.listMeta("bob")).toEqual([]);
		// dono revela (audita), edita, renomeia e apaga
		const revealed = await vault.reveal("alice", meta.id);
		expect(revealed.payload.value).toBe("sk-super-secreto-123456");
		await vault.update("alice", meta.id, { name: "openai-2", payload: { value: "novo-valor-654321" } });
		expect((await vault.reveal("alice", meta.id)).payload.value).toBe("novo-valor-654321");
		const log = await vault.auditLog("alice", meta.id);
		expect(log.map((entry) => entry.action)).toEqual(expect.arrayContaining(["created", "revealed", "updated"]));
		await vault.remove("alice", meta.id);
		expect(await vault.listMeta("alice")).toEqual([]);
	});

	it("item copiado para outro dono não abre (AAD) e nomes inválidos/duplicados falham", async () => {
		const store = memoryVaultStore();
		const vault = new VaultService(store);
		const meta = await vault.create("alice", { kind: "secret", name: "a-chave", payload: { value: "valor-aaaaaa" } });
		await expect(vault.create("alice", { kind: "secret", name: "a-chave", payload: { value: "x1x1x1" } })).rejects.toMatchObject({ code: "conflict" });
		await expect(vault.create("alice", { kind: "secret", name: "nome inválido!", payload: { value: "x1x1x1" } })).rejects.toBeInstanceOf(VaultError);
		const row = store.rows.find((item) => item.id === meta.id)!;
		store.keys.set("bob", store.keys.get("alice")!); // mesma chave de dados (pior caso)
		store.rows.push({ ...row, id: "stolen", userId: "bob", name: "roubado" });
		await expect(vault.reveal("bob", "stolen")).rejects.toMatchObject({ code: "unavailable" });
	});

	it("apagar a chave do usuário torna os itens ilegíveis", async () => {
		const store = memoryVaultStore();
		const vault = new VaultService(store);
		const meta = await vault.create("alice", { kind: "secret", name: "k", payload: { value: "valor-aaaaaa" } });
		store.keys.set("alice", wrapDataKey(newDataKey())); // chave nova no lugar da apagada
		await expect(vault.reveal("alice", meta.id)).rejects.toBeInstanceOf(VaultError);
	});

	it("login: senha e 2FA seguros, código gerado na hora, domínio salvo", async () => {
		const vault = new VaultService(memoryVaultStore());
		const meta = await vault.create("alice", {
			kind: "login",
			name: "github",
			label: "GitHub",
			siteUrl: "https://github.com/login",
			username: "alice@x.com",
			payload: { password: "Sup3rSenha!", totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", extras: [{ name: "pin", value: "9999", secret: true }] },
		});
		expect(meta.domain).toBe("github.com");
		expect(meta.username).toBe("alice@x.com");
		expect(JSON.stringify(meta)).not.toContain("Sup3rSenha");
		const code = await vault.totpCode("alice", meta.id);
		expect(code.code).toMatch(/^\d{6}$/);
		await expect(vault.create("alice", { kind: "login", name: "x", payload: { password: "abcdef", totp: "###" } })).rejects.toMatchObject({ code: "invalid" });
	});

	it("aprovação de login vale por conversa; 'sempre' vale por bot", async () => {
		const vault = new VaultService(memoryVaultStore());
		const meta = await vault.create("alice", { kind: "login", name: "site", siteUrl: "https://site.com", payload: { password: "abcdef12" } });
		expect(await vault.isLoginApproved("alice", meta, "bot1", "conv1")).toBe(false);
		await vault.approveLogin("alice", meta.id, { botId: "bot1", conversationId: "conv1" });
		expect(await vault.isLoginApproved("alice", meta, "bot1", "conv1")).toBe(true);
		expect(await vault.isLoginApproved("alice", meta, "bot1", "conv2")).toBe(false);
		await vault.approveLogin("alice", meta.id, { botId: "bot1", conversationId: "conv2", always: true });
		const fresh = await vault.getMeta("alice", meta.id);
		expect(await vault.isLoginApproved("alice", fresh, "bot1", "conv3")).toBe(true);
		expect(await vault.isLoginApproved("alice", fresh, "bot2", "conv3")).toBe(false);
	});
});

describe("referências", () => {
	it("substitui só em ferramentas permitidas e audita o uso pelo bot", async () => {
		const store = memoryVaultStore();
		const vault = new VaultService(store);
		await vault.create("alice", { kind: "secret", name: "tok", payload: { value: "VALOR-REAL-123456" } });
		const injected = await injectSecretRefs({ userId: "alice", vault, args: { command: "curl -H 'A: {{secret:tok}}'", nested: { list: ["{{secret:tok}}"] } }, by: { actor: "bot", botId: "b1", conversationId: "c1" } });
		expect(injected.args).toEqual({ command: "curl -H 'A: VALOR-REAL-123456'", nested: { list: ["VALOR-REAL-123456"] } });
		expect(injected.entries[0]).toEqual({ value: "VALOR-REAL-123456", marker: "{{secret:tok}}" });
		expect(store.auditRows.some((row) => row.action === "used" && row.botId === "b1" && row.conversationId === "c1")).toBe(true);
		expect((await vault.getMeta("alice", store.rows[0]!.id)).lastUsedAt).not.toBeNull();
	});

	it("valores com aspas em string JSON são escapados", async () => {
		const vault = new VaultService(memoryVaultStore());
		await vault.create("alice", { kind: "secret", name: "q", payload: { value: 'a"b\\c-123456' } });
		const injected = await injectSecretRefs({ userId: "alice", vault, args: { code: '{"h":"{{secret:q}}"}' } });
		expect(JSON.parse(String(injected.args.code))).toEqual({ h: 'a"b\\c-123456' });
	});

	it("outro usuário não resolve o segredo de alice; ausente dá erro sem valores", async () => {
		const vault = new VaultService(memoryVaultStore());
		await vault.create("alice", { kind: "secret", name: "tok", payload: { value: "VALOR-REAL-123456" } });
		await expect(injectSecretRefs({ userId: "bob", vault, args: { x: "{{secret:tok}}" } })).rejects.toBeInstanceOf(SecretRefError);
		await expect(injectSecretRefs({ userId: "alice", vault, args: { x: "{{secret:nao-existe}}" } })).rejects.toThrow(/secret_request/);
	});

	it("login: username/password/totp", async () => {
		const vault = new VaultService(memoryVaultStore());
		await vault.create("alice", { kind: "login", name: "gh", siteUrl: "https://github.com", username: "ali", payload: { password: "SenhaForte1", totp: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" } });
		const injected = await injectSecretRefs({ userId: "alice", vault, args: { x: "{{login:gh.username}}/{{login:gh.password}}/{{login:gh.totp}}" } });
		expect(String(injected.args.x)).toMatch(/^ali\/SenhaForte1\/\d{6}$/);
	});

	it("rotina: slug, id e hookKey resolvem; sem cópia selada dá erro útil", async () => {
		const store = memoryVaultStore();
		const vault = new VaultService(store);
		const sealed = await vault.sealHookSecret("alice", "hk1", "SEGREDO-ROTINA-123456");
		store.routineWebhooks = async (userId) =>
			userId === "alice"
				? [
						{ routineId: "r1", botId: "b", name: "Resumo Diário", enabled: true, hookKey: "hk1", secretEnc: sealed },
						{ routineId: "r2", botId: "b", name: "Antiga", enabled: true, hookKey: "hk2", secretEnc: null },
					]
				: [];
		const ok = await injectSecretRefs({ userId: "alice", vault, args: { h: "{{secret:rotina:resumo-diario}}", i: "{{secret:rotina:r1}}" } });
		expect(ok.args).toEqual({ h: "SEGREDO-ROTINA-123456", i: "SEGREDO-ROTINA-123456" });
		expect(ok.entries[0]!.marker).toBe("{{secret:rotina:resumo-diario}}");
		await expect(injectSecretRefs({ userId: "alice", vault, args: { h: "{{secret:rotina:antiga}}" } })).rejects.toThrow(/Gerar novo segredo|gere um novo/i);
		await expect(injectSecretRefs({ userId: "bob", vault, args: { h: "{{secret:rotina:resumo-diario}}" } })).rejects.toBeInstanceOf(SecretRefError);
		// aparece redigido
		const entries = await vault.redactionEntries("alice");
		expect(createRedactor(entries).text("x SEGREDO-ROTINA-123456 y")).toBe("x {{secret:rotina:resumo-diario}} y");
	});

	it("política de ferramentas e sessão", async () => {
		expect(secretToolPolicy("mcp__n8n__create_workflow")).toBe("mcp");
		expect(secretToolPolicy("sandbox_shell")).toBe("inject");
		expect(secretToolPolicy("web_search")).toBe("deny");
		expect(secretToolPolicy("browser_type")).toBe("deny");
		expect(secretToolPolicy("list_routines")).toBe("ignore");
		const vault = new VaultService(memoryVaultStore());
		await vault.create("alice", { kind: "secret", name: "tok", payload: { value: "VALOR-REAL-123456" } });
		const session = createSecretSession({ userId: "alice", vault });
		const shell = await session.prepare("sandbox_shell", { command: "echo {{secret:tok}}" });
		expect(shell.args.command).toBe("echo VALOR-REAL-123456");
		await expect(session.prepare("web_search", { query: "{{secret:tok}}" })).rejects.toThrow(/não podem ser usadas/);
		await expect(session.prepare("browser_type", { text: "{{login:x.password}}" })).rejects.toBeInstanceOf(SecretRefError);
		expect((await session.prepare("memory", { content: "x" })).args).toEqual({ content: "x" });
		expect((await session.prepare("list_routines", { q: "{{secret:tok}}" })).args).toEqual({ q: "{{secret:tok}}" });
		expect(await session.redact({ out: "ok VALOR-REAL-123456" })).toEqual({ out: "ok {{secret:tok}}" });
	});

	it("mascara valores conhecidos em mensagem recebida", async () => {
		const vault = new VaultService(memoryVaultStore());
		await vault.create("alice", { kind: "secret", name: "tok", payload: { value: "VALOR-REAL-123456" } });
		const masked = await maskKnownSecrets("alice", "use https://x/y?secret=VALOR-REAL-123456 por favor", vault);
		expect(masked).toEqual({ text: "use https://x/y?secret={{secret:tok}} por favor", masked: true });
		expect((await maskKnownSecrets("bob", "use VALOR-REAL-123456", vault)).masked).toBe(false);
	});
});
