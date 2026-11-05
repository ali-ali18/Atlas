import { describe, expect, it, vi } from "vitest";
import { ChatApiError } from "./chat-api";
import { fetchAccountSettings, fetchAutonomyLevel, fetchUsage, removeProfileImage, saveAccountSetting, saveAutonomyLevel, saveProfileImage, saveProfileName, settingsPatchBody } from "./settings-api";

const ok = (body: unknown) => vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
const settingsBody = { effective: { sandboxAutoStart: { value: true }, general: { timezone: { value: "America/Sao_Paulo" }, defaultBotLanguage: { value: "pt-BR" } } } };

describe("settingsPatchBody", () => {
	it("cada campo no lugar que o servidor espera", () => {
		expect(settingsPatchBody({ timezone: "America/Manaus" })).toEqual({ config: { general: { timezone: "America/Manaus" } } });
		expect(settingsPatchBody({ botLanguage: "auto" })).toEqual({ config: { general: { defaultBotLanguage: "auto" } } });
		expect(settingsPatchBody({ sandboxAutoStart: false })).toEqual({ sandboxAutoStart: false });
	});
});

describe("settings-api", () => {
	it("lê a conta", async () => {
		expect(await fetchAccountSettings(ok(settingsBody))).toEqual({ timezone: "America/Sao_Paulo", botLanguage: "pt-BR", sandboxAutoStart: true });
	});
	it("PATCH manda só o campo e devolve a conta salva", async () => {
		const apiFetch = ok(settingsBody);
		await saveAccountSetting(apiFetch, { sandboxAutoStart: false });
		expect(apiFetch).toHaveBeenCalledWith("/v1/settings", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ sandboxAutoStart: false }) }));
	});
	it("resposta sem o formato esperado vira erro", async () => {
		await expect(fetchAccountSettings(ok({ ola: 1 }))).rejects.toBeInstanceOf(ChatApiError);
		await expect(fetchAutonomyLevel(ok({}))).rejects.toBeInstanceOf(ChatApiError);
		await expect(fetchUsage(ok({}), "7d", "UTC")).rejects.toBeInstanceOf(ChatApiError);
	});
	it("autonomia: lê e grava sem prazo", async () => {
		expect(await fetchAutonomyLevel(ok({ effective: { level: "balanced" } }))).toBe("balanced");
		const apiFetch = ok({ effective: { level: "autonomous" } });
		expect(await saveAutonomyLevel(apiFetch, "autonomous")).toBe("autonomous");
		expect(apiFetch).toHaveBeenCalledWith("/v1/autonomy", expect.objectContaining({ method: "PUT", body: JSON.stringify({ level: "autonomous", duration: "forever" }) }));
	});
	it("uso: período e fuso vão codificados na query", async () => {
		const apiFetch = ok({ period: "30d", totals: { runs: 0, costUsd: null } });
		await fetchUsage(apiFetch, "30d", "America/Sao_Paulo");
		expect(apiFetch).toHaveBeenCalledWith("/v1/usage?period=30d&tz=America%2FSao_Paulo", expect.anything());
	});
	it("perfil: nome, foto e remover foto", async () => {
		const apiFetch = ok({});
		await saveProfileName(apiFetch, "Ana");
		await saveProfileImage(apiFetch, "data:image/jpeg;base64,AAAA");
		await removeProfileImage(apiFetch);
		expect(apiFetch).toHaveBeenNthCalledWith(1, "/v1/me", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Ana" }) }));
		expect(apiFetch).toHaveBeenNthCalledWith(2, "/v1/me/image", expect.objectContaining({ method: "PUT", body: JSON.stringify({ image: "data:image/jpeg;base64,AAAA" }) }));
		expect(apiFetch).toHaveBeenNthCalledWith(3, "/v1/me/image", expect.objectContaining({ method: "DELETE" }));
	});
	it("recusa do servidor sobe com a mensagem dele", async () => {
		const apiFetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({ error: "O nome não pode ficar vazio." }), { status: 400 }));
		await expect(saveProfileName(apiFetch, "")).rejects.toMatchObject({ status: 400, fromServer: true, message: "O nome não pode ficar vazio." });
	});
});
