-- Um run ativo por conversa. Corridas de POST não duplicam o job.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_conversation
ON agent_runs ("conversationId")
WHERE "conversationId" IS NOT NULL
  AND status IN (
    'queued',
    'running',
    'retrying',
    'paused',
    'waiting_user',
    'waiting_external'
  );
