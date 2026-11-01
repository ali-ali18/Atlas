import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Mesmo papel do `cn` do packages/ui: junta classes e resolve conflitos conhecendo os tokens do tema
 * (`text-body`/`text-caption` são tamanho, não cor; `rounded-card`/`rounded-panel` são raios).
 * Diferença inevitável: o web usa o pacote `cn`; aqui é clsx + tailwind-merge (padrão do reusables).
 */
const merge = extendTailwindMerge({
	extend: {
		classGroups: {
			"font-size": [{ text: ["body", "caption", "control"] }],
			rounded: [{ rounded: ["card", "panel"] }],
		},
	},
});

export function cn(...inputs: ClassValue[]) {
	return merge(clsx(inputs));
}
