const LOBE_ICONS_VERSION = "1.95.0";

/**
 * O slug do provider no OpenRouter nem sempre bate com o nome do ícone no
 * LobeHub. Mapeia as divergências conhecidas.
 */
const LOBE_SLUG_ALIASES: Record<string, string> = {
	"meta-llama": "meta",
	mistralai: "mistral",
	"x-ai": "xai",
	"z-ai": "zai",
	amazon: "aws",
	"amazon-bedrock": "bedrock",
	"arcee-ai": "arcee",
	"bytedance-seed": "bytedance",
	"google-vertex": "google",
	"google-ai-studio": "google",
	"google-vertex-anthropic": "anthropic",
	"github-copilot": "github",
	"github-models": "github",
	"ibm-granite": "ibm",
	moonshotai: "moonshot",
	"moonshotai-cn": "moonshot",
	"zhipuai-coding-plan": "zhipu",
	"cloudflare-workers-ai": "cloudflare",
};

export function lobeProviderSlug(provider: string): string {
	const key = provider.trim().toLowerCase();
	return LOBE_SLUG_ALIASES[key] ?? key;
}

/** Marcas que não estão no LobeHub: SVG do thesvg.org (jsDelivr). */
const THESVG_ICONS: Record<string, string> = {
	opencode: "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/opencode/mono.svg",
	"opencode-go": "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/opencode/mono.svg",
};

/** Ícone colorido oficial do provider (LobeHub, CDN com versão fixada). */
export function lobeIconUrl(provider: string): string {
	const thesvg = THESVG_ICONS[provider.trim().toLowerCase()];
	if (thesvg) return thesvg;
	return `https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@${LOBE_ICONS_VERSION}/icons/${lobeProviderSlug(provider)}.svg`;
}

/** Fallback quando o provider não tem ícone no LobeHub. */
export function modelsDevIconUrl(provider: string): string {
	return `https://models.dev/logos/${provider}.svg`;
}
