import type { reasoning as ptBR } from "../pt-BR/reasoning";
import type { NamespaceMessages } from "../../translator";

export const reasoning: NamespaceMessages<typeof ptBR> = {
	"reasoning.label": "Reasoning",
	"reasoning.hint": "More reasoning answers better and costs more. Less is faster and cheaper. Applies to this bot on this device.",
	"reasoning.default": "Model default",
	"reasoning.defaultShort": "Default",
	"reasoning.off": "Off",
	"reasoning.low": "Low",
	"reasoning.medium": "Medium",
	"reasoning.high": "High",
	"reasoning.done": "Done",
	"reasoning.botDesc": "How much the model thinks before answering. Only applies to models with adjustable reasoning; the chat's model selector wins.",
};
