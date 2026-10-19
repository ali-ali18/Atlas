import assert from "node:assert/strict";
import test from "node:test";
import {
	SETTINGS_ITEMS,
	SETTINGS_NAV,
	buildSettingsSearch,
	hiddenSettingsItems,
	isItemVisible,
	moveIndex,
	navEntry,
	normalizeSearch,
	parseSettingsParam,
	resolveSettingsSection,
	searchSettings,
} from "./settings-registry";

const ids = (query: string) => searchSettings(query).entries.map((entry) => entry.id);

const ALL_SECTIONS = ["conta", "geral", "notificacoes", "bots", "modelos", "provedores", "computador", "conexoes", "cofre", "habilidades", "uso", "execucao", "revisao", "diagnostico"];

test("nav: uma responsabilidade por seção, Diagnóstico por último", () => {
	assert.deepEqual(ids(""), ALL_SECTIONS);
	assert.deepEqual(
		SETTINGS_NAV.map((entry) => entry.label),
		["Conta", "Geral", "Notificações", "Bots", "Modelos e contexto", "Provedores e chaves", "Computador", "Conexões", "Cofre", "Habilidades", "Uso e custos", "Execução e limites", "Revisão automática", "Diagnóstico"],
	);
	assert.equal(SETTINGS_NAV[SETTINGS_NAV.length - 1]?.id, "diagnostico");
	assert.deepEqual(
		SETTINGS_NAV.map((entry) => entry.group),
		["basico", "basico", "basico", "inteligencia", "inteligencia", "inteligencia", "ambiente", "ambiente", "ambiente", "ambiente", "controle", "controle", "controle", "controle"],
		"os blocos da nav são contíguos",
	);
	assert.equal(SETTINGS_NAV.some((entry) => entry.label === "Rotinas"), false, "Rotinas moram no painel do bot");
});

test("busca ignora acento e caixa", () => {
	assert.equal(normalizeSearch("  ÍDIOMA "), "idioma");
	assert.deepEqual(ids("INTEGRACOES"), ["conexoes"]);
	assert.deepEqual(ids("conexões"), ["conexoes"]);
});

test("busca por configuração abre só a seção dela e só o item que casou", () => {
	const result = searchSettings("tema");
	assert.deepEqual(result.entries.map((entry) => entry.id), ["geral"]);
	assert.equal(isItemVisible(result, "geral", "geral.tema"), true);
	assert.equal(isItemVisible(result, "geral", "geral.idioma"), false);
});

test("casar pelo nome da seção mostra todos os itens dela", () => {
	const result = searchSettings("geral");
	assert.equal(result.entries[0]?.id, "geral");
	assert.equal(isItemVisible(result, "geral", "geral.fuso"), true);
	assert.equal(isItemVisible(result, "geral", "geral.idioma"), true);
});

test("fuso horário: a busca acha por fuso, horário, lembretes e modo proativo", () => {
	for (const query of ["fuso", "horario", "timezone", "lembretes", "silencio"]) {
		const result = searchSettings(query);
		assert.ok(result.entries.some((entry) => entry.id === "geral"), query);
		assert.equal(isItemVisible(result, "geral", "geral.fuso"), true, query);
	}
});

test("o que mudou de lugar continua achável: cada configuração antiga cai na seção nova", () => {
	assert.ok(ids("chatgpt").includes("provedores"), "plano ChatGPT em Provedores");
	assert.ok(ids("desconectar").includes("provedores"), "desconectar em Provedores");
	assert.ok(ids("reserva").includes("modelos"), "modelos de reserva em Modelos e contexto");
	assert.ok(ids("reflexao").includes("bots"), "reflexão em Bots");
	assert.ok(ids("push").includes("notificacoes"), "notificações em Notificações");
	assert.ok(ids("logout").includes("conta"), "sair em Conta");
	assert.ok(ids("passos").includes("execucao"), "limite de passos em Execução e limites");
	assert.ok(ids("autonomia").includes("bots"), "autonomia em Bots");
	assert.ok(ids("navegador").includes("computador"), "navegador em Computador");
	assert.ok(ids("marketplace").includes("conexoes"), "marketplace em Conexões");
	assert.ok(ids("mcp personalizado").includes("conexoes"), "MCP personalizado em Conexões");
	assert.ok(ids("composio").includes("conexoes"), "Composio em Conexões");
	assert.ok(ids("skill").includes("habilidades"), "habilidades em Habilidades");
	assert.ok(ids("segredos").includes("computador"), "ambientes de código em Computador");
	assert.equal(ids("segredos").includes("conexoes"), false);
	assert.ok(ids("gastos").includes("uso"), "uso e custos");
	const jev = searchSettings("captcha");
	assert.deepEqual(jev.entries.map((entry) => entry.id), ["revisao"]);
	assert.equal(isItemVisible(jev, "revisao", "jev.bloqueio"), true);
	assert.equal(isItemVisible(jev, "revisao", "jev.intencao"), false);
});

test("a busca também casa pelas descrições antigas (palavras-chave), não só pelo rótulo", () => {
	const result = searchSettings("coordenacao");
	assert.equal(isItemVisible(result, "bots", "jev.grupos"), true);
	const aux = searchSettings("modelos auxiliares");
	assert.equal(isItemVisible(aux, "modelos", "modelos.ditado"), true);
	assert.equal(isItemVisible(aux, "modelos", "modelos.manutencao"), true);
});

test("todo item pesquisável aponta para uma seção existente e tem id único", () => {
	for (const item of SETTINGS_ITEMS) assert.ok(navEntry(item.section), item.id);
	assert.equal(new Set(SETTINGS_ITEMS.map((item) => item.id)).size, SETTINGS_ITEMS.length);
});

test("cada item pesquisável mora numa única seção (sem repetir entre seções)", () => {
	const seen = new Map<string, string>();
	for (const item of SETTINGS_ITEMS) {
		assert.equal(seen.has(item.id), false, `${item.id} repetido`);
		seen.set(item.id, item.section);
	}
	for (const entry of SETTINGS_NAV) {
		assert.ok(SETTINGS_ITEMS.some((item) => item.section === entry.id), `${entry.id} sem itens`);
	}
	const expected: Record<string, string> = {
		"conta.foto": "conta", "conta.nome": "conta", "conta.sair": "conta",
		"ambientes.lista": "computador", "habilidades.lista": "habilidades", "cofre.lista": "cofre", "github.app": "conexoes", "composio.apps": "conexoes",
		"geral.tema": "geral", "geral.idioma": "geral", "geral.fuso": "geral",
		"modelos.padrao": "modelos", "modelos.visao": "modelos", "execucao.memoria": "modelos", "execucao.economia": "modelos", "execucao.resposta": "modelos",
		"provedores.chatgpt": "provedores", "provedores.openrouter": "provedores", "provedores.openmail": "provedores",
		"execucao.reacao": "bots", "execucao.disciplina": "execucao", "execucao.custo": "execucao", "execucao.tempo": "execucao",
		"geral.reflexao": "bots", "execucao.autonomia": "bots", "jev.grupos": "bots",
		"notificacoes.celular": "notificacoes", "notificacoes.aparelhos": "notificacoes",
		"execucao.navegador": "computador", "jev.mcp": "revisao", "jev.travamento": "revisao", "execucao.passos": "execucao", "avancado.diagnostico": "diagnostico",
	};
	for (const [id, section] of Object.entries(expected)) assert.equal(seen.get(id), section, id);
});

test("os panes só renderizam itens da própria seção (varredura do código de panes.tsx)", async () => {
	const { readFileSync } = await import("node:fs");
	const source = readFileSync(new URL("./sections/panes.tsx", import.meta.url), "utf8");
	const paneSection: Record<string, string> = {
		ContaPane: "conta", GeralPane: "geral", ProvedoresPane: "provedores", ModelosPane: "modelos", ExecucaoPane: "execucao", BotsPane: "bots",
		NotificacoesPane: "notificacoes", ComputadorPane: "computador", ConexoesPane: "conexoes", CofrePane: "cofre", HabilidadesPane: "habilidades", RevisaoPane: "revisao", DiagnosticoPane: "diagnostico",
	};
	const byId = new Map(SETTINGS_ITEMS.map((item) => [item.id, item.section]));
	for (const [pane, section] of Object.entries(paneSection)) {
		const start = source.indexOf(`export function ${pane}(`);
		assert.ok(start >= 0, pane);
		const end = source.indexOf("\nexport function ", start + 10);
		const body = source.slice(start, end < 0 ? undefined : end);
		for (const match of body.matchAll(/(!==\s*)?"([a-z-]+\.[a-z-]+)"/g)) {
			if (match[1] || !byId.has(match[2]!)) continue; // exclusões (`!==`) não renderizam
			assert.equal(byId.get(match[2]!), section, `${match[2]} aparece em ${pane}`);
		}
	}
});

test("itens do ChatGPT somem da busca para quem não é dono; capacidades ainda não carregadas não escondem nada", () => {
	const hidden = hiddenSettingsItems({ isOwner: false });
	assert.deepEqual([...hidden].sort(), ["provedores.chatgpt", "provedores.conexao", "provedores.desconectar"]);
	assert.equal(hiddenSettingsItems({ isOwner: true }).size, 0);
	assert.equal(hiddenSettingsItems(null).size, 0);
	assert.deepEqual(searchSettings("", hidden).entries.map((entry) => entry.id), ALL_SECTIONS);
	const result = searchSettings("chatgpt", hidden);
	assert.equal(result.entries.some((entry) => entry.id === "provedores"), false, "sem itens do ChatGPT, Provedores some da busca");
	assert.equal(isItemVisible(result, "modelos", "modelos.padrao"), true, "o modelo padrão cita ChatGPT e segue visível");
});

test("Uso aparece na busca por custo e gastos", () => {
	assert.ok(ids("custo").includes("uso"));
	assert.ok(ids("gastos").includes("uso"));
});

test("sem resultado devolve lista vazia", () => {
	assert.deepEqual(ids("zzz"), []);
});

test("parseSettingsParam aceita as seções e traduz os ids antigos", () => {
	for (const id of ALL_SECTIONS) assert.equal(parseSettingsParam(id), id);
	assert.equal(parseSettingsParam(" REVISAO "), "revisao");
	assert.equal(parseSettingsParam("avancado"), "revisao");
	assert.equal(parseSettingsParam("diagnostico"), "diagnostico");
	assert.equal(parseSettingsParam("estado"), "diagnostico");
	// Links antigos (?settings=...) continuam abrindo no lugar certo.
	assert.equal(parseSettingsParam("modelos"), "modelos");
	assert.equal(parseSettingsParam("jev"), "revisao");
	assert.equal(parseSettingsParam("execucao"), "execucao");
	assert.equal(parseSettingsParam("habilidades"), "habilidades");
	assert.equal(parseSettingsParam("skills"), "habilidades");
	assert.equal(parseSettingsParam("ambientes"), "computador");
	assert.equal(parseSettingsParam("composio"), "conexoes");
	assert.equal(parseSettingsParam("conectores"), "conexoes");
	assert.equal(parseSettingsParam("rotinas"), "geral");
	assert.equal(parseSettingsParam("x"), null);
	assert.equal(parseSettingsParam(""), null);
	assert.equal(parseSettingsParam(null), null);
	assert.equal(resolveSettingsSection(42), null);
});

test("buildSettingsSearch define, troca e remove só o parâmetro settings", () => {
	assert.equal(buildSettingsSearch("", "geral"), "?settings=geral");
	assert.equal(buildSettingsSearch("?settings=geral", "revisao"), "?settings=revisao");
	assert.equal(
		buildSettingsSearch("?provider=chatgpt&status=ok", "geral"),
		"?provider=chatgpt&status=ok&settings=geral",
	);
	assert.equal(buildSettingsSearch("?settings=uso", null), "");
	assert.equal(buildSettingsSearch("?provider=chatgpt&settings=uso", null), "?provider=chatgpt");
});

test("moveIndex é circular e tolera lista vazia", () => {
	assert.equal(moveIndex(0, 3, "next"), 1);
	assert.equal(moveIndex(2, 3, "next"), 0);
	assert.equal(moveIndex(0, 3, "prev"), 2);
	assert.equal(moveIndex(-1, 3, "next"), 0);
	assert.equal(moveIndex(-1, 3, "prev"), 2);
	assert.equal(moveIndex(1, 3, "first"), 0);
	assert.equal(moveIndex(1, 3, "last"), 2);
	assert.equal(moveIndex(0, 0, "next"), -1);
});
