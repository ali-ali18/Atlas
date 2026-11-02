import { describe, expect, it } from "vitest";
import { NATIVE_TOOL_GROUPS } from "./native-tools.js";
import { routeContextGroups } from "./intent-router.js";
import { assembleSystemPrompt, groupProcedureText, P_INSTALL, type ContextGroup } from "./prompt-blocks.js";

const none = new Set<ContextGroup>();

describe("instalar programas na VM (regras lazy do grupo shell)", () => {
	const shell = groupProcedureText(new Set<ContextGroup>(["shell"]));

	it("o grupo shell traz a única forma de instalar com root, a persistência e o plano B de segundo plano", () => {
		expect(shell).toContain("sudo atlas-install apt <package...>");
		expect(shell).toContain("sudo atlas-install deb <file inside /home/atlas>");
		expect(shell).toContain("the ONLY way to install with root");
		expect(shell).toContain("sudo atlas-install list");
		expect(shell).toContain("survives the VM being recreated");
		// A tool de shell já tem segundo plano: instalação longa usa isso.
		expect(shell).toContain("`background:true`");
		expect(shell).toContain("`sandbox_shell_wait`");
		expect(shell).toContain("~/.atlas/reinstall.status");
	});

	it("pip, npm e nvm vão para o home e persistem", () => {
		expect(shell).toMatch(/pip install --user.*nvm.*\/home\/atlas and persist/s);
	});

	it("cuidado com executáveis: ler .sh, conferir file/arquitetura, .exe só no Wine, .dmg não roda, origem desconhecida e confirmação", () => {
		expect(shell).toContain("read it (`cat`)");
		expect(shell).toContain("`file <path>`");
		expect(shell).toContain("Linux x86-64");
		expect(shell).toMatch(/`\.exe` only runs through Wine, with no guarantee/);
		expect(shell).toMatch(/`\.dmg` or macOS app does not run/);
		expect(shell).toContain("suggest an alternative");
		expect(shell).toContain("unknown origin only if the user asked");
		expect(shell).toContain("Confirm with the user before deleting or overwriting");
	});

	it("o texto para o usuário não vaza o nome do comando (linguagem simples)", () => {
		expect(shell).toContain("never command names");
	});

	it("o bloco é curto (contexto lazy não pode inchar)", () => {
		expect(P_INSTALL.join("\n").length).toBeLessThan(2400);
	});

	it("fora do grupo shell nada disso entra: o núcleo e os outros grupos não citam o instalador", () => {
		for (const text of [assembleSystemPrompt(none), groupProcedureText(new Set<ContextGroup>(["web", "browser", "files", "dev"]))]) {
			expect(text).not.toContain("atlas-install");
			expect(text).not.toContain("reinstall.status");
		}
	});

	it("o modelo pode carregar o grupo por palavras de instalação (busca de tools)", () => {
		const keywords = NATIVE_TOOL_GROUPS.shell.keywords;
		for (const word of ["instalar", "install", "appimage", "deb", "wine"]) expect(keywords).toContain(word);
		expect(NATIVE_TOOL_GROUPS.shell.hint).toContain("install programs");
	});
});

describe("o pedido de instalar programa carrega o grupo shell no passo 1", () => {
	it.each([
		"instala o programa VLC na VM",
		"preciso instalar o appimage do Obsidian",
		"roda apt-get install ffmpeg",
		"instale o pacote ffmpeg pra mim",
		"baixa esse .deb e instala",
		"instala um software de edição de vídeo",
		"install the package htop",
		"configura o nvm e o node 20",
	])("%s", (text) => {
		expect(routeContextGroups({ text }).has("shell")).toBe(true);
	});

	it.each([
		"Bom dia",
		"quero um vinho wine tinto",
		"instala o app no meu celular",
		"a instalação elétrica do escritório ficou cara",
		"instale as dependencias do repositorio",
		"qual o preço da canela?",
	])("não carrega para: %s", (text) => {
		expect(routeContextGroups({ text }).has("shell")).toBe(false);
	});
});
