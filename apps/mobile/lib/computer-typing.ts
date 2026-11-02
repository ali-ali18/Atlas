// Digitação ao vivo na VM: o teclado do aparelho escreve num campo invisível e cada mudança vira texto e teclas
// na VM, em ordem e uma por vez. Tudo puro (o envio entra por injeção), para testar sem aparelho.

/** Tamanho máximo de um envio de texto (pedaços maiores são divididos). */
const VM_TEXT_MAX = 2000;

/** Parte da troca que a VM precisa receber: apagar `backspaces` caracteres e depois digitar `text`. */
export type TypingDiff = { backspaces: number; text: string };

/** Quantos caracteres (pontos de código, não unidades UTF-16) tem o texto: um emoji apaga com um Backspace só. */
function codePoints(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

/**
 * Diferença entre o valor anterior e o novo do campo. Como o cursor da VM está sempre no fim do que foi digitado,
 * qualquer mudança é lida como "apagar do fim até o trecho em comum e digitar o resto":
 * - anexar "abc" -> { 0, "abc" }; apagar 2 -> { 2, "" };
 * - troca no meio, autocorreção ou composição do IME ("ola" -> "olá") -> apaga a cauda diferente e digita a nova.
 * O prefixo comum nunca corta um par substituto (emoji).
 */
export function diffTyping(prev: string, next: string): TypingDiff {
	let p = 0;
	const max = Math.min(prev.length, next.length);
	while (p < max && prev[p] === next[p]) p++;
	// Não deixa o prefixo terminar no meio de um par substituto.
	if (p > 0) {
		const code = prev.charCodeAt(p - 1);
		if (code >= 0xd800 && code <= 0xdbff) p--;
	}
	return { backspaces: codePoints(prev.slice(p)), text: next.slice(p) };
}

/**
 * Colchão invisível do campo: sem ele o Backspace num campo vazio não gera nenhuma mudança e a VM nunca o receberia.
 * Apagar come o colchão (e vira Backspace na VM); `needsRefill` diz quando repô-lo.
 */
export const TYPING_BUFFER = "​".repeat(24);
const BUFFER_FLOOR = "​".repeat(8);
const VALUE_MAX = 400;

/** O campo gastou o colchão (ou cresceu demais): hora de voltar a `TYPING_BUFFER` sem mandar nada à VM. */
export function needsRefill(value: string): boolean {
	return !value.startsWith(BUFFER_FLOOR) || value.length > VALUE_MAX;
}

/** Fila que roda uma tarefa por vez, em ordem. Falha de uma não trava as seguintes: vai para `onError`. */
export function createSerialQueue(onError: (error: unknown) => void) {
	let tail: Promise<void> = Promise.resolve();
	return function enqueue(task: () => Promise<void>): Promise<void> {
		tail = tail.then(task).catch(onError);
		return tail;
	};
}

export type TypingDeps = {
	sendText: (text: string) => Promise<void>;
	sendKey: (key: "Return" | "BackSpace") => Promise<void>;
	onError: (error: unknown) => void;
};

/** Teto de Backspaces por mudança (um campo colado e apagado de uma vez não vira milhares de chamadas). */
export const MAX_BACKSPACES = 200;

/**
 * Liga o campo invisível à VM. `change(next)` devolve o valor para o campo repor (ou `null` se não precisa);
 * `submit()` manda Enter. Todas as chamadas à VM saem em ordem, uma por vez.
 */
export function createTypingController(deps: TypingDeps) {
	const enqueue = createSerialQueue(deps.onError);
	let prev = TYPING_BUFFER;
	return {
		/** Valor inicial do campo. */
		initial: TYPING_BUFFER,
		change(next: string): string | null {
			const diff = diffTyping(prev, next);
			prev = next;
			for (let i = 0; i < Math.min(diff.backspaces, MAX_BACKSPACES); i++) void enqueue(() => deps.sendKey("BackSpace"));
			// O colchão nunca vai para a VM (só o que a pessoa digitou).
			const typed = diff.text.replace(/\u200b/g, "");
			for (let i = 0; i < typed.length; i += VM_TEXT_MAX) {
				const chunk = typed.slice(i, i + VM_TEXT_MAX);
				void enqueue(() => deps.sendText(chunk));
			}
			if (needsRefill(next)) {
				prev = TYPING_BUFFER;
				return TYPING_BUFFER;
			}
			return null;
		},
		submit(): void {
			void enqueue(() => deps.sendKey("Return"));
		},
		/**
		 * O campo foi (re)montado com `initial`: a base da comparação volta a ser o colchão. Sem isto, depois de uma
		 * remontagem (reconexão) o texto antigo ainda seria a base e a primeira tecla apagaria da VM o que já estava lá.
		 */
		reset(): string {
			prev = TYPING_BUFFER;
			return TYPING_BUFFER;
		},
		/** Resolve quando tudo o que foi pedido até agora terminou (útil nos testes). */
		idle(): Promise<void> {
			return enqueue(async () => undefined);
		},
	};
}
