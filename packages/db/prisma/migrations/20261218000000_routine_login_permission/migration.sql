-- Rotinas v4 (F9 parte 2): permissão de login da rotina, aprovada pelo dono ao criar ou editar ({ login, site, approvedAt }).
-- No run da rotina (sem dono) o login_fill só existe para esse login e esse site. Só ADD COLUMN, nula: código antigo ignora a coluna.
-- Rollback seguro: DROP COLUMN.
ALTER TABLE "routines" ADD COLUMN "loginPermissionJson" JSONB;
