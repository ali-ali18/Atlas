-- Estado das tarefas de manutenção em segundo plano (último sucesso/erro por tipo), para o Diagnóstico.
ALTER TABLE "user_settings" ADD COLUMN "maintenanceStatusJson" JSONB;
