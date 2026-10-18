import type { DevEgressPolicy, DevTier } from "@workspace/sandbox";
import { DEV_APPROVAL_MODE_LABEL, type DevApprovalMode } from "@workspace/shared";
import { buildEgressAllowlist, DEV_ENV_NETWORK_LABEL, DEV_ENV_TIER_LABEL, normalizeEnvRepo } from "@workspace/shared";

/**
 * Ambiente de código de um repositório, já aberto para uso pelo runtime da
 * sessão: comandos, recursos, política de internet e segredos (valores só aqui
 * no servidor; nunca em evento, resultado de tool ou resposta de API).
 */
export type DevEnvironmentRuntime = {
	id: string;
	repo: string;
	installCommand: string | null;
	startCommand: string | null;
	/** Comando de teste rápido definido para o ambiente (opcional). */
	testCommand?: string | null;
	tier: DevTier;
	network: "allowlist" | "full" | "off";
	/** Domínios do usuário (somados à lista padrão). */
	allowlist: string[];
	secrets: Record<string, string>;
	/** `null`/ausente = padrão da conta. */
	approvalMode?: DevApprovalMode | null;
	/** Prefixos liberados no modo "Lista liberada" (ausente = padrões). */
	commandAllowlist?: string[];
	/** `auto` = detectado/aprendido pelo agente. */
	source?: "manual" | "auto";
	/** Campos que o usuário editou (o agente não sobrescreve). */
	userEditedFields?: string[];
};

/**
 * Política de internet do container em cada fase. `off` = "sem internet após a
 * preparação": na preparação (clone, instalação) vale a lista liberada; depois, nada.
 */
export function egressPolicyFor(env: Pick<DevEnvironmentRuntime, "network" | "allowlist">, phase: "setup" | "run"): DevEgressPolicy {
	if (env.network === "full") return { mode: "full", allowlist: [] };
	if (env.network === "off" && phase === "run") return { mode: "off", allowlist: [] };
	return { mode: "allowlist", allowlist: buildEgressAllowlist(env.allowlist) };
}

/** Script do passo de instalação: pula se o mesmo comando já rodou com sucesso neste workspace. */
export const INSTALL_SCRIPT = [
	'cd "$DEV_REPO_DIR" || exit 1',
	"mkdir -p /workspace/.dev-env",
	'MARK="/workspace/.dev-env/$DEV_REPO_NAME.install"',
	'HASH=$(printf "%s" "$DEV_INSTALL_CMD" | sha256sum | cut -c1-16)',
	'if [ -f "$MARK" ] && [ "$(cat "$MARK")" = "$HASH" ]; then echo "(instalação já feita para este comando)"; exit 0; fi',
	'bash -c "$DEV_INSTALL_CMD" && echo "$HASH" > "$MARK"',
].join("\n");

/** Já há um comando de inicialização vivo? (exit 0 = sim) */
export const START_RUNNING_CHECK = 'test -f /tmp/.dev-start.pid && kill -0 "$(cat /tmp/.dev-start.pid)" 2>/dev/null';

/** Inicia o comando em segundo plano guardando o PID para não duplicar. */
export const START_SCRIPT = 'echo $$ > /tmp/.dev-start.pid\ncd "$DEV_REPO_DIR" || exit 1\nexec bash -c "$DEV_START_CMD"';

export function parseEnvironmentGetArgs(args: Record<string, unknown>): { repo?: string } {
	if (args.repo === undefined || args.repo === null || args.repo === "") return {};
	const repo = normalizeEnvRepo(args.repo);
	if (!repo) throw new Error("repo inválido: use owner/nome");
	return { repo };
}

/** Texto para o modelo: comandos e regras do ambiente. Só NOMES dos segredos. */
export function formatEnvironment(repo: string, env: DevEnvironmentRuntime | null): string {
	if (!env) {
		return [
			`Ainda não há ambiente para ${repo} (ele é criado automaticamente quando a sessão clona o repositório).`,
			"Descubra os comandos de instalação e de teste lendo o README e o package.json (ou equivalente).",
			"Quando descobrir os comandos certos, grave-os com dev_environment_update; para segredos use request_secrets; mais memória: dev_environment_update com tier.",
		].join("\n");
	}
	const names = Object.keys(env.secrets);
	const lines = [
		`Ambiente de ${env.repo}${env.source === "auto" ? " (detectado automaticamente)" : ""}:`,
		`- Instalação: ${env.installCommand ? env.installCommand : "(nenhuma; descubra pelo README)"}`,
		`- Inicialização: ${env.startCommand ? env.startCommand : "(nenhuma)"}`,
		`- Teste rápido: ${env.testCommand ? `${env.testCommand} (prefira este comando para testar; não rode a suíte inteira do monorepo)` : "(nenhum; rode só os testes dos pacotes que você mudou)"}`,
		`- Recursos: ${DEV_ENV_TIER_LABEL[env.tier]}`,
		`- Internet: ${DEV_ENV_NETWORK_LABEL[env.network]}`,
	];
	if (env.network === "allowlist") lines.push(`- Domínios liberados: ${buildEgressAllowlist(env.allowlist).join(", ")}`);
	if (env.network === "off") lines.push("- Depois da preparação a internet fica desligada: instale tudo que precisar durante a instalação.");
	if (env.approvalMode) lines.push(`- Aprovação de comandos: ${DEV_APPROVAL_MODE_LABEL[env.approvalMode]}${env.approvalMode === "auto" ? " (comandos rodam sem perguntar; só ações que saem do ambiente ou não têm volta pedem aprovação num card)" : " (comandos fora da lista liberada ou escritas pedem aprovação do usuário num card; espere a decisão)"}`);
	lines.push(`- Segredos disponíveis como variáveis de ambiente nos comandos: ${names.length ? names.join(", ") : "(nenhum)"}`);
	lines.push("Acesso bloqueado pelo proxy aparece como 403 'Bloqueado pelo proxy de saída'; peça ao usuário para liberar o domínio no ambiente.");
	return lines.join("\n");
}
