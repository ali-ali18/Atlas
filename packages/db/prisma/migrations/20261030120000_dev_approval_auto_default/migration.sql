-- O padrao da aprovacao de comandos das sessoes de codigo passou de "allowlist" (Lista liberada) para "auto"
-- (Automatico). NULL significa "herdar o padrao", entao quem tinha "allowlist" salvo passa a seguir o novo
-- padrao. Valores "ask" e "auto" ficam como estao. Nao mexe em commandAllowlist (a lista continua salva).
UPDATE "dev_environments" SET "approvalMode" = NULL WHERE "approvalMode" = 'allowlist';
UPDATE "user_settings" SET "devApprovalMode" = NULL WHERE "devApprovalMode" = 'allowlist';
