/** Debounce mínimo (ms) do autosave de campos de texto de rotinas já criadas. */
export const ROUTINE_AUTOSAVE_DEBOUNCE_MS = 1200;

export type RoutineDraftFields = {
	name: string;
	instruction: string;
	triggers: ReadonlyArray<unknown>;
};

/** Rascunho só pode ser criado com nome, instrução e gatilho. */
export function isRoutineDraftValid(fields: RoutineDraftFields): boolean {
	return (
		fields.name.trim() !== "" &&
		fields.instruction.trim() !== "" &&
		fields.triggers.length > 0
	);
}

/** Rotina já criada: só autosalva com nome (nunca reescreve com um nome vazio). */
export function canAutosaveRoutine(fields: { name: string }): boolean {
	return fields.name.trim() !== "";
}

export type DebouncedSaver<T> = {
	/** Agenda o save (substitui o pendente). `immediate` salva já. */
	schedule: (value: T, immediate?: boolean) => void;
	/** Executa o pendente agora, se houver. */
	flush: () => void;
	cancel: () => void;
	hasPending: () => boolean;
};

/**
 * Debounce com flush: guarda o último valor e só chama `run` depois de
 * `delayMs` sem novas edições, ou quando `flush()` for chamado (blur/fechar).
 */
export function createDebouncedSaver<T>(
	run: (value: T) => void,
	delayMs: number = ROUTINE_AUTOSAVE_DEBOUNCE_MS,
	timers: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (handle: unknown) => void;
	} = {
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	},
): DebouncedSaver<T> {
	let pending: { value: T } | null = null;
	let handle: unknown = null;

	function clearTimer() {
		if (handle !== null) {
			timers.clear(handle);
			handle = null;
		}
	}

	function flush() {
		clearTimer();
		if (!pending) return;
		const { value } = pending;
		pending = null;
		run(value);
	}

	return {
		schedule(value, immediate = false) {
			pending = { value };
			clearTimer();
			if (immediate) {
				flush();
				return;
			}
			handle = timers.set(flush, delayMs);
		},
		flush,
		cancel() {
			clearTimer();
			pending = null;
		},
		hasPending: () => pending !== null,
	};
}
