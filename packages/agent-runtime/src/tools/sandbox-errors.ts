/**
 * Erros técnicos da VM viravam `tool_result failed` cru em inglês e o modelo
 * generalizava ("a VM não está rodando"). Aqui viram PT-BR acionável: dizem o
 * que aconteceu e como conferir o estado (snapshot/screenshot), nunca "repita
 * a ação" (isso alimentava o detector de laço da F4).
 */

/** Falhas seguidas de infraestrutura até sugerir sair do computador. */
export const INFRA_FAILURES_BEFORE_FALLBACK = 2;

const NEXT_LOOK =
	"Confira o estado com `browser_snapshot` (ou `screenshot`) antes de agir de novo.";

function isDisabled(lower: string): boolean {
	return lower.includes("sandbox desativado") || lower.includes("sandbox disabled");
}

function isSessionLost(lower: string): boolean {
	return (
		lower.includes("session not found") ||
		lower.includes("stopped") ||
		lower.includes("removida") ||
		lower.includes("pausada")
	);
}

function isVmUnreachable(lower: string): boolean {
	return (
		lower.includes("econnrefused") ||
		lower.includes("fetch failed") ||
		lower.includes("socket hang up") ||
		lower.includes("did not become ready") ||
		lower.includes("failed to start sandbox")
	);
}

function isChromeDown(lower: string): boolean {
	return lower.includes("chrome") || lower.includes("perfil");
}

/** Falha da VM/Chrome (não do que a página ou o modelo fez). */
export function isSandboxInfraError(message: string): boolean {
	const lower = message.toLowerCase();
	return isSessionLost(lower) || isVmUnreachable(lower) || isChromeDown(lower);
}

/** Teto do detalhe técnico que vai ao modelo (V1: sem 2 a 4 KB de log do Playwright). */
export const ERROR_DETAIL_MAX = 300;

/**
 * Detalhe técnico enxuto: corta o "Call log:" do Playwright e limita o tamanho.
 * O servidor da VM já compacta; isto protege contra imagens antigas do sandbox.
 */
export function compactErrorDetail(message: string, max = ERROR_DETAIL_MAX): string {
	const head = message.split(/\r?\n\s*Call log:/i)[0] ?? message;
	const line = head
		.split(/\r?\n/)
		.map((part) => part.trim())
		.filter(Boolean)
		.join(" ");
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export function friendlySandboxError(name: string, rawMessage: string): string {
	const message = compactErrorDetail(rawMessage);
	const lower = message.toLowerCase();
	if (isDisabled(lower)) {
		return `Navegador indisponível: o sandbox está desativado nas configurações. Avise o usuário e conclua sem ferramentas de navegador. Detalhe: ${message}`;
	}
	if (isSessionLost(lower)) {
		return `A sessão da VM foi pausada ou removida e será recriada sozinha na próxima chamada (o perfil do Chrome, com os logins, é mantido). ${NEXT_LOOK} Não diga ao usuário que a VM parou. Detalhe: ${message}`;
	}
	if (isVmUnreachable(lower)) {
		return `A VM não respondeu a tempo (pode estar reiniciando). Aguarde a página carregar. ${NEXT_LOOK} Se a VM seguir fora, avise o usuário. Detalhe: ${message}`;
	}
	if (isChromeDown(lower)) {
		return `O Chrome dentro da VM travou ou está indisponível (o servidor já tentou reiniciá-lo). Recarregue a página com \`navigate\`. ${NEXT_LOOK} Se persistir, avise o usuário em vez de insistir. Detalhe: ${message}`;
	}
	return `A ação \`${name}\` na VM falhou. ${NEXT_LOOK} Detalhe: ${message}`;
}

const LEAVE_COMPUTER_HINT =
	"A VM falhou de novo: é problema de infraestrutura, não da página. PARE de usar as ferramentas do computador (navegador/desktop). Leia páginas com `web_extract`/`web_search` ou conclua com o que já tem e diga ao usuário o que faltou e por quê.";

/**
 * Conta falhas seguidas de infra por run. A partir da 2ª, o resultado manda
 * sair do computador (F12/A5) em vez de insistir até a trava global.
 */
export function createSandboxErrorTracker() {
	let infraStreak = 0;
	return {
		onFailure(name: string, message: string): string {
			if (isSandboxInfraError(message)) infraStreak += 1;
			else infraStreak = 0;
			const base = friendlySandboxError(name, message);
			return infraStreak >= INFRA_FAILURES_BEFORE_FALLBACK
				? `${base}\n${LEAVE_COMPUTER_HINT}`
				: base;
		},
		onSuccess() {
			infraStreak = 0;
		},
		get streak() {
			return infraStreak;
		},
	};
}
