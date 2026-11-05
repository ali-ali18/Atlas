// Classes de efeito (cláusula 1 do contrato de comportamento). Toda tool declara a sua em
// `defineTool`; quem decide o que fazer com cada classe (run | approve | handoff) é o
// `decide()` puro da F1.3, não este arquivo. Aqui só o vocabulário, igual em toda superfície.

export const EFFECT_CLASSES = [
	"read",
	"draft",
	"write_internal",
	"write_external",
	"send",
	"money",
	"public_link",
	"credential",
	"destructive",
] as const;

export type Effect = (typeof EFFECT_CLASSES)[number];

/** O que cada classe significa (pt-BR, para quem lê o código e para a UI de regras). */
export const EFFECT_DOCS: Readonly<Record<Effect, string>> = {
	read: "Só lê ou consulta; não muda nada em lugar nenhum. Pesquisar, abrir arquivo, listar.",
	draft: "Prepara algo que ainda é do próprio bot e não sai dele: rascunho de e-mail, minuta, prévia.",
	write_internal: "Escreve dentro do Atlas, no que é do dono e se desfaz: nota, rotina, painel, memória.",
	write_external: "Muda algo em sistema de terceiro: criar evento, editar planilha, abrir issue.",
	send: "Entrega algo a outra pessoa ou bot: e-mail, mensagem, convite. Não dá para recolher.",
	money: "Move ou compromete dinheiro: compra, pagamento, assinatura, transferência.",
	public_link: "Torna conteúdo acessível a quem tem o link ou a qualquer pessoa: compartilhar, publicar.",
	credential: "Usa ou altera segredo: preencher senha ou cartão, trocar chave, conectar conta.",
	destructive: "Apaga ou sobrescreve sem volta fácil: excluir arquivo, esvaziar caixa, cancelar.",
};

export function isEffect(value: unknown): value is Effect {
	return typeof value === "string" && (EFFECT_CLASSES as readonly string[]).includes(value);
}
