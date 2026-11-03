import { describe, expect, it, vi } from "vitest";
import { catalogErrorText, fetchCatalog, fetchCatalogBot, fetchModelNames, installCatalogBot } from "./catalog-api";
import { buildInstallBody, createCatalogInstaller, humanizeWarning, type InstallDeps } from "./catalog-install";
import { ChatApiError } from "./chat-api";

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const result = (extra: Record<string, unknown> = {}) => ({ botId: "bot-9", name: "Resumo", installedSkills: ["daily-report"], routines: [], ...extra });

describe("corpo do install", () => {
	it("só os campos permitidos; índices sem repetir e em ordem", () => {
		const check = buildInstallBody({ name: "  Meu   bot ", useSuggestedModel: true, routines: [2, 0, 2, -1, 1.5] });
		expect(check).toEqual({ ok: true, body: { name: "Meu bot", useSuggestedModel: true, routines: [0, 2] } });
		expect(Object.keys((check as { body: object }).body).sort()).toEqual(["name", "routines", "useSuggestedModel"]);
	});
	it("nome de 1 a 40 caracteres", () => {
		expect(buildInstallBody({ name: "   ", useSuggestedModel: false, routines: [] }).ok).toBe(false);
		expect(buildInstallBody({ name: "a".repeat(41), useSuggestedModel: false, routines: [] }).ok).toBe(false);
		expect(buildInstallBody({ name: "a".repeat(40), useSuggestedModel: false, routines: [] }).ok).toBe(true);
		expect(buildInstallBody({ name: "a", useSuggestedModel: false, routines: [] }).ok).toBe(true);
	});
});

describe("avisos do servidor em frase simples", () => {
	it("habilidade pulada sai pelo nome legível, nunca pelo slug", () => {
		expect(humanizeWarning("A habilidade daily-report foi bloqueada pela varredura e não foi instalada.")).toBe("A habilidade “Daily report” foi bloqueada pela varredura de segurança e não foi instalada.");
		expect(humanizeWarning("Não consegui instalar a habilidade web-search.")).toBe("Não consegui instalar a habilidade “Web search”.");
		expect(humanizeWarning("O modelo sugerido não está disponível; usei o seu modelo padrão.")).toBe("O modelo sugerido não está disponível; usei o seu modelo padrão.");
	});
});

function deps(over: Partial<InstallDeps> = {}) {
	const calls: string[] = [];
	const value: InstallDeps = {
		install: vi.fn(async () => {
			calls.push("install");
			return { botId: "bot-9", name: "Resumo", installedSkills: [], routines: [], warnings: [] };
		}),
		createRoutine: vi.fn(async (_botId, routine) => void calls.push(`routine:${routine.name}`)),
		ensureBot: vi.fn(async () => void calls.push("ensure")),
		remember: vi.fn(async () => void calls.push("remember")),
		onUnauthorized: vi.fn(),
		...over,
	};
	return { value, calls };
}
const input = { name: "Resumo", useSuggestedModel: false, routines: [0, 1] };

describe("instalador", () => {
	it("cria as rotinas escolhidas na ordem do servidor, depois lembra e põe o bot na home", async () => {
		const { value, calls } = deps({
			install: vi.fn(async () => ({ botId: "bot-9", name: "Resumo", installedSkills: ["x"], warnings: [], routines: [{ name: "Diário", prompt: "p1", cron: "0 9 * * *" }, { name: "Semanal", prompt: "p2", cron: "0 9 * * 1" }] })),
		});
		const outcome = await createCatalogInstaller(value)("resumo", input);
		expect(outcome).toEqual({ ok: true, botId: "bot-9", name: "Resumo", warnings: [] });
		expect(value.createRoutine).toHaveBeenNthCalledWith(1, "bot-9", { name: "Diário", prompt: "p1", schedule: "0 9 * * *" });
		expect(value.createRoutine).toHaveBeenNthCalledWith(2, "bot-9", { name: "Semanal", prompt: "p2", schedule: "0 9 * * 1" });
		expect(value.install).toHaveBeenCalledWith("resumo", { name: "Resumo", useSuggestedModel: false, routines: [0, 1] });
		expect(value.remember).toHaveBeenCalledWith("resumo", "bot-9");
		expect(value.ensureBot).toHaveBeenCalledWith("bot-9");
	});
	it("falha parcial: o bot foi criado e uma rotina falhou → aviso, não desfaz e as outras seguem", async () => {
		let n = 0;
		const { value, calls } = deps({
			install: vi.fn(async () => ({ botId: "bot-9", name: "Resumo", installedSkills: [], warnings: ["Não consegui instalar a habilidade web-search."], routines: [{ name: "Diário", prompt: "p1", cron: "0 9 * * *" }, { name: "Semanal", prompt: "p2", cron: "0 9 * * 1" }] })),
			createRoutine: vi.fn(async (_b, routine) => {
				n += 1;
				if (n === 1) throw new ChatApiError("boom", 500);
				calls.push(`routine:${routine.name}`);
			}),
		});
		const outcome = await createCatalogInstaller(value)("resumo", input);
		expect(outcome).toEqual({ ok: true, botId: "bot-9", name: "Resumo", warnings: ["Não consegui instalar a habilidade “Web search”.", "Não consegui criar a rotina “Diário”. Você pode criá-la depois."] });
		expect(calls).toEqual(["routine:Semanal", "remember", "ensure"]);
	});
	it("falha no install: erro amigável, nada é criado e dá para tentar de novo", async () => {
		let fail = true;
		const { value } = deps({
			install: vi.fn(async () => {
				if (fail) throw new ChatApiError("x", 503);
				return { botId: "bot-9", name: "R", installedSkills: [], routines: [], warnings: [] };
			}),
		});
		const submit = createCatalogInstaller(value);
		expect(await submit("resumo", input)).toEqual({ ok: false, error: "Não consegui instalar o bot agora. Tente de novo." });
		expect(value.createRoutine).not.toHaveBeenCalled();
		expect(value.ensureBot).not.toHaveBeenCalled();
		fail = false;
		expect((await submit("resumo", input))?.ok).toBe(true);
	});
	it("sessão expirada no install avisa quem chama", async () => {
		const { value } = deps({ install: vi.fn(async () => Promise.reject(new ChatApiError("x", 401))) });
		const outcome = await createCatalogInstaller(value)("resumo", input);
		expect(outcome).toEqual({ ok: false, error: "Sua sessão expirou. Entre de novo." });
		expect(value.onUnauthorized).toHaveBeenCalledTimes(1);
	});
	it("nome inválido não chama o servidor", async () => {
		const { value } = deps();
		expect(await createCatalogInstaller(value)("resumo", { ...input, name: " " })).toMatchObject({ ok: false });
		expect(value.install).not.toHaveBeenCalled();
	});
	it("toque duplo: com a instalação em voo o segundo é ignorado; depois de instalado também", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { value } = deps({
			install: vi.fn(async () => {
				await gate;
				return { botId: "bot-9", name: "R", installedSkills: [], routines: [], warnings: [] };
			}),
		});
		const submit = createCatalogInstaller(value);
		const first = submit("resumo", input);
		expect(await submit("resumo", input)).toBeNull();
		release();
		expect((await first)?.ok).toBe(true);
		expect(await submit("resumo", input)).toBeNull();
		expect(value.install).toHaveBeenCalledTimes(1);
	});
	it("falha ao lembrar ou ao pôr na home não derruba a instalação", async () => {
		const { value } = deps({ remember: vi.fn(async () => Promise.reject(new Error("disco"))), ensureBot: vi.fn(async () => Promise.reject(new Error("rede"))) });
		expect((await createCatalogInstaller(value)("resumo", input))?.ok).toBe(true);
	});
});

describe("chamadas à API do catálogo (fetch mockado)", () => {
	it("lista e detalhe pelos endpoints certos, com slug codificado", async () => {
		const apiFetch = vi.fn(async (path: string) => (path === "/v1/catalog" ? reply(200, { skills: [], bots: [{ slug: "a", name: "A", color: "red", shape: "blob" }] }) : reply(200, { bot: { slug: "a b", name: "A" } })));
		expect(await fetchCatalog(apiFetch)).toHaveLength(1);
		expect((await fetchCatalogBot(apiFetch, "a b")).slug).toBe("a b");
		expect(apiFetch).toHaveBeenCalledWith("/v1/catalog/bots/a%20b", expect.anything());
	});
	it("resposta inválida vira erro 502; erro HTTP vira ChatApiError", async () => {
		await expect(fetchCatalog(async () => reply(200, { nope: 1 }))).rejects.toMatchObject({ status: 502 });
		await expect(fetchCatalogBot(async () => reply(200, { bot: {} }), "a")).rejects.toMatchObject({ status: 502 });
		await expect(fetchCatalog(async () => reply(503, { error: "x" }))).rejects.toBeInstanceOf(ChatApiError);
	});
	it("install manda POST com o corpo exato e lê o resultado (descarta item torto)", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => reply(201, result({ routines: [{ name: "D", prompt: "p", cron: "0 9 * * *" }, { name: 1 }], warnings: ["w", 2] })));
		const out = await installCatalogBot(apiFetch, "resumo", { name: "Meu", useSuggestedModel: false, routines: [0] });
		expect(out).toEqual({ botId: "bot-9", name: "Resumo", installedSkills: ["daily-report"], routines: [{ name: "D", prompt: "p", cron: "0 9 * * *" }], warnings: ["w"] });
		const [path, init] = apiFetch.mock.calls[0]!;
		expect(path).toBe("/v1/catalog/bots/resumo/install");
		expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ name: "Meu", useSuggestedModel: false, routines: [0] }) });
	});
	it("install sem botId na resposta é erro", async () => {
		await expect(installCatalogBot(async () => reply(201, {}), "a", { name: "x", useSuggestedModel: false, routines: [] })).rejects.toMatchObject({ status: 502 });
	});
	it("nomes dos modelos: só id e nome válidos; falha dá mapa vazio", async () => {
		expect(await fetchModelNames(async () => reply(200, { models: [{ id: "a/b", name: "Modelo B" }, { id: "c", name: " " }, { id: 1 }] }))).toEqual({ "a/b": "Modelo B" });
		expect(await fetchModelNames(async () => reply(502, {}))).toEqual({});
		expect(await fetchModelNames(async () => Promise.reject(new TypeError("rede")))).toEqual({});
	});
	it("frases de erro sem texto técnico", () => {
		expect(catalogErrorText(new ChatApiError("x", 422), "install")).toContain("bloqueado pela varredura");
		expect(catalogErrorText(new ChatApiError("x", 400), "install")).toBe("O nome deve ter de 1 a 40 caracteres.");
		expect(catalogErrorText(new ChatApiError("x", 404), "detail")).toBe("Não encontrei este bot no catálogo.");
		expect(catalogErrorText(new ChatApiError("Falha ao falar com o marketplace.", 503), "list")).not.toContain("marketplace");
		expect(catalogErrorText(new TypeError("Network request failed"), "list")).toBe("Sem conexão com o seu servidor. Tente de novo.");
	});
});
