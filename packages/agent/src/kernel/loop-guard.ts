// Guarda de laço infinito (ADR 0003, trava que fica). Mesma tool + mesmos argumentos + mesmo resultado
// 5 vezes seguidas → nota ao modelo. Depois de 2 notas, se repetir mais 5 vezes → passo final.
// Resultado diferente (ex.: esperar um processo que avança) zera a contagem: não é repetição.
export const REPEAT_LIMIT = 5;
export const MAX_REPEAT_NOTES = 2;

export type GuardState = { signature: string; count: number; notes: number };

export const freshGuard = (): GuardState => ({ signature: "", count: 0, notes: 0 });

export type GuardVerdict = { state: GuardState; action: "ok" | "note" | "final" };

export function signatureOf(name: string, args: unknown, content: string): string {
	return `${name}\u0000${JSON.stringify(args) ?? ""}\u0000${content}`;
}

export function observeCall(state: GuardState, signature: string): GuardVerdict {
	const count = signature === state.signature ? state.count + 1 : 1;
	if (count < REPEAT_LIMIT) return { state: { signature, count, notes: state.notes }, action: "ok" };
	if (state.notes >= MAX_REPEAT_NOTES) return { state: { signature, count, notes: state.notes }, action: "final" };
	return { state: { signature, count: 0, notes: state.notes + 1 }, action: "note" };
}

export const REPEAT_NOTE =
	"You repeated the same call with the same arguments and got the same result several times in a row. Repeating it will not change the outcome. Try a different approach, or tell the owner what is blocking you.";
