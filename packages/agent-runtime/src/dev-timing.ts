import type { DevTimingEvent } from "@workspace/shared";

/**
 * Cronômetro de um run de código: soma onde o tempo foi (modelo, comandos, esperas de
 * `shell_output`, preparação) e emite `dev_timing` com limite de frequência. Só números.
 */
export const DEV_TIMING_THROTTLE_MS = 5_000;

type Emit = (event: DevTimingEvent) => void | Promise<void>;

export function createDevTimingTracker(options: { emit: Emit; now?: () => number; throttleMs?: number }) {
	const now = options.now ?? Date.now;
	const throttleMs = options.throttleMs ?? DEV_TIMING_THROTTLE_MS;
	const startedAt = now();
	const sums = { modelMs: 0, firstTokenMs: 0, toolsMs: 0, shellMs: 0, pollWaitMs: 0, setupMs: 0, approvalMs: 0, steps: 0 };
	let sessionId: string | undefined;
	let model: string | undefined;
	let approvalPendingAt: number | undefined;
	let lastEmitAt = 0;
	let dirty = false;
	let lastSignature = "";

	const round = (ms: number) => Math.max(0, Math.round(ms));

	function snapshot(): DevTimingEvent | null {
		if (!sessionId) return null;
		return {
			type: "dev_timing",
			sessionId,
			...(model ? { model } : {}),
			startedAt,
			...sums,
			...(approvalPendingAt ? { approvalPendingAt } : {}),
		};
	}

	async function flush(force: boolean): Promise<boolean> {
		const event = snapshot();
		if (!event || !dirty) return false;
		const at = now();
		if (!force && at - lastEmitAt < throttleMs) return false;
		const signature = JSON.stringify({ ...event, startedAt: 0 });
		if (signature === lastSignature) {
			dirty = false;
			return false;
		}
		lastEmitAt = at;
		lastSignature = signature;
		dirty = false;
		await options.emit(event);
		return true;
	}

	return {
		/** A sessão só é conhecida depois do primeiro uso das tools de código. */
		setSession(id: string | undefined, modelId?: string) {
			if (id) sessionId = id;
			if (modelId) model = modelId;
			dirty = true;
		},
		model(input: { ms: number; firstTokenMs?: number; model?: string }) {
			sums.modelMs += round(input.ms);
			sums.firstTokenMs += round(input.firstTokenMs ?? 0);
			sums.steps += 1;
			if (input.model) model = input.model;
			dirty = true;
		},
		/** Tool da sessão: `shell` conta como comando, `shell_output` como espera de polling; o resto só em `toolsMs`. */
		tool(name: string, ms: number) {
			if (name === "dev_session_start") return;
			const value = round(ms);
			sums.toolsMs += value;
			if (name === "shell") sums.shellMs += value;
			else if (name === "shell_output") sums.pollWaitMs += value;
			dirty = true;
		},
		setup(ms: number) {
			sums.setupMs += round(ms);
			dirty = true;
		},
		approval(ms: number) {
			sums.approvalMs += round(ms);
			dirty = true;
		},
		/** Cartão de confirmação aberto: o run para e a espera é somada com o início do run seguinte. */
		approvalPending() {
			approvalPendingAt = now();
			dirty = true;
		},
		snapshot,
		maybeEmit: () => flush(false),
		finish: () => flush(true),
	};
}
