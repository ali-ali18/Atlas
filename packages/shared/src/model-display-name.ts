const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Nome do modelo para a UI: sem o prefixo "Fornecedor: " que o OpenRouter
 * coloca no nome ("DeepSeek: DeepSeek V4.1 Flash" vira "DeepSeek V4.1 Flash").
 * O prefixo só sai quando bate com o segmento de fornecedor do id
 * ("Meta" ~ "meta-llama", "Z.ai" ~ "z-ai"); outros ":" ficam intactos.
 * Sem nome, cai para o trecho final do id.
 */
export function modelDisplayName(
	name: string | null | undefined,
	id?: string | null,
): string {
	const raw = (name ?? "").trim();
	const fallback = () => {
		const slug = (id ?? "").trim().split("/").pop() ?? "";
		return slug || (id ?? "").trim();
	};
	if (!raw) return fallback();
	const sep = raw.indexOf(": ");
	if (sep <= 0) return raw;
	const prefix = squash(raw.slice(0, sep));
	const rest = raw.slice(sep + 2).trim();
	if (!prefix || !rest) return raw;
	const vendor = squash((id ?? "").includes("/") ? (id ?? "").split("/")[0]! : "");
	const matches = vendor && (vendor.startsWith(prefix) || prefix.startsWith(vendor));
	return matches ? rest : raw;
}
