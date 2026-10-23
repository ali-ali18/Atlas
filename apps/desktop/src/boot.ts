// Página local: confere se o Atlas está no ar e troca a janela para ele; senão mostra o estado offline.
// Não usa IPC do Tauri (a janela não tem permissões de comando): tudo vem pela query string.
import { offlineMessage, parseBootParams, probe, retryDelayMs } from "./connect.js";

const PROBE_TIMEOUT_MS = 8_000;

function el<T extends HTMLElement>(id: string): T {
	const found = document.getElementById(id);
	if (!found) throw new Error(`elemento #${id} ausente`);
	return found as T;
}

const splash = el<HTMLElement>("splash");
const offline = el<HTMLElement>("offline");
const reasonText = el<HTMLElement>("offline-reason");
const urlText = el<HTMLElement>("offline-url");
const countdownText = el<HTMLElement>("offline-countdown");
const retryButton = el<HTMLButtonElement>("retry");
const settingsHint = el<HTMLElement>("settings-hint");
const settingsPathText = el<HTMLElement>("settings-path");

const params = parseBootParams(window.location.search);
let attempt = 0;
let countdownTimer: number | undefined;

if (params.settingsPath) {
	settingsPathText.textContent = params.settingsPath;
	settingsHint.hidden = false;
}

function showSplash(): void {
	offline.hidden = true;
	splash.hidden = false;
}

function showOffline(reason: "timeout" | "network" | "invalid-url"): void {
	splash.hidden = true;
	offline.hidden = false;
	reasonText.textContent = offlineMessage(reason);
	urlText.textContent = params.target ?? "(não configurado)";
	retryButton.disabled = reason === "invalid-url";
	if (reason !== "invalid-url") scheduleRetry();
	retryButton.focus();
}

function scheduleRetry(): void {
	window.clearInterval(countdownTimer);
	let remaining = Math.round(retryDelayMs(attempt) / 1000);
	countdownText.textContent = `Tentando de novo em ${remaining}s…`;
	countdownTimer = window.setInterval(() => {
		remaining -= 1;
		if (remaining <= 0) {
			void connect();
			return;
		}
		countdownText.textContent = `Tentando de novo em ${remaining}s…`;
	}, 1000);
}

async function connect(): Promise<void> {
	window.clearInterval(countdownTimer);
	countdownText.textContent = "";
	if (!params.target) {
		showOffline("invalid-url");
		return;
	}
	showSplash();
	const result = await probe(params.target, (input, init) => fetch(input, init), PROBE_TIMEOUT_MS);
	if (result.ok) {
		window.location.replace(params.target);
		return;
	}
	attempt += 1;
	showOffline(result.reason);
}

retryButton.addEventListener("click", () => {
	attempt = 0;
	void connect();
});
window.addEventListener("online", () => {
	if (!offline.hidden) void connect();
});

void connect();
