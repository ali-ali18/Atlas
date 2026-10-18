import { Hono } from "hono";
import type { RoutineQueue } from "@workspace/queue";
import { forgetInstallationTokens, loadGithubAppCredentials } from "@workspace/agent-runtime";
import {
	claimGithubAppDelivery,
	deleteGithubInstallationByInstallationId,
	getGithubInstallationByInstallationId,
	releaseGithubAppDelivery,
	updateGithubInstallationByInstallationId,
	type GithubInstallationRecord,
	type GithubInstallationRepo,
} from "@workspace/db";
import { verifyGithubSignature } from "./dispatch.js";
import {
	DEFAULT_GITHUB_HOOK_ROUTE_DEPS,
	githubPayloadRepo,
	routeGithubEvent,
	type GithubHookRouteDeps,
} from "./github.js";

/** Payload do GitHub App pode ser grande (push com muitos commits); 5 MB cobre com folga. */
const MAX_BODY_BYTES = 5 * 1_048_576;

type GithubAppWebhookDeps = {
	loadSecret: () => Promise<string | undefined>;
	claimDelivery: (deliveryId: string) => Promise<boolean>;
	releaseDelivery: (deliveryId: string) => Promise<void>;
	getInstallation: (installationId: string) => Promise<GithubInstallationRecord | null>;
	updateInstallation: typeof updateGithubInstallationByInstallationId;
	deleteInstallation: (installationId: string) => Promise<boolean>;
	forgetTokens: (installationId: string) => void;
	/** Dependências do pipeline de rotinas GitHub (mesmo do webhook por-repo). */
	routine: GithubHookRouteDeps;
};

export const DEFAULT_GITHUB_APP_WEBHOOK_DEPS: GithubAppWebhookDeps = {
	loadSecret: async () => (await loadGithubAppCredentials())?.webhookSecret,
	claimDelivery: claimGithubAppDelivery,
	releaseDelivery: releaseGithubAppDelivery,
	getInstallation: getGithubInstallationByInstallationId,
	updateInstallation: updateGithubInstallationByInstallationId,
	deleteInstallation: deleteGithubInstallationByInstallationId,
	forgetTokens: forgetInstallationTokens,
	routine: DEFAULT_GITHUB_HOOK_ROUTE_DEPS,
};

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function repoList(raw: unknown): GithubInstallationRepo[] {
	const out: GithubInstallationRepo[] = [];
	for (const item of Array.isArray(raw) ? raw : []) {
		const r = rec(item);
		if (typeof r.full_name === "string") out.push({ fullName: r.full_name, private: r.private === true });
	}
	return out;
}

/** Aplica `installation`/`installation_repositories` à instalação já vinculada (ignora as desconhecidas). */
export async function applyInstallationEvent(
	deps: Pick<GithubAppWebhookDeps, "getInstallation" | "updateInstallation" | "deleteInstallation" | "forgetTokens">,
	githubEvent: string,
	body: Record<string, unknown>,
): Promise<{ handled: boolean }> {
	const id = rec(body.installation).id;
	if (typeof id !== "number" && typeof id !== "string") return { handled: false };
	const installationId = String(id);
	const inst = await deps.getInstallation(installationId);
	if (!inst) return { handled: false };
	const action = typeof body.action === "string" ? body.action : "";

	if (githubEvent === "installation") {
		if (action === "deleted") {
			await deps.deleteInstallation(installationId);
			deps.forgetTokens(installationId);
		} else if (action === "suspend") {
			await deps.updateInstallation(installationId, { suspendedAt: new Date() });
			deps.forgetTokens(installationId);
		} else if (action === "unsuspend") {
			await deps.updateInstallation(installationId, { suspendedAt: null });
		}
		return { handled: true };
	}

	if (githubEvent === "installation_repositories") {
		const selection = body.repository_selection === "all" ? "all" : "selected";
		if (selection === "all") {
			await deps.updateInstallation(installationId, { repositorySelection: "all", repositories: null });
			return { handled: true };
		}
		const removed = new Set(repoList(body.repositories_removed).map((r) => r.fullName.toLowerCase()));
		const merged = new Map<string, GithubInstallationRepo>();
		for (const r of inst.repositories ?? []) if (!removed.has(r.fullName.toLowerCase())) merged.set(r.fullName.toLowerCase(), r);
		for (const r of repoList(body.repositories_added)) merged.set(r.fullName.toLowerCase(), r);
		await deps.updateInstallation(installationId, { repositorySelection: "selected", repositories: Array.from(merged.values()) });
		deps.forgetTokens(installationId);
		return { handled: true };
	}
	return { handled: false };
}

/**
 * Webhook ÚNICO do GitHub App (`POST /v1/github-app/webhook`). Público (sem sessão): autentica pela
 * assinatura HMAC (`X-Hub-Signature-256`) com o secret do app, ANTES de qualquer efeito. Dedupe por
 * `X-GitHub-Delivery`. O dono das rotinas vem da instalação vinculada, nunca do payload.
 */
export function createGithubAppWebhookRoutes(
	routineQueue: RoutineQueue | null,
	deps: GithubAppWebhookDeps = DEFAULT_GITHUB_APP_WEBHOOK_DEPS,
) {
	const app = new Hono();

	app.post("/v1/github-app/webhook", async (c) => {
		const githubEvent = c.req.header("X-GitHub-Event")?.trim();
		if (!githubEvent) return c.json({ error: "Missing X-GitHub-Event" }, 400);

		const secret = await deps.loadSecret();
		if (!secret) return c.json({ error: "GitHub App não configurado" }, 503);

		const rawBody = await c.req.text();
		if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return c.json({ error: "Payload too large" }, 413);
		if (!verifyGithubSignature(secret, rawBody, c.req.header("X-Hub-Signature-256"))) {
			return c.json({ error: "Unauthorized" }, 401);
		}
		if (githubEvent === "ping") return c.json({ ok: true }, 200);

		let payload: unknown;
		try {
			payload = rawBody.trim() ? JSON.parse(rawBody) : {};
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}
		if (!payload || typeof payload !== "object") return c.json({ error: "Invalid JSON body" }, 400);
		const body = payload as Record<string, unknown>;

		const deliveryId = c.req.header("X-GitHub-Delivery")?.trim() || undefined;
		if (deliveryId && !(await deps.claimDelivery(deliveryId))) {
			return c.json({ ok: true, duplicate: true }, 200);
		}

		try {
			if (githubEvent === "installation" || githubEvent === "installation_repositories") {
				await applyInstallationEvent(deps, githubEvent, body);
				return c.json({ ok: true }, 200);
			}

			if (!routineQueue) {
				if (deliveryId) await deps.releaseDelivery(deliveryId);
				return c.json({ error: "Fila de rotinas indisponível" }, 503);
			}
			const installationRaw = rec(body.installation).id;
			if (typeof installationRaw !== "number" && typeof installationRaw !== "string") {
				return c.json({ ok: true, ignored: true }, 202);
			}
			const inst = await deps.getInstallation(String(installationRaw));
			if (!inst || inst.suspendedAt) return c.json({ ok: true, ignored: true }, 202);
			const repo = githubPayloadRepo(body);
			if (!repo) return c.json({ ok: true, ignored: true }, 202);

			// Só as rotinas do dono da instalação (nunca de outro usuário, mesmo no mesmo repo).
			const matches = (await deps.routine.matchGithubHookRoutines(repo)).filter(
				(match) => match.routine.userId === inst.userId,
			);
			const result = await routeGithubEvent({
				routineQueue,
				deps: deps.routine,
				githubEvent,
				deliveryId,
				body,
				rawBody,
				repo,
				matches,
			});
			if (result.status === 503 && deliveryId) await deps.releaseDelivery(deliveryId);
			return c.json(result.body, result.status);
		} catch (error) {
			if (deliveryId) await deps.releaseDelivery(deliveryId).catch(() => undefined);
			console.error("[github-app] webhook falhou", error instanceof Error ? error.message : "erro");
			return c.json({ error: "Webhook failed" }, 500);
		}
	});

	return app;
}
