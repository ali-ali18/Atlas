/**
 * Ações que só aparecem no hover (desktop). Em tela de toque (`@media (hover: none)`) não existe hover,
 * então elas ficam sempre visíveis, discretas (60%), em vez de escondidas: nada de ação invisível no celular.
 * As classes são literais para o Tailwind enxergá-las.
 */
export type HoverRevealGroup = "message" | "trigger" | "group";

const BASE = "opacity-0 transition-opacity [@media(hover:none)]:opacity-60";

const BY_GROUP: Record<HoverRevealGroup, string> = {
	message: `${BASE} group-hover/message:opacity-100 focus-within:opacity-100 focus-visible:opacity-100`,
	trigger: `${BASE} group-hover/trigger:opacity-100 focus-visible:opacity-100`,
	group: `${BASE} group-hover:opacity-100 focus-visible:opacity-100`,
};

/** Classes de "aparece no hover; no toque fica visível e discreto". */
export function hoverRevealClass(group: HoverRevealGroup): string {
	return BY_GROUP[group];
}
