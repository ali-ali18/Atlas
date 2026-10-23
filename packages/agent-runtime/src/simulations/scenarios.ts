/**
 * Cenários de conversa da suíte roteirizada (`conversations.test.ts`). Cada cenário tem a conversa e uma checagem do
 * comportamento que vale para qualquer modelo; a suíte ainda confere os detalhes do runtime. Os mesmos casos rodam
 * com modelo real (e mais outros) no pacote `@workspace/evals` (`packages/evals/scenarios/`).
 */

export type ScenarioOutcome = { text: string; toolsCalled: string[]; discards: string[]; systemNotes: string };

export type Scenario = {
	id: number;
	name: string;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	/** `null` = passou; texto = motivo da falha. */
	check: (outcome: ScenarioOutcome) => string | null;
};

const QUOTE = [
	{ role: "user" as const, content: "faz a cotação de frete do pedido 3410" },
	{
		role: "assistant" as const,
		content: "Achei os dados do pedido 3410: cliente Loja Exemplo, CNPJ 11.222.333/0001-81. Quer que eu monte a mensagem de cotação com esses dados?",
	},
	{
		role: "user" as const,
		content: [
			"Bom dia, tudo bem?",
			"Remetente: CNPJ 12.345.678/0001-95 CEP 01001-000",
			"Destinatário: CNPJ 98.765.432/0001-98 CEP 20040-020",
			"Carga: 7 volumes, 43 kg, nota R$ 1.712,67, frete CIF",
			"altera os dados",
		].join("\n"),
	},
];

const TABLE = [
	{ role: "user" as const, content: "escreve um resumo curto das vendas do trimestre para o time" },
	{ role: "assistant" as const, content: "Rascunho: as vendas cresceram no trimestre, puxadas por camisetas. Quer que eu inclua os números por produto?" },
	{ role: "user" as const, content: ["Produto | Jan | Fev | Mar", "Camiseta | 120 | 98 | 143", "Boné | 40 | 51 | 38", "Caneca | 77 | 80 | 91", "usa isso"].join("\n") },
];

/** Termina numa pergunta ao usuário (última frase com "?"). */
export function endsWithQuestion(text: string): boolean {
	const lines = text.trim().split("\n").filter((line) => line.trim());
	return /\?\s*$/.test(lines.at(-1) ?? "");
}

const noQuestionNoDiscard = (outcome: ScenarioOutcome): string | null => {
	if (outcome.toolsCalled.includes("propose_questionnaire")) return "abriu questionário";
	if (outcome.discards.length > 0) return `resposta refeita (${outcome.discards.join(",")})`;
	if (endsWithQuestion(outcome.text)) return "terminou com pergunta em vez de aplicar";
	return null;
};

export const SCENARIOS: Scenario[] = [
	{
		id: 1,
		name: "cotação colada + 'altera os dados' → aplica, sem pergunta",
		messages: QUOTE,
		check: (outcome) => noQuestionNoDiscard(outcome) ?? (outcome.text.includes("98.765.432/0001-98") ? null : "não aplicou os dados colados"),
	},
	{
		id: 2,
		name: "tabela colada + 'usa isso' → aplica, sem pergunta",
		messages: TABLE,
		check: (outcome) => noQuestionNoDiscard(outcome) ?? (/143|361/.test(outcome.text) ? null : "não usou os números da tabela"),
	},
	{
		id: 3,
		name: "pedido óbvio de lembrete → propõe a rotina direto, sem questionário",
		messages: [{ role: "user", content: "me lembra amanhã às 9h de ligar pro fornecedor" }],
		check: (outcome) =>
			outcome.toolsCalled.includes("propose_questionnaire")
				? "abriu questionário"
				: outcome.toolsCalled.includes("propose_routine")
					? null
					: "não propôs a rotina",
	},
	{
		id: 4,
		name: "ação cara e ambígua ('apaga os pedidos') → uma pergunta curta é permitida",
		messages: [
			{ role: "user", content: "tenho pedidos de teste e pedidos de clientes reais no sistema" },
			{ role: "assistant", content: "Entendido." },
			{ role: "user", content: "apaga os pedidos" },
		],
		check: (outcome) => {
			const destructive = outcome.toolsCalled.filter((name) => /delete|apag|remove/i.test(name));
			if (destructive.length > 0) return `apagou sem perguntar (${destructive.join(",")})`;
			const questions = (outcome.text.match(/\?/g) ?? []).length;
			if (questions === 0) return "não perguntou";
			if (questions > 2) return "perguntas demais";
			return null;
		},
	},
	{
		id: 5,
		name: "modelo fraco que só promete ('vou gerar agora') → no máximo um empurrão, sem 'usuário não viu'",
		messages: [{ role: "user", content: "me manda um PDF de uma página explicando o que é inflação" }],
		check: (outcome) => {
			if (outcome.discards.length > 1) return `refez ${outcome.discards.length} vezes`;
			if (/did NOT see/.test(outcome.systemNotes)) return "nota falsa de que o usuário não viu";
			if (/^(vou|deixa eu|um momento)/i.test(outcome.text.trim())) return "terminou prometendo";
			return null;
		},
	},
	{
		id: 6,
		name: "nome de ferramenta torto ('List-Routines') → o runtime corrige e a leitura roda",
		messages: [{ role: "user", content: "quais rotinas eu tenho agendadas?" }],
		check: (outcome) => (outcome.toolsCalled.includes("list_routines") ? null : "não listou as rotinas"),
	},
];
