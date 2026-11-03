// "Instalar" do detalhe do bot, sem React: valida o nome, chama o install, cria as rotinas escolhidas (o servidor não
// cria nenhuma: devolve a lista e quem chama as cria, como o web), põe o bot na home e lembra a instalação. Um toque
// só vale por vez, e depois de instalado um toque a mais não instala outro bot. Testado em catalog-install.test.ts.
import { skillLabel } from "./bot-cards";
import { catalogErrorText, type CatalogInstallBody, type CatalogInstallResult } from "./catalog-api";
import { isNetworkError, isUnauthorized } from "./chat-api";

/** O servidor do catálogo aceita nome de 1 a 40 caracteres (o editor de bot aceita mais). */
export const CATALOG_NAME_MAX = 40;

export type InstallInput = { name: string; useSuggestedModel: boolean; routines: readonly number[] };
export type InstallCheck = { ok: true; body: CatalogInstallBody } | { ok: false; error: string };

/** O corpo do POST: só `name`, `useSuggestedModel` e `routines` (índices sem repetir, em ordem). Nome de 1 a 40 caracteres, espaços compactados. */
export function buildInstallBody(input: InstallInput): InstallCheck {
	const name = input.name.replace(/\s+/g, " ").trim();
	if (!name || name.length > CATALOG_NAME_MAX) return { ok: false, error: `O nome deve ter de 1 a ${CATALOG_NAME_MAX} caracteres.` };
	const routines = [...new Set(input.routines.filter((index) => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
	return { ok: true, body: { name, useSuggestedModel: input.useSuggestedModel, routines } };
}

/** Avisos do servidor em frase simples: a habilidade pelo nome legível, nunca pelo slug. */
export function humanizeWarning(warning: string): string {
	const blocked = /^A habilidade (\S+) foi bloqueada/.exec(warning);
	if (blocked) return `A habilidade “${skillLabel(blocked[1]!)}” foi bloqueada pela varredura de segurança e não foi instalada.`;
	const failed = /^Não consegui instalar a habilidade (\S+?)\.?$/.exec(warning);
	if (failed) return `Não consegui instalar a habilidade “${skillLabel(failed[1]!)}”.`;
	return warning;
}

export const routineFailedText = (name: string): string => `Não consegui criar a rotina “${name}”. Você pode criá-la depois.`;

export const UNKNOWN_CREATED_TEXT = "Não sei se o bot foi criado. Confira na home antes de tentar de novo.";
export const ROUTINES_LOST_TEXT = "Não consegui criar as rotinas escolhidas. Você pode criá-las depois.";
/** Depois de uma falha de rede sem saber se o bot nasceu, o botão fica travado por este tempo. */
export const UNKNOWN_LOCK_MS = 5000;

export type BotRef = { id: string; name: string };
export type RecoveryVerdict = { kind: "created"; botId: string } | { kind: "not-created" } | { kind: "unknown" };

/**
 * Erro de rede no install: o servidor pode ter criado o bot e a resposta se perdeu. Compara a home de antes com a de
 * agora: bot novo com o nome pedido = foi criado (não instalar de novo); home atualizada sem ele = não foi; sem
 * conseguir atualizar a home, não dá para saber.
 */
export function decideAfterNetworkError(beforeIds: readonly string[], after: readonly BotRef[] | null, name: string): RecoveryVerdict {
	if (after === null) return { kind: "unknown" };
	const known = new Set(beforeIds);
	const created = after.find((bot) => !known.has(bot.id) && bot.name.replace(/\s+/g, " ").trim() === name);
	return created ? { kind: "created", botId: created.id } : { kind: "not-created" };
}

export type InstallDeps = {
	install: (slug: string, body: CatalogInstallBody) => Promise<CatalogInstallResult>;
	createRoutine: (botId: string, routine: { name: string; prompt: string; schedule: string }) => Promise<void>;
	/** Põe o bot de verdade na home (busca, `addBot` e atualização nova em segundo plano). */
	ensureBot: (botId: string) => Promise<unknown>;
	/** Lembra, neste aparelho, que o modelo virou este bot ("Instalado"). */
	remember: (slug: string, botId: string) => Promise<void>;
	onUnauthorized: () => void;
	/** Bots que a home tem agora (antes do install). */
	homeBots: () => BotRef[];
	/** Lista de bots do servidor agora; `null` se não deu para atualizar. */
	fetchBots: () => Promise<BotRef[] | null>;
	now?: () => number;
};

export type InstallOutcome = { ok: true; botId: string; name: string; warnings: string[] } | { ok: false; error: string; /** Sem saber se o bot nasceu: o botão fica travado um tempo. */ locked?: boolean };

export function createCatalogInstaller(deps: InstallDeps): (slug: string, input: InstallInput) => Promise<InstallOutcome | null> {
	const now = deps.now ?? Date.now;
	let inFlight = false;
	let installed = false;
	let lockedUntil = 0;
	return async (slug, input) => {
		if (inFlight || installed || now() < lockedUntil) return null;
		const check = buildInstallBody(input);
		if (!check.ok) return { ok: false, error: check.error };
		inFlight = true;
		try {
			const beforeIds = deps.homeBots().map((bot) => bot.id);
			let result: CatalogInstallResult;
			try {
				result = await deps.install(slug, check.body);
			} catch (reason) {
				if (isUnauthorized(reason)) deps.onUnauthorized();
				if (!isNetworkError(reason)) return { ok: false, error: catalogErrorText(reason, "install") };
				const verdict = decideAfterNetworkError(beforeIds, await deps.fetchBots().catch(() => null), check.body.name);
				if (verdict.kind === "not-created") return { ok: false, error: catalogErrorText(reason, "install") };
				if (verdict.kind === "unknown") {
					lockedUntil = now() + UNKNOWN_LOCK_MS;
					return { ok: false, error: UNKNOWN_CREATED_TEXT, locked: true };
				}
				// O bot nasceu e só a resposta se perdeu: segue como instalado. Habilidades e rotinas escolhidas não dá para confirmar.
				result = { botId: verdict.botId, name: check.body.name, installedSkills: [], routines: [], warnings: check.body.routines.length > 0 ? [ROUTINES_LOST_TEXT] : [] };
			}
			// Daqui em diante o bot existe: nada desfaz. Falha de rotina só vira aviso.
			installed = true;
			const warnings = result.warnings.map(humanizeWarning);
			// 401 no meio: a sessão acabou, então não adianta criar as outras (cada uma vira aviso) nem buscar o bot.
			let expired = false;
			for (const routine of result.routines) {
				if (expired) {
					warnings.push(routineFailedText(routine.name));
					continue;
				}
				try {
					await deps.createRoutine(result.botId, { name: routine.name, prompt: routine.prompt, schedule: routine.cron });
				} catch (reason) {
					if (isUnauthorized(reason)) {
						expired = true;
						deps.onUnauthorized();
					}
					warnings.push(routineFailedText(routine.name));
				}
			}
			await deps.remember(slug, result.botId).catch(() => undefined);
			if (!expired) await deps.ensureBot(result.botId).catch(() => undefined);
			return { ok: true, botId: result.botId, name: result.name, warnings };
		} finally {
			inFlight = false;
		}
	};
}
