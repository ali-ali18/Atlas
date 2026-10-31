import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", async (original) => ({
	...(await original<typeof import("@workspace/db")>()),
	persistConversationCardFromEvent: vi.fn(async () => undefined),
	saveSkillPendingIntent: vi.fn(async () => undefined),
	getSkillPendingIntent: vi.fn(async () => null),
}));

import { memoryVaultStore } from "../secrets/memory-store.js";
import { VaultService } from "../secrets/vault-service.js";
import { fillVaultLoginOnResume } from "./vault-login-offer.js";
import { executeLoginFill, vaultLinkConfirmId, type VaultToolContext } from "./vault-tools.js";

// Mensagens EXATAS do control server (docker/agent-sandbox/control/browser-actions.mjs); o teste
// docker/agent-sandbox/control/browser-actions.test.mjs prova, num Chromium real, que ele as produz.
const REAL_MISSING_PASSWORD = "Não achei o campo de senha na página principal; nada foi digitado.";
const REAL_REFUSED = "Recusado: a senha só pode ser digitada em um campo de senha visível da página principal. Nada foi digitado.";
const REAL_CHANGED_SITE = "A página mudou de site antes de digitar; nada foi digitado.";

let vault: VaultService;
beforeAll(() => {
	process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});
beforeEach(() => {
	vault = new VaultService(memoryVaultStore());
});

type Typed = { selector: string; text: string; guard?: { kind: string; origin?: string } };
function browser(opts: { url?: string; failPassword?: string } = {}) {
	const typed: Typed[] = [];
	const url = opts.url ?? "https://login.example.com/signin";
	return {
		typed,
		api: {
			currentUrl: async () => url,
			type: async (selector: string, text: string, _submit: boolean, guard?: Typed["guard"]) => {
				if (guard?.kind === "password" && opts.failPassword) throw new Error(opts.failPassword);
				typed.push({ selector, text, guard });
			},
		},
	};
}

describe("login em duas telas (A1): a mensagem real do control server vira campo ausente, não recusa", () => {
	const ctx = (b: ReturnType<typeof browser>): VaultToolContext => ({ userId: "u", botId: "b", conversationId: "c", browser: b.api });
	beforeEach(async () => {
		await vault.create("u", { kind: "login", name: "ex", label: "Ex", siteUrl: "https://login.example.com", username: "ana@x.com", payload: { password: "P@ss1" } });
	});

	it("'Não achei o campo de senha…' vira 'campo de password' (a deixa do fallback), nunca a mensagem literal", async () => {
		const b = browser({ failPassword: REAL_MISSING_PASSWORD });
		const error = await executeLoginFill({ login: "ex", fields: ["username", "password"] }, { ...ctx(b), vault }).catch((e: Error) => e);
		expect((error as Error).message).toMatch(/campo de password/);
		expect((error as Error).message).not.toContain("nada foi digitado");
		expect(b.typed.map((t) => t.text)).toEqual(["ana@x.com"]);
	});

	it("recusa e troca de site continuam literais", async () => {
		for (const real of [REAL_REFUSED, REAL_CHANGED_SITE]) {
			const b = browser({ failPassword: real });
			const error = await executeLoginFill({ login: "ex", fields: ["password"] }, { ...ctx(b), vault }).catch((e: Error) => e);
			expect((error as Error).message).toBe(real);
		}
	});

	it("fluxo completo: 1ª tela só com usuário, a senha entra na tela seguinte", async () => {
		const typed: Typed[] = [];
		let screen = 1;
		const b = {
			currentUrl: async () => "https://login.example.com/signin",
			type: async (selector: string, text: string, _s: boolean, guard?: Typed["guard"]) => {
				if (guard?.kind === "password" && screen === 1) throw new Error(REAL_MISSING_PASSWORD);
				typed.push({ selector, text, guard });
			},
		};
		const result = await fillVaultLoginOnResume({
			offer: { name: "ex", label: "Ex", domain: "login.example.com" },
			userId: "u",
			vault,
			fillContext: { browser: b },
			readPage: async () => ({ url: "https://login.example.com/home", title: "Home", text: "Bem-vindo" }),
			settle: async () => { screen = 2; },
		});
		expect(result.kind).toBe("filled");
		expect(typed.map((t) => t.text)).toEqual(["ana@x.com", "ana@x.com", "P@ss1"]);
	});
});

describe("cartão de vínculo (A2 e M2)", () => {
	let saved: Array<{ payload: { confirmId?: string; vaultUse?: { linkHost?: string; secretId?: string } } }>;
	let cards: Array<{ confirmId: string; title: string; description?: string }>;
	const mk = (b: ReturnType<typeof browser>, extra: Partial<VaultToolContext> = {}): VaultToolContext => ({
		userId: "u",
		botId: "b",
		conversationId: "c",
		runId: "cmrun1",
		vault,
		browser: b.api,
		saveIntent: async (input) => void saved.push(input as never),
		persistCard: async (_c, card) => void cards.push(card as never),
		// intenção pendente = a última salva (uma por conversa, como no banco)
		loadIntent: async () => (saved.length ? (saved.at(-1) as never) : null),
		...extra,
	});
	beforeEach(async () => {
		saved = [];
		cards = [];
		await vault.create("u", { kind: "login", name: "painel-kodea", label: "Painel - Kodea", username: "dono@x.com", payload: { password: "K!1" } });
		await vault.create("u", { kind: "login", name: "outro", label: "Outro", username: "o@x.com", payload: { password: "O!1" } });
	});

	it("dois login_fill no mesmo run: o 2º é recusado e o 'Sim' do 1º grava o host do 1º", async () => {
		const first = browser({ url: "https://panel.kodea.com.br/login" });
		await executeLoginFill({ login: "painel-kodea" }, mk(first));
		expect(saved).toHaveLength(1);
		const second = browser({ url: "https://evil.example/login" });
		await expect(executeLoginFill({ login: "painel-kodea" }, mk(second))).rejects.toThrow(/aguardando a resposta do dono/);
		await expect(executeLoginFill({ login: "outro" }, mk(second))).rejects.toThrow(/aguardando a resposta do dono/);
		expect(saved).toHaveLength(1);
		expect(cards).toHaveLength(1);
		expect(saved[0]!.payload.vaultUse?.linkHost).toBe("panel.kodea.com.br");
		expect(saved[0]!.payload.confirmId).toBe(cards[0]!.confirmId);
		expect(first.typed).toEqual([]);
		expect(second.typed).toEqual([]);
	});

	it("o id do cartão é único por item e host, termina no run que pediu e não repete 'confirm-<run>'", async () => {
		const a = vaultLinkConfirmId("cmrun1", "id-1", "a.example.com");
		expect(a).toMatch(/^confirm-vault-[0-9a-f]{10}-cmrun1$/);
		expect(vaultLinkConfirmId("cmrun1", "id-1", "b.example.com")).not.toBe(a);
		expect(vaultLinkConfirmId("cmrun1", "id-2", "a.example.com")).not.toBe(a);
		expect(a).not.toBe("confirm-cmrun1");
	});

	it("outra intenção pendente (não é vault-use) não bloqueia o pedido de vínculo", async () => {
		const b = browser({ url: "https://panel.kodea.com.br/login" });
		await executeLoginFill({ login: "painel-kodea" }, mk(b, { loadIntent: async () => ({ payload: { action: "dev-command" } }) }));
		expect(cards).toHaveLength(1);
	});

	it("nome que não tem a ver com o site: o cartão avisa, com o host em destaque (M2)", async () => {
		const b = browser({ url: "https://banco-falso.example/login" });
		await executeLoginFill({ login: "painel-kodea" }, mk(b));
		expect(cards[0]!.title).toContain("banco-falso.example");
		expect(cards[0]!.description).toContain('Atenção: este site (banco-falso.example) não parece ser o de "Painel - Kodea".');
	});

	it("nome que combina com o site: sem o aviso", async () => {
		const b = browser({ url: "https://panel.kodea.com.br/login" });
		await executeLoginFill({ login: "painel-kodea" }, mk(b));
		expect(cards[0]!.description).not.toContain("Atenção");
	});

	it("subdomínio do site salvo não digita: recusa e nada é digitado (M1)", async () => {
		await vault.create("u", { kind: "login", name: "goog", label: "Google", siteUrl: "https://google.com", username: "g@x.com", payload: { password: "G!1" } });
		const b = browser({ url: "https://sites.google.com/view/x" });
		await expect(executeLoginFill({ login: "goog" }, mk(b))).rejects.toThrow(/Recusado/);
		expect(b.typed).toEqual([]);
	});
});
