import { createHash } from "node:crypto";
import { SANDBOX_HOME } from "./shell.js";

/** Onde o login do Claude Code (`~/.claude`) é montado, na VM do bot e (próximo PR) no dev-sandbox. */
export const CLAUDE_LOGIN_MOUNT = `${SANDBOX_HOME}/.claude`;

/**
 * Volume Docker dedicado ao login do Claude Code de UM bot (ADR 0006, opção C).
 * Separado do home da VM e do perfil do Chrome: só o binário oficial do Claude Code escreve e lê aqui.
 * O Atlas NUNCA lê o conteúdo (nem `docker cp`, nem `cat`): só monta o volume e o apaga junto do bot.
 * A chave tem o dono e o bot, com um rótulo próprio para não colidir com `atlas-home-*`/`atlas-work-*`:
 * outro usuário, mesmo com o mesmo botId, cai em outro volume (escopo por dono).
 */
export function claudeLoginVolumeName(botId: string, userId: string): string {
	if (!botId || !userId) throw new Error("claudeLoginVolumeName: botId and userId are required");
	const key = createHash("sha256").update(JSON.stringify(["claude-login", userId, botId])).digest("hex");
	return `atlas-claude-${key}`;
}

/** Bind do volume de login para `HostConfig.Binds`. Leitura e escrita: quem faz o `claude auth login` grava aqui. */
export function claudeLoginBind(botId: string, userId: string): string {
	return `${claudeLoginVolumeName(botId, userId)}:${CLAUDE_LOGIN_MOUNT}`;
}
