/**
 * V8 — subagente de navegador por item: regras puras (orçamento, filtro de
 * tools, limite de concorrência, mapeamento do resultado do filho para o
 * ledger de itens do pai). O executor mora em
 * `packages/agent-runtime/src/tools/delegate-task.ts`.
 */
import type { ChildBudget, SubagentStatus } from "./subagents.js";
import { isOpenItem, type ItemUpdate, type TaskLedger } from "./task-ledger.js";

export const DELEGATE_BROWSER_MODE = "browser_item";

/** Filhos com aba aberta ao mesmo tempo, somando todas as chamadas de delegate_task do run. */
export const BROWSER_CHILD_MAX_CONCURRENCY = 3;
/** Teto do filho de navegador: poucas decisões e pouco relógio (um item = uma leitura curta). */
export const BROWSER_CHILD_SOFT_STEPS = 12;
export const BROWSER_CHILD_HARD_STEPS = 15;
export const BROWSER_CHILD_WALL_MS = 90_000;
/** Relatório de um filho de navegador que o pai recebe (o detalhe vai em research_note). */
export const BROWSER_CHILD_REPORT_MAX_CHARS = 2_048;
export const BROWSER_ITEM_ID_MAX_CHARS = 40;
export const BROWSER_URL_MAX_CHARS = 2_000;

/**
 * Tools de navegador do filho: só as que agem na página da aba dele (DOM).
 * Sem screenshot, clique/tecla/rolagem por coordenada: esses agem na tela da VM, que é do pai.
 */
export const BROWSER_CHILD_TOOL_NAMES = [
	"navigate",
	"browser_click",
	"browser_type",
	"browser_text",
	"browser_links",
	"browser_read",
	"browser_find",
	"browser_snapshot",
	"browser_act",
	"browser_wait",
] as const;

export function isBrowserChildTool(name: string): boolean {
	return (BROWSER_CHILD_TOOL_NAMES as readonly string[]).includes(name);
}

/** Aperta o orçamento normal do filho para o de navegador (nunca o amplia). */
export function clampBrowserChildBudget(budget: ChildBudget): ChildBudget {
	const hardMaxSteps = Math.min(budget.hardMaxSteps, BROWSER_CHILD_HARD_STEPS);
	return {
		softMaxSteps: Math.min(budget.softMaxSteps, BROWSER_CHILD_SOFT_STEPS, hardMaxSteps),
		hardMaxSteps,
		maxWallMs: Math.min(budget.maxWallMs, BROWSER_CHILD_WALL_MS),
		maxTokens: budget.maxTokens,
	};
}

/** URL inicial do item: só http(s), sem credenciais embutidas. */
export function parseBrowserStartUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text || text.length > BROWSER_URL_MAX_CHARS) return null;
	try {
		const url = new URL(text);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function clipBrowserReport(report: string): string {
	const text = report.trim();
	return text.length <= BROWSER_CHILD_REPORT_MAX_CHARS ? text : `${text.slice(0, BROWSER_CHILD_REPORT_MAX_CHARS - 1)}…`;
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/** Rótulo curto demais casa com qualquer coisa ("A", "1"): não vale como sinal. */
const MIN_MATCH_LABEL_CHARS = 4;

const matchText = (text: string) =>
	` ${text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()} `;

/**
 * Qual item do checklist cada tarefa delegada cobre (um id por tarefa, ou `undefined`).
 * Regra conservadora, para nunca fechar item alheio:
 * 1. `item` explícito na tarefa vale se o id existe no ledger;
 * 2. sem ele, um item aberto casa só quando o rótulo inteiro dele (sem acento e caixa,
 *    palavras inteiras, >= 4 caracteres) aparece no título ou no objetivo da tarefa,
 *    e é o ÚNICO item aberto que casa com ela;
 * 3. o mesmo item casado por duas tarefas é ambíguo: nenhuma o fecha.
 */
export function mapDelegatedItems(
	tasks: ReadonlyArray<{ goal: string; title?: string; item?: string }>,
	ledger: TaskLedger | undefined,
): Array<string | undefined> {
	if (!ledger || ledger.items.length === 0) return tasks.map(() => undefined);
	const known = new Set(ledger.items.map((item) => item.id));
	const open = ledger.items
		.filter(isOpenItem)
		.map((item) => ({ id: item.id, key: matchText(item.label) }))
		.filter((item) => item.key.trim().length >= MIN_MATCH_LABEL_CHARS);
	const mapped = tasks.map((task) => {
		if (task.item) return known.has(task.item) ? task.item : undefined;
		const text = matchText(`${task.title ?? ""} ${task.goal}`);
		const hits = open.filter((item) => text.includes(item.key));
		return hits.length === 1 ? hits[0]!.id : undefined;
	});
	const inferredCount = new Map<string, number>();
	mapped.forEach((id, index) => {
		if (id && !tasks[index]!.item) inferredCount.set(id, (inferredCount.get(id) ?? 0) + 1);
	});
	const explicit = new Set(tasks.map((task) => task.item).filter(Boolean));
	return mapped.map((id, index) => {
		if (!id || tasks[index]!.item) return id;
		return (inferredCount.get(id) ?? 0) > 1 || explicit.has(id) ? undefined : id;
	});
}

/**
 * Resultado do filho -> atualização do item no ledger do pai. `ok` fecha com a evidência
 * (o que o filho leu); `partial` e `failed` fecham como `failed` com motivo `subagent` e a causa
 * real no detalhe: o pai vê o motivo e pode reler o item sozinho.
 */
export function ledgerUpdateFromChild(itemId: string, result: { status: SubagentStatus; report: string }): ItemUpdate {
	if (result.status === "ok") {
		return { id: itemId, status: "done", evidence: oneLine(result.report, 200) || "Read by a sub-agent.", ref: undefined };
	}
	const cause = oneLine(result.report.replace(/^Sub-agent failed:\s*/i, ""), 160);
	const prefix = result.status === "partial" ? "partial read" : "not read";
	return { id: itemId, status: "failed", reason: "subagent", detail: oneLine(`${prefix}: ${cause}`, 200) };
}

/** Semáforo simples: no máximo `max` tarefas ao mesmo tempo; as demais esperam a vez (FIFO). */
export type ConcurrencyLimiter = {
	acquire: () => Promise<() => void>;
	active: () => number;
};

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
	const limit = Math.max(1, Math.floor(max));
	let active = 0;
	const waiting: Array<() => void> = [];
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else active -= 1;
	};
	return {
		active: () => active,
		acquire: async () => {
			if (active < limit) {
				active += 1;
			} else {
				await new Promise<void>((resolve) => waiting.push(resolve));
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				release();
			};
		},
	};
}
