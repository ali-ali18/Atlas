/**
 * Classificação automática de falha por run (Motor v4, `PLANO-AGENTE-V4/04-avaliacao.md` §4).
 * Função pura sobre um traço ESTRUTURAL: nada de regex nem de leitura de texto livre do usuário ou do modelo
 * (`60-agente.md`). Todo sinal vem de campo tipado que o runtime ou o adaptador do eval preenche.
 * Serve ao eval e, depois, à produção: o mesmo traço, a mesma classe.
 */

export const FAILURE_CLASSES = [
	"harness.tool_not_exposed",
	"harness.context_lost",
	"harness.policy_misfire",
	"harness.stale_task_injection",
	"model.bad_args",
	"model.announce_stop",
	"model.loop",
	"model.nagging",
	"env.connector",
	"env.network",
	"env.vm",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type RunFailureToolCall = {
	name: string;
	ok: boolean;
	/** Código curto de erro devolvido pela tool (só para evidência). Nunca a mensagem. */
	errorCode?: string;
	/** A tool existia, mas não estava no catálogo nem no índice de busca quando o modelo a procurou. */
	notInCatalog?: boolean;
	/** O modelo chamou uma tool que o harness tinha escondido naquele passo. */
	hidden?: boolean;
	/** O validador de args recusou a chamada. */
	validationRejected?: boolean;
	/** A assinatura (schema) da tool estava visível ao modelo quando ele errou os args. */
	signatureVisible?: boolean;
};

export type RunFailureStep = { toolCalls: RunFailureToolCall[] };

export type RunFailureTransportError = { kind: "connector" | "network" | "vm"; code?: string };

export type RunFailureTrace = {
	steps: RunFailureStep[];
	stop?: { reason?: string | null; detail?: string | null };
	transportErrors?: RunFailureTransportError[];
	/** O contexto montado trouxe tarefa ou oferta de um run anterior que o dono não retomou. */
	staleTaskInjected: boolean;
	/** Ofertas que o dono recusou (ids/tópicos declarados estruturalmente, não texto). */
	declinedOffers: string[];
	/** Tópicos que o dono largou (silêncio + assunto novo), registrados pelo harness. */
	abandonedTopics?: string[];
	/** Tópicos que o modelo ofereceu de novo neste run, declarados numa tool/campo estruturado. */
	offeredTopics?: string[];
	openTaskItemsAtEnd: number;
	endedWithoutTool: boolean;
	repetitionBlocked: boolean;
	compactionHappened: boolean;
	reReadAfterCompactionEmpty: boolean;
	approvalCardForReadEffect: boolean;
	denyLaterAllowedByOwner: boolean;
};

export type RunFailureClassification = {
	primary: FailureClass | "none";
	/** Todas as classes que se aplicam, na ordem de prioridade. */
	all: FailureClass[];
	/** Frases curtas em pt-BR, sem segredo (nunca args nem mensagens de terceiros). */
	evidence: string[];
};

/**
 * Ordem de prioridade: env.* > harness.* > model.*.
 * Falha de ambiente (conector, rede, VM) derruba o run por causa alheia e produz sintomas no modelo
 * (laço, parada anunciada). Defeito do harness (tool escondida, contexto perdido, política errada, tarefa velha
 * reinjetada) também induz sintoma no modelo. Atribuir ao modelo só o que sobra quando a causa mais acima não existe.
 */
const PRIORITY: readonly FailureClass[] = [
	"env.connector",
	"env.network",
	"env.vm",
	"harness.tool_not_exposed",
	"harness.context_lost",
	"harness.policy_misfire",
	"harness.stale_task_injection",
	"model.bad_args",
	"model.announce_stop",
	"model.loop",
	"model.nagging",
];

/** Evidência só leva identificador curto (caracteres de id, máx. 40): nada de espaço, mensagem ou token longo. */
const ident = (value: string, max = 40): string => value.replace(/[^\w.:-]/g, "").slice(0, max);
const codeNote = (code: string | undefined): string => (code && ident(code) ? ` (código ${ident(code)})` : "");

export function classifyRunFailure(trace: RunFailureTrace): RunFailureClassification {
	const found = new Map<FailureClass, string[]>();
	const add = (cls: FailureClass, evidence: string) => {
		const list = found.get(cls) ?? [];
		if (!list.includes(evidence)) list.push(evidence);
		found.set(cls, list);
	};
	const calls = trace.steps.flatMap((step) => step.toolCalls);

	for (const err of trace.transportErrors ?? []) {
		if (err.kind === "connector") add("env.connector", `Erro do conector${codeNote(err.code)}.`);
		else if (err.kind === "network") add("env.network", `Erro de rede${codeNote(err.code)}.`);
		else if (err.kind === "vm") add("env.vm", `Erro da VM${codeNote(err.code)}.`);
	}

	for (const call of calls) {
		const name = ident(call.name, 60);
		if (call.notInCatalog) add("harness.tool_not_exposed", `O modelo procurou "${name}", que existia mas não estava no catálogo nem no índice.`);
		if (call.hidden) add("harness.tool_not_exposed", `O modelo chamou "${name}", que estava escondida neste passo.`);
		// Só é erro do modelo com a assinatura correta visível; sem ela o defeito é de quem montou o contexto.
		if (call.validationRejected && call.signatureVisible === true) add("model.bad_args", `Args recusados pelo validador em "${name}" com a assinatura visível${codeNote(call.errorCode)}.`);
	}

	if (trace.compactionHappened && trace.reReadAfterCompactionEmpty) add("harness.context_lost", "A informação ficou antes da compactação e a releitura veio vazia.");
	if (trace.approvalCardForReadEffect) add("harness.policy_misfire", "Cartão de aprovação para uma ferramenta de leitura.");
	if (trace.denyLaterAllowedByOwner) add("harness.policy_misfire", "Recusa automática que o dono depois liberou.");

	if (trace.endedWithoutTool && trace.openTaskItemsAtEnd > 0) add("model.announce_stop", `Terminou sem chamar ferramenta com ${trace.openTaskItemsAtEnd} item(ns) da própria lista abertos.`);
	if (trace.repetitionBlocked) add("model.loop", "Repetição bloqueada pelo harness.");

	// Insistência: o mesmo sinal estrutural (oferta repetida de algo recusado/largado) vira causa do harness
	// se ele reinjetou trabalho velho, e do modelo só quando o contexto estava limpo.
	const dropped = new Set([...trace.declinedOffers, ...(trace.abandonedTopics ?? [])]);
	const reoffered = [...new Set(trace.offeredTopics ?? [])].filter((topic) => dropped.has(topic));
	// Injetar tarefa velha já é defeito do harness (cláusula 17), mesmo que o modelo resista e não ofereça de novo:
	// o mesmo contexto com outro modelo insiste. Por isso a injeção conta sozinha.
	if (trace.staleTaskInjected) {
		add("harness.stale_task_injection", reoffered.length > 0 ? `Contexto trouxe tarefa velha e o modelo ofereceu de novo ${reoffered.length} tópico(s) recusado(s) ou largado(s).` : "Contexto trouxe tarefa velha de um run anterior que o dono não retomou.");
	} else if (reoffered.length > 0) {
		add("model.nagging", `Contexto limpo e o modelo ofereceu de novo ${reoffered.length} tópico(s) recusado(s) ou largado(s).`);
	}

	const all = PRIORITY.filter((cls) => found.has(cls));
	return { primary: all[0] ?? "none", all, evidence: all.flatMap((cls) => found.get(cls) ?? []) };
}
