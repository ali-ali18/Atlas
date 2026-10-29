/**
 * Textos fixos dos cards do chat, num lugar só. Um vocabulário para todos:
 * dispensar = "Agora não"; pendente = "Precisa de você"; dispensado = "Dispensado";
 * recolhido = "Ver detalhes" / "Mostrar menos" (lista: "Ver tudo (n)").
 *
 * "Recusar" fica só onde a pessoa nega um comando que o bot pediu para rodar
 * (aprovação de comando): é uma resposta ao bot, não um "deixar para depois".
 */
export const CHAT_CARD_COPY = {
  /** Abre o corpo recolhido. */
  details: "Ver detalhes",
  /** Fecha o corpo aberto. */
  less: "Mostrar menos",
  /** Dispensar o pedido sem agir (botão). */
  dismiss: "Agora não",
  /** Selo do pedido dispensado. */
  dismissed: "Dispensado",
  /** Selo do pedido que espera a pessoa. */
  needsYou: "Precisa de você",
  /** Negar um comando que o bot pediu para rodar (semântica própria). */
  deny: "Recusar",
} as const;

/** "Ver tudo (n)": rótulo fechado de uma lista recolhida. */
export function seeAllLabel(count: number): string {
  return `Ver tudo (${count})`;
}
