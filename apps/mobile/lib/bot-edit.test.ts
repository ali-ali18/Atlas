import { describe, expect, it, vi } from "vitest";
import { SHAPE_IDS } from "@workspace/shared/avatar/geometry/shapes";
import { AVATAR_COLORS } from "@workspace/shared/avatar/identity";
import { botPatchBody, patchBot, saveErrorText } from "./bot-api";
import { AVATAR_PALETTE, AVATAR_SHAPES, BOT_NAME_MAX, buildBotPatch, defaultAvatar, hasChanges, isValidColor, isValidShape, languageLabel, LANGUAGE_OPTIONS, OWN_COLOR_SHAPES, usesPalette, validateBotName } from "./bot-edit";
import { ChatApiError } from "./chat-api";

const original = { name: "Grok Bot", shape: "pebble", color: "#FF6700", language: "auto" };

describe("nome", () => {
	it("limpa espaços e aceita um nome normal", () => {
		expect(validateBotName("  Grok   Bot ")).toEqual({ ok: true, value: "Grok Bot" });
	});
	it("vazio ou só espaços é recusado; o limite é 80 letras", () => {
		expect(validateBotName("")).toMatchObject({ ok: false });
		expect(validateBotName("   ")).toMatchObject({ ok: false });
		expect(validateBotName("a".repeat(BOT_NAME_MAX))).toMatchObject({ ok: true });
		expect(validateBotName("a".repeat(BOT_NAME_MAX + 1))).toMatchObject({ ok: false });
	});
});

describe("avatar", () => {
	it("a lista de formas e a paleta são as do web, na mesma ordem", () => {
		expect(AVATAR_SHAPES).toEqual([...SHAPE_IDS]);
		expect(AVATAR_PALETTE).toBe(AVATAR_COLORS);
		expect(AVATAR_PALETTE).toHaveLength(11);
	});
	it("forma e cor válidas e inválidas", () => {
		expect(isValidShape("hex")).toBe(true);
		expect(isValidShape("rond")).toBe(true); // forma antiga que o servidor ainda traduz
		expect(isValidShape("abobora")).toBe(false);
		expect(isValidShape(3)).toBe(false);
		expect(isValidColor("#FF6700")).toBe(true);
		expect(isValidColor("#ff6700 ")).toBe(true);
		expect(isValidColor("orange")).toBe(false);
		expect(isValidColor("#fff")).toBe(false);
		expect(isValidColor("")).toBe(false);
	});
	it("a paleta só some em forma com cor própria (hoje nenhuma)", () => {
		expect(usesPalette("blob")).toBe(true);
		expect(usesPalette(null)).toBe(true);
		expect(OWN_COLOR_SHAPES.size).toBe(0);
		const special = new Set(["abobora"]);
		expect(usesPalette("abobora", special)).toBe(false); // forma com cor própria esconde a paleta
		expect(usesPalette("blob", special)).toBe(true);
	});
	it("restaurar o padrão dá a forma e a cor sorteadas pelo id, sempre as mesmas", () => {
		const a = defaultAvatar("bot-1");
		expect(defaultAvatar("bot-1")).toEqual(a);
		expect(isValidShape(a.shape)).toBe(true);
		expect(isValidColor(a.color)).toBe(true);
	});
});

describe("payload do PATCH", () => {
	it("sem mudança não há o que salvar", () => {
		expect(buildBotPatch(original, { ...original })).toEqual({});
		expect(hasChanges(buildBotPatch(original, { ...original }))).toBe(false);
		expect(hasChanges(buildBotPatch(original, { ...original, color: "#ff6700" }))).toBe(false); // só a caixa da letra mudou
	});
	it("manda só o que mudou, com o nome limpo", () => {
		expect(buildBotPatch(original, { ...original, name: "  Novo   nome " })).toEqual({ name: "Novo nome" });
		expect(buildBotPatch(original, { ...original, shape: "hex", color: "#1084FE" })).toEqual({ shape: "hex", color: "#1084FE" });
		expect(buildBotPatch(original, { ...original, language: "pt-BR" })).toEqual({ language: "pt-BR" });
	});
	it("nome vazio ou longo, forma, cor ou idioma inválidos bloqueiam", () => {
		expect(buildBotPatch(original, { ...original, name: "" })).toBeNull();
		expect(buildBotPatch(original, { ...original, name: "x".repeat(81) })).toBeNull();
		expect(buildBotPatch(original, { ...original, shape: "nope" })).toBeNull();
		expect(buildBotPatch(original, { ...original, color: "azul" })).toBeNull();
		expect(buildBotPatch(original, { ...original, language: "fr-FR" })).toBeNull();
		expect(hasChanges(null)).toBe(false);
	});
	it("o corpo leva só os campos permitidos", () => {
		expect(botPatchBody({ name: "A", shape: "hex", color: "#000000", language: "auto" })).toEqual({ name: "A", shape: "hex", color: "#000000", language: "auto" });
		expect(botPatchBody({})).toEqual({});
		expect(botPatchBody({ name: "A", isPrimary: true, memberIds: ["x"] } as never)).toEqual({ name: "A" });
	});
	it("PATCH vai ao bot certo, com o corpo em JSON; sem mudança não chama a rede", async () => {
		const apiFetch = vi.fn(async () => new Response("{}", { status: 200 }));
		await patchBot(apiFetch, "bot/1", { name: "Novo" });
		expect(apiFetch).toHaveBeenCalledWith("/v1/bots/bot%2F1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Novo" }) }));
		await patchBot(apiFetch, "bot1", {});
		expect(apiFetch).toHaveBeenCalledTimes(1);
	});
	it("erro do servidor vira ChatApiError e frase simples", async () => {
		const apiFetch = vi.fn(async () => new Response("{}", { status: 404 }));
		await expect(patchBot(apiFetch, "b", { name: "x" })).rejects.toMatchObject({ status: 404 });
		expect(saveErrorText(new ChatApiError("x", 404))).toContain("Não encontrei");
		expect(saveErrorText(new ChatApiError("x", 500))).toContain("Não consegui salvar");
		expect(saveErrorText(new TypeError("net"))).toContain("Sem conexão");
	});
});

describe("idioma", () => {
	it("rótulos e opções", () => {
		expect(languageLabel(null)).toBe("Automático");
		expect(languageLabel("auto")).toBe("Automático");
		expect(languageLabel("pt-BR")).toBe("Português (Brasil)");
		expect(LANGUAGE_OPTIONS[0]).toEqual({ value: "auto", label: "Automático" });
		expect(LANGUAGE_OPTIONS.length).toBeGreaterThanOrEqual(4);
	});
});
