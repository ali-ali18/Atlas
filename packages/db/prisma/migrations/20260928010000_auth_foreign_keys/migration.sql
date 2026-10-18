-- Fase 1 (auth), 2ª etapa: FK de User nas 7 tabelas que a migração
-- 20260927010000_auth_foundation deixou de fora (memory_entries, agent_runs,
-- skills, skill_learning_jobs, skill_pending_intents, routines,
-- mcp_connections). Essas colunas "userId" são NOT NULL e ainda têm linhas
-- legadas com userId="default" (string solta, não é id de User) até o dono
-- logar pela 1ª vez e rodar `pnpm --filter @workspace/db migrate:claim-default`.
--
-- Sequenciamento: o serviço `migrate` do docker-compose roda
-- `prisma migrate deploy` (todas as migrações pendentes, sem parar pra
-- intervenção manual) em todo `docker compose up` — não dá pra exigir que o
-- claim-default rode ENTRE duas migrações, e claim-default não pode rodar
-- sozinho antes do deploy (precisa do id de um usuário já autenticado, que só
-- existe depois do 1º login via Better Auth).
--
-- Por isso a FK entra com NOT VALID: a constraint passa a valer pra todo
-- INSERT/UPDATE novo imediatamente (nenhum código novo consegue mais gravar
-- um userId que não seja um User real), mas não escaneia/valida as linhas já
-- existentes — então esta migração nunca falha por causa do dado legado e
-- pode ser aplicada em qualquer deploy, sem coordenação manual.
-- `claim-default.mjs` fecha o ciclo: depois de reatribuir as linhas
-- "default" pro dono, ele mesmo roda `VALIDATE CONSTRAINT` pras 7
-- constraints abaixo (fora da transação de backfill, já com os dados
-- commitados) — nenhuma segunda passada de migração é necessária.
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "skills" ADD CONSTRAINT "skills_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "skill_learning_jobs" ADD CONSTRAINT "skill_learning_jobs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "skill_pending_intents" ADD CONSTRAINT "skill_pending_intents_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "routines" ADD CONSTRAINT "routines_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
