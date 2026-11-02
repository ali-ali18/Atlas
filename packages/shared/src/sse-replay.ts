/**
 * Guarda de repetição do stream do run: o servidor numera os eventos (`id:`) e reenvia pelo cursor
 * quando a conexão cai. Evento com id já visto, ou menor/igual ao cursor, não pode ser aplicado de novo
 * (um `assistant_delta` repetido duplicaria o texto da bolha). Evento sem id (ou com id 0, que o servidor usa em avisos fora da sequência, como "run não encontrado") sempre passa.
 */
export function createSseReplayGuard(after = 0) {
	let cursor = after;
	return {
		/** true = aplicar o evento; false = repetido/atrasado (descartar). */
		accept(id: number | undefined): boolean {
			if (id === undefined || id <= 0) return true;
			if (id <= cursor) return false;
			cursor = id;
			return true;
		},
		get cursor(): number {
			return cursor;
		},
	};
}
