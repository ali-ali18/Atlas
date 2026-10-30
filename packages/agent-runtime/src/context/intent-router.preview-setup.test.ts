import { describe, expect, it } from "vitest";
import { NATIVE_TOOL_GROUPS } from "./native-tools.js";
import { routeContextGroups } from "./intent-router.js";

const has = (text: string) => routeContextGroups({ text }).has("preview_setup");

describe("roteador: grupo preview_setup", () => {
	it.each([
		"quero a prévia completa",
		"configura o domínio da prévia",
		"quero ativar as prévias dos sites",
		"set up the full preview",
		"habilita a previa pra mim",
		"qual domínio das prévias eu uso?",
		"[O usuário APROVOU: criar o endereço curinga das prévias.] Chame preview_setup de novo com a mesma action",
	])("carrega para %s", (text) => expect(has(text)).toBe(true));

	it.each(["Bom dia", "roda aí e me mostra", "me mostra o site que você fez", "faz um preview do texto", "qual a previsão do tempo?", "meu certificado do site expirou", "como configuro o dns do meu domínio no https?", "o https do meu site caiu", "quero um certificado novo para o domínio"])("não carrega para %s", (text) =>
		expect(has(text)).toBe(false));

	it("o grupo tem uma tool só, protegida pelo executor (catálogo)", () => {
		expect(NATIVE_TOOL_GROUPS.preview_setup.tools).toEqual(["preview_setup"]);
	});
});
