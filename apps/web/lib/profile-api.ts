import { authClient } from "@/lib/auth-client";

export type ProfileResult = { id: string; name: string; email: string; image: string | null };

async function send(path: string, init: RequestInit): Promise<ProfileResult> {
	const response = await fetch(path, { ...init, credentials: "same-origin" });
	if (response.status === 401 && typeof window !== "undefined") window.location.replace("/login");
	if (!response.ok) {
		let message = "Não foi possível salvar. Tente novamente.";
		try {
			const body = (await response.json()) as { error?: unknown };
			if (typeof body.error === "string" && body.error) message = body.error;
		} catch {
			// corpo sem JSON: fica a mensagem padrão
		}
		throw new Error(message);
	}
	return (await response.json()) as ProfileResult;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Pede ao Better Auth a sessão de novo: nome e foto mudam no app inteiro sem recarregar. */
function refreshSession(): void {
	try {
		authClient.$store.notify("$sessionSignal");
	} catch {
		// sem store (teste/SSR): a sessão atualiza no próximo foco
	}
}

export async function saveProfileName(name: string): Promise<ProfileResult> {
	const result = await send("/v1/me", { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
	refreshSession();
	return result;
}

export async function saveProfileImage(image: string): Promise<ProfileResult> {
	const result = await send("/v1/me/image", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ image }) });
	refreshSession();
	return result;
}

export async function removeProfileImage(): Promise<ProfileResult> {
	const result = await send("/v1/me/image", { method: "DELETE" });
	refreshSession();
	return result;
}
