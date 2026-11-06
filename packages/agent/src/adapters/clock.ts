import type { Clock } from "../ports/clock.js";

/** `Clock` real: o relógio do sistema. Só aqui (e no teste, com relógio injetado) o tempo real entra no motor. */
export function createSystemClock(): Clock {
	return { now: () => new Date() };
}
