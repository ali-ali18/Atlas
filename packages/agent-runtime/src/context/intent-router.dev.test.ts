import { describe, expect, it } from "vitest";
import { routeContextGroups } from "./intent-router.js";

/**
 * Tabela de frases que devem (ou não) pré-carregar o grupo `dev` (tools de código). O roteador
 * é só palavra-chave: aqui medimos acerto e falso positivo em pt-BR e inglês.
 */
const CODING = [
	"corrige esse erro na função calcularTotal",
	"conserta o teste que quebrou",
	"muda o arquivo src/app.ts",
	"por que esse código dá erro?",
	"TypeError: Cannot read properties of undefined (reading 'map')\n    at render (/app/List.tsx:42:13)",
	"cria um endpoint POST /users que salva o cliente",
	"o build quebrou, arruma pra mim",
	"renomeia a variável userId para ownerId",
	"implementa a função de paginação",
	"ajusta a classe UserService pra validar o e-mail",
	"edita o package.json e sobe a versão do typescript",
	"roda os testes e me diz o que falhou",
	"adiciona um método na classe Order",
	"o teste falhou com AssertionError, dá uma olhada",
	"abre o arquivo main.go e troca o nome da função",
	"corrige o erro de compilação",
	"faz um git diff e me explica o que mudou",
	"instala as dependências do projeto",
	"conserta o lint",
	"fix the login bug",
	"fix the failing test in auth.test.ts",
	"why does this function throw an error?",
	"update src/utils/date.py to handle timezones",
	"refactor the UserService class",
	"add a new endpoint to the API that returns the user profile",
	'Traceback (most recent call last):\n  File "main.py", line 10, in <module>',
	"the build is failing with a type error",
	"rename the variable foo to bar in index.js",
	"debug this null pointer exception",
	"Error: Cannot find module './config' in my project",
	"roda o ./scripts/deploy.sh e me diz se deu erro",
	"corrige o código do formulário de cadastro",
];

const NON_CODING = [
	"Bom dia",
	"corrige o texto abaixo",
	"corrige meu e-mail antes de enviar",
	"muda o nome do arquivo do relatório",
	"tem um erro na minha fatura, o que faço?",
	"me manda o arquivo do contrato",
	"qual o código de barras desse boleto?",
	"me lembra de pagar o aluguel toda sexta",
	"resume esse PDF pra mim",
	"escreve um e-mail para o cliente cobrando o pagamento",
	"corrige a ortografia deste parágrafo",
	"explica a função de segundo grau",
	"qual a variável mais importante nessa pesquisa?",
	"fix the typo in my email",
	"I have an error in my invoice",
	"write a poem about the sea",
	"me explica o que é node.js",
	"o erro de digitação no slide 3",
	"resolva o problema do código de barras do boleto",
	"arrume o código postal no cadastro",
	"edite a função PROCV na planilha",
	"cria uma variável na planilha",
	"na planilha de vendas, edite a função SOMA",
	"o site novo está em nest.js, me explica",
	"abre meu-site.go.com e vê o preço",
	"me manda o relatorio.sh por e-mail",
];

const hits = (list: string[]) => list.filter((text) => routeContextGroups({ text }).has("dev"));

describe("grupo dev (pedidos de código)", () => {
	it.each(CODING)("ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("dev")).toBe(true);
	});
	it.each(NON_CODING)("não ativa para: %s", (text) => {
		expect(routeContextGroups({ text }).has("dev")).toBe(false);
	});
	it("taxa de acerto: todos os pedidos de código e nenhum de documento/conversa", () => {
		const coding = hits(CODING);
		const falsePositives = hits(NON_CODING);
		console.info(`dev: ${coding.length}/${CODING.length} de código ativam; ${falsePositives.length}/${NON_CODING.length} falsos positivos`);
		expect(coding).toHaveLength(CODING.length);
		expect(falsePositives).toEqual([]);
	});
});
