/**
 * Motor v2 (E1): o contexto MANTÉM o trabalho. Antes, a higiene sobrescrevia o histórico canônico a cada passo e colapsava todo
 * resultado de tool, menos o último, mesmo sem pressão nenhuma: as refs do passo 2 sumiam no passo 8 e o bot refazia o trabalho.
 * Agora a higiene vale só para a cópia enviada ao modelo, os 6 últimos grupos ficam inteiros, os antigos só encolhem sob pressão
 * real de janela, capturas de tela vão só as 2 últimas e o resumo vem antes do corte duro. Puro.
 */

/** Aviso único ao modelo: a conversa passou deste ponto da janela do modelo. */
export const CONTEXT_WARN_RATIO = 0.75;
/** Guarda suave por janela: limpa os resultados antigos (a conversa fica). Acima do aviso, abaixo do corte duro. */
export const CONTEXT_SOFT_RATIO = 0.85;
/** Corte duro só aqui, depois do resumo; se ainda não couber, o erro fiel da janela sobe (nunca um corte silencioso). */
export const CONTEXT_HARD_RATIO = 0.9;

/** Nota ao modelo (inglês, sem falar em teto de gasto nem de tempo). */
export const CONTEXT_WINDOW_NOTE =
	"Context notice: this conversation is filling the model's context window. Older tool results will be summarized or cleared. Write down in the notebook what you still need, and finish the task rather than repeating work already done.";

/** `ATLAS_ENGINE_V2_CONTEXT_KEEP=off` desliga o E1 de uma vez (volta ao comportamento anterior) se o custo disparar. Padrão: ligado. */
export function contextKeepEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return (env.ATLAS_ENGINE_V2_CONTEXT_KEEP ?? "").trim().toLowerCase() !== "off";
}
