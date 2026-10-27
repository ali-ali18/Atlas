import { readFileSync, readdirSync } from "node:fs";

/** Porta do noVNC (websockify): o viewer do painel conecta aqui. */
export const VIEWER_PORT = 6080;

/** Conexões TCP ESTABLISHED na porta local `port`, lendo /proc/net/tcp e /proc/net/tcp6. */
export function countEstablished(tcpText, port) {
	const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
	let count = 0;
	for (const line of String(tcpText).split("\n").slice(1)) {
		const cols = line.trim().split(/\s+/);
		// cols: sl local_address rem_address st ...
		if (cols.length < 4) continue;
		const local = cols[1] ?? "";
		if (cols[3] === "01" && local.slice(local.lastIndexOf(":") + 1).toUpperCase() === hexPort) count += 1;
	}
	return count;
}

function readOrEmpty(path, read) {
	try {
		return read(path);
	} catch {
		return "";
	}
}

/** Clientes do noVNC conectados agora (alguém olhando ou digitando na tela). */
export function countViewerClients(read = (path) => readFileSync(path, "utf8")) {
	return countEstablished(readOrEmpty("/proc/net/tcp", read), VIEWER_PORT) + countEstablished(readOrEmpty("/proc/net/tcp6", read), VIEWER_PORT);
}

/**
 * Processos do usuário `uid` (o sandbox_shell roda como `atlas` via docker exec, fora deste servidor):
 * comando longo em andamento não pode parecer VM ociosa.
 */
export function countUserProcesses(uid, { listDir = readdirSync, read = (path) => readFileSync(path, "utf8") } = {}) {
	let count = 0;
	let entries = [];
	try {
		entries = listDir("/proc");
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const status = readOrEmpty(`/proc/${entry}/status`, read);
		const match = /^Uid:\s+(\d+)/m.exec(status);
		if (match && Number.parseInt(match[1], 10) === uid) count += 1;
	}
	return count;
}

/** Chamada "em andamento" há mais que isto é considerada vazada (handler preso): deixa de contar como uso. */
export const IN_FLIGHT_MAX_MS = 10 * 60_000;

/**
 * Atividade da VM para o /idle. `idleMs` só passa de 0 quando NADA está em uso: nenhuma chamada em
 * andamento, nenhum viewer conectado e nenhum processo do shell do agente. Chamar ferramenta é
 * instantâneo e a pessoa digitando senha/2FA no viewer não gera chamada alguma, por isso o viewer conta.
 *
 * Cada `begin()` devolve um token e `end(token)` é idempotente: um par que se repete (ex.: `finally` e
 * `close` da resposta) não zera a chamada de outro. Chamada com mais de `IN_FLIGHT_MAX_MS` é ignorada,
 * então um handler que nunca termina não deixa a VM "ocupada" para sempre.
 */
export function createActivityTracker({ now = Date.now, viewers = () => 0, shellProcesses = () => 0, inFlightMaxMs = IN_FLIGHT_MAX_MS } = {}) {
	let lastActivityAt = now();
	let nextToken = 0;
	/** token -> início (ms) */
	const inFlight = new Map();
	const liveCount = () => {
		const cutoff = now() - inFlightMaxMs;
		for (const [token, startedAt] of inFlight) if (startedAt < cutoff) inFlight.delete(token);
		return inFlight.size;
	};
	return {
		begin() {
			const token = ++nextToken;
			inFlight.set(token, now());
			lastActivityAt = now();
			return token;
		},
		end(token) {
			// Sem token: encerra a mais antiga (uso legado, begin/end sem par explícito).
			const key = token ?? inFlight.keys().next().value;
			if (key !== undefined) inFlight.delete(key);
			lastActivityAt = now();
		},
		snapshot() {
			const viewerCount = viewers();
			const shell = shellProcesses();
			const inFlightCount = liveCount();
			const busy = inFlightCount > 0 || viewerCount > 0 || shell > 0;
			return { idleMs: busy ? 0 : now() - lastActivityAt, busy, inFlight: inFlightCount, viewers: viewerCount, shellProcesses: shell };
		},
	};
}
