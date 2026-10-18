import { modelDisplayName, type OpenRouterModel } from "@workspace/shared";

/**
 * Nome curto do modelo em uso na sessão de código: o do catálogo quando existe;
 * fora dele, o slug do id com palavras capitalizadas ("anthropic/claude-sonnet-5.5" -> "Claude Sonnet 5.5").
 */
export function devModelLabel(id: string, models: readonly Pick<OpenRouterModel, "id" | "name">[] = []): string {
	const known = models.find((model) => model.id === id);
	if (known) return modelDisplayName(known.name, known.id);
	const slug = id.split("/").pop() ?? id;
	return slug
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => (/^[a-z]/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
		.join(" ");
}
