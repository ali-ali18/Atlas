import { describe, expect, it, vi } from "vitest";
import type { SandboxManager } from "@workspace/sandbox";
import { checkLoginWall, readLoginFields } from "./computer-refs.js";

/** browser_read/browser_text não trazem DOM: a checagem estrutural vem de um snapshot barato, só quando a URL ou o texto sugerem login. */
const snap = (lines: string[]) => ({ execBrowserSnapshot: vi.fn(async () => ({ url: "u", title: "t", lines, offset: 0, total: lines.length, nextOffset: null })) }) as unknown as Pick<SandboxManager, "execBrowserSnapshot"> & { execBrowserSnapshot: ReturnType<typeof vi.fn> };
const PASSWORD = ['[e1] textbox "E-mail"', '[e2] textbox "Senha" (campo de senha: nunca preencha)'];
const OTP = ['[e1] textbox "Código" (campo de código de uso único: nunca preencha)'];

async function wall(url: string, lines: string[], text = "Entre na sua conta", asked = new Set<string>()) {
	const manager = snap(lines);
	const page = { url, title: "Página", text };
	const fields = await readLoginFields(manager, "s1", page);
	return { manager, result: checkLoginWall({ runId: "r", loginAsked: asked }, { ...page, ...(fields ? { fields } : {}) }), asked };
}

describe("login sem DOM nas leituras (browser_read / browser_text)", () => {
	it("/acesso com campo de senha lido por texto pausa (cartão)", async () => {
		const { result } = await wall("https://erp.test/acesso", PASSWORD);
		expect(result?.loginEvent).toMatchObject({ site: "erp.test", status: "pending" });
	});

	it("/u/mfa-otp-challenge com campo de código pausa", async () => {
		const { result } = await wall("https://id.test/u/mfa-otp-challenge", OTP);
		expect(result?.loginEvent).toMatchObject({ site: "id.test" });
	});

	it("/docs/login sem formulário e sem senha vira só nota (sem cartão)", async () => {
		const { result } = await wall("https://app.test/docs/login", ['[e1] link "Índice"'], "Como configurar o login");
		expect(result?.loginEvent).toBeUndefined();
		expect(result?.note).toContain("may need a login");
	});

	it("página comum não gasta snapshot", async () => {
		const { manager, result } = await wall("https://loja.test/produtos", PASSWORD, "Lista de produtos");
		expect(manager.execBrowserSnapshot).not.toHaveBeenCalled();
		expect(result).toBeNull();
	});

	it("snapshot que falha não derruba a leitura", async () => {
		const manager = { execBrowserSnapshot: vi.fn(async () => { throw new Error("sem tela"); }) } as unknown as Pick<SandboxManager, "execBrowserSnapshot">;
		await expect(readLoginFields(manager, "s1", { url: "https://erp.test/acesso" })).resolves.toBeUndefined();
	});

	it("a nota fraca sai uma vez por site e por run, não a cada snapshot", async () => {
		const asked = new Set<string>();
		const first = await wall("https://app.test/docs/login", ['[e1] link "Índice"'], "Como configurar o login", asked);
		const second = await wall("https://app.test/docs/login", ['[e1] link "Índice"'], "Como configurar o login", asked);
		expect(first.result?.note).toContain("may need a login");
		expect(second.result).toBeNull();
	});
});
