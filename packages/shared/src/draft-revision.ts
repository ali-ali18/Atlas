/**
 * Por que uma fala já transmitida ao chat deixou de ser a resposta final (`assistant_discard`).
 *
 * O usuário já leu o texto: apagá-lo em silêncio parece que a mensagem "sumiu". Por isso só a fala
 * repetida (`duplicate`, igual a uma que já está na tela) é retirada; as outras ficam visíveis,
 * recolhidas como "rascunho revisado" com o motivo, e a versão nova vem depois.
 */
export const DRAFT_REVISION_REASONS = [
	/** Narração repetida antes de tools: já está na tela, não é conteúdo novo. */
	"duplicate",
	/** Portão de itens: a tarefa ainda tinha itens abertos (ou faltava a lista). */
	"items_open",
	/** Verificador: o rascunho contradizia o resultado das ferramentas. */
	"evidence",
	/** O arquivo entregue tinha erro e foi refeito. */
	"file_fix",
	/** Arquivo pedido e não criado: o rascunho foi refeito para dizer a verdade ou criar o arquivo. */
	"missing_file",
	/** Uma fonte acabou os créditos no meio: o run seguiu por outra via. */
	"exhaustion",
	/** O passo estourou o prazo antes de terminar. */
	"timeout",
	/** O rascunho afirmava o que a tela mostra sem ter olhado a tela depois da última ação. */
	"unverified_screen",
	/** Run de código: o rascunho dava o trabalho por pronto com edição sem teste, typecheck, lint ou build depois. */
	"unverified_work",
] as const;

export type DraftRevisionReason = (typeof DRAFT_REVISION_REASONS)[number];

const LABELS: Record<DraftRevisionReason, string> = {
	duplicate: "fala repetida",
	items_open: "ainda faltavam itens da tarefa",
	evidence: "não batia com o que as ferramentas mostraram",
	file_fix: "o arquivo foi corrigido",
	missing_file: "o arquivo pedido ainda não existia",
	exhaustion: "uma fonte ficou sem créditos e o trabalho seguiu por outra via",
	timeout: "o passo demorou demais e foi refeito",
	unverified_screen: "eu ainda não tinha conferido a tela",
	unverified_work: "eu ainda não tinha rodado os testes das mudanças",
};

/** Motivo curto (pt-BR) mostrado no rascunho recolhido. Motivo desconhecido (evento antigo) → genérico. */
export function draftRevisionLabel(reason: string | undefined): string {
	return reason && Object.hasOwn(LABELS, reason) ? LABELS[reason as DraftRevisionReason] : "a resposta foi refeita";
}

/** O texto retirado continua na tela (recolhido)? Só a fala repetida sai de vez. */
export function keepsRevisedDraft(reason: string | undefined): boolean {
	return reason !== "duplicate";
}
