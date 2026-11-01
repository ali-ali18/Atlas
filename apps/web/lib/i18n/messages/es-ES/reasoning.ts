import type { reasoning as ptBR } from "../pt-BR/reasoning";
import type { NamespaceMessages } from "../../translator";

export const reasoning: NamespaceMessages<typeof ptBR> = {
	"reasoning.label": "Razonamiento",
	"reasoning.hint": "Más razonamiento responde mejor y cuesta más. Menos es más rápido y barato.",
	"reasoning.default": "Predeterminado del modelo",
	"reasoning.defaultShort": "Predet.",
	"reasoning.off": "Desactivado",
	"reasoning.low": "Bajo",
	"reasoning.medium": "Medio",
	"reasoning.high": "Alto",
	"reasoning.done": "Listo",
	"reasoning.botDesc": "Cuánto piensa el modelo antes de responder. Solo vale para modelos con razonamiento ajustable; la elección en el selector del chat tiene prioridad.",
};
