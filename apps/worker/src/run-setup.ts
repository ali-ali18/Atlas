/**
 * Setup do run em paralelo (L10): leituras independentes entre si saem juntas em
 * vez de uma atrás da outra. Só entra aqui o que NÃO depende do resultado de
 * outra etapa (settings, checkpoint, política do bot, idioma, autonomia e,
 * encadeado a ela, os conectores MCP). O que depende (snapshot de config,
 * mensagens, orçamento) continua em ordem no processor.
 *
 * Falha de settings ou de conectores nunca derruba o run (mesmo contrato de
 * antes); falha de qualquer outra leitura rejeita o setup todo.
 */
export async function loadRunBase<TSettings, TCheckpoint, TLanguage, TAutonomy, TMcp>(deps: {
	getSettings: () => Promise<TSettings>;
	defaultSettings: TSettings;
	onSettingsError?: (error: unknown) => void;
	getCheckpoint: () => Promise<TCheckpoint>;
	getBotPolicy: () => Promise<unknown>;
	getLanguage: () => Promise<TLanguage>;
	resolveAutonomy: () => Promise<TAutonomy>;
	loadMcp: (autonomy: TAutonomy) => Promise<TMcp>;
	onMcpError?: (error: unknown) => void;
}): Promise<{
	settings: TSettings;
	checkpoint: TCheckpoint;
	rawBotPolicy: unknown;
	language: TLanguage;
	autonomy: TAutonomy;
	mcp: TMcp | null;
}> {
	const [settings, checkpoint, rawBotPolicy, language, autonomyAndMcp] = await Promise.all([
		deps.getSettings().catch((error) => {
			deps.onSettingsError?.(error);
			return deps.defaultSettings;
		}),
		deps.getCheckpoint(),
		deps.getBotPolicy(),
		deps.getLanguage(),
		// Os conectores dependem da autonomia: encadeados, mas em paralelo com o resto.
		deps.resolveAutonomy().then(async (autonomy) => ({
			autonomy,
			mcp: await deps.loadMcp(autonomy).catch((error) => {
				deps.onMcpError?.(error);
				return null;
			}),
		})),
	]);
	return { settings, checkpoint, rawBotPolicy, language, ...autonomyAndMcp };
}
