/**
 * Fila mínima de avisos rápidos (toast). Sem dependências e sem React: dá para chamar de qualquer lugar
 * (`toast.error("…")`) e o `<Toaster />` só renderiza o estado. Mensagem repetida substitui a anterior
 * (não empilha o mesmo erro cinco vezes).
 */
export type ToastTone = "error" | "success" | "info";

export type ToastItem = {
	id: number;
	message: string;
	tone: ToastTone;
	actionLabel?: string;
	onAction?: () => void;
};

export type ToastOptions = {
	tone?: ToastTone;
	/** ms até sumir; 0 deixa até a pessoa dispensar. */
	duration?: number;
	actionLabel?: string;
	onAction?: () => void;
};

export const MAX_TOASTS = 3;
export const DEFAULT_TOAST_MS = 5000;

type Listener = () => void;

export function createToastStore() {
	let items: ToastItem[] = [];
	let nextId = 1;
	const listeners = new Set<Listener>();
	const timers = new Map<number, ReturnType<typeof setTimeout>>();

	const emit = () => {
		for (const listener of listeners) listener();
	};

	function dismiss(id: number) {
		const timer = timers.get(id);
		if (timer) clearTimeout(timer);
		timers.delete(id);
		if (!items.some((item) => item.id === id)) return;
		items = items.filter((item) => item.id !== id);
		emit();
	}

	function push(message: string, options: ToastOptions = {}): number {
		const tone = options.tone ?? "info";
		const duplicate = items.find((item) => item.message === message && item.tone === tone);
		if (duplicate) dismiss(duplicate.id);
		const id = nextId++;
		const item: ToastItem = {
			id,
			message,
			tone,
			...(options.actionLabel ? { actionLabel: options.actionLabel } : {}),
			...(options.onAction ? { onAction: options.onAction } : {}),
		};
		items = [...items, item].slice(-MAX_TOASTS);
		for (const key of [...timers.keys()]) {
			if (!items.some((entry) => entry.id === key)) {
				clearTimeout(timers.get(key));
				timers.delete(key);
			}
		}
		const duration = options.duration ?? DEFAULT_TOAST_MS;
		if (duration > 0) timers.set(id, setTimeout(() => dismiss(id), duration));
		emit();
		return id;
	}

	return {
		push,
		dismiss,
		clear() {
			for (const id of items.map((item) => item.id)) dismiss(id);
		},
		getSnapshot: () => items,
		subscribe(listener: Listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

export const toastStore = createToastStore();

export const toast = {
	show: (message: string, options?: ToastOptions) => toastStore.push(message, options),
	error: (message: string, options?: Omit<ToastOptions, "tone">) => toastStore.push(message, { ...options, tone: "error" }),
	success: (message: string, options?: Omit<ToastOptions, "tone">) => toastStore.push(message, { ...options, tone: "success" }),
	dismiss: (id: number) => toastStore.dismiss(id),
};
