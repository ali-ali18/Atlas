-- Log de eventos por usuário (hub em tempo real).
-- `seq` por usuário, sem buracos e na ordem do commit: o contador é uma linha por usuário, travada até o fim
-- da transação do publicador. Os gatilhos são DEFERRED (rodam no commit), então a linha do contador só fica
-- travada no instante do commit (sem deadlock com travas de run/mensagem) e o evento só existe se a mudança existe.

-- CreateTable
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_event_counters" (
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,

    CONSTRAINT "user_event_counters_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_events_userId_seq_key" ON "user_events"("userId", "seq");

-- CreateIndex
CREATE INDEX "user_events_createdAt_idx" ON "user_events"("createdAt");

-- Publicador único (usado pelos gatilhos e por `publishUserEvent`). Devolve o seq, ou NULL sem usuário.
CREATE OR REPLACE FUNCTION atlas_publish_user_event(p_user TEXT, p_type TEXT, p_payload JSONB)
RETURNS INTEGER AS $$
DECLARE
    v_seq INTEGER;
BEGIN
    IF p_user IS NULL THEN
        RETURN NULL;
    END IF;
    INSERT INTO user_event_counters ("userId", seq) VALUES (p_user, 1)
    ON CONFLICT ("userId") DO UPDATE SET seq = user_event_counters.seq + 1
    RETURNING seq INTO v_seq;
    INSERT INTO user_events (id, "userId", seq, type, payload)
    VALUES (gen_random_uuid()::text, p_user, v_seq, p_type, COALESCE(p_payload, '{}'::jsonb));
    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;

-- Dono da conversa (conversa sem userId cai no dono do bot).
CREATE OR REPLACE FUNCTION atlas_conversation_owner(p_conversation TEXT)
RETURNS TEXT AS $$
    SELECT COALESCE(
        (SELECT "userId" FROM conversations WHERE id = p_conversation),
        (SELECT "ownerId" FROM bots WHERE "conversationId" = p_conversation LIMIT 1)
    );
$$ LANGUAGE sql STABLE;

-- Mensagens e cartões (criar ou mudar).
CREATE OR REPLACE FUNCTION atlas_evt_message() RETURNS TRIGGER AS $$
DECLARE
    v_user TEXT;
BEGIN
    BEGIN
        v_user := atlas_conversation_owner(NEW."conversationId");
        IF v_user IS NOT NULL THEN
            PERFORM atlas_publish_user_event(v_user, 'message', jsonb_build_object(
                'conversationId', NEW."conversationId",
                'messageId', NEW.id,
                'role', NEW.role,
                'op', lower(TG_OP)
            ));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_message: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_message
    AFTER INSERT OR UPDATE ON conversation_messages
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_message();

-- Runs: criado e cada mudança de status (o estado final é lido no commit).
CREATE OR REPLACE FUNCTION atlas_evt_run() RETURNS TRIGGER AS $$
DECLARE
    r RECORD;
BEGIN
    BEGIN
        SELECT "userId", "botId", "conversationId", status, origin, "parentRunId" INTO r
        FROM agent_runs WHERE id = NEW.id;
        IF FOUND THEN
            PERFORM atlas_publish_user_event(r."userId", 'run', jsonb_build_object(
                'runId', NEW.id,
                'conversationId', r."conversationId",
                'botId', r."botId",
                'status', r.status,
                'origin', r.origin,
                'parentRunId', r."parentRunId"
            ));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_run: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_run_insert
    AFTER INSERT ON agent_runs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_run();

CREATE CONSTRAINT TRIGGER atlas_evt_run_status
    AFTER UPDATE OF status ON agent_runs
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_run();

-- Estado de leitura (outro aparelho leu ou marcou como não lida).
CREATE OR REPLACE FUNCTION atlas_evt_read() RETURNS TRIGGER AS $$
BEGIN
    BEGIN
        PERFORM atlas_publish_user_event(NEW."userId", 'read', jsonb_build_object(
            'conversationId', NEW."conversationId",
            'manualUnread', NEW."manualUnread",
            'lastReadMessageId', NEW."lastReadMessageId"
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_read: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_read
    AFTER INSERT OR UPDATE ON conversation_reads
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_read();

-- Lista de bots (criar, editar, apagar).
CREATE OR REPLACE FUNCTION atlas_evt_bot() RETURNS TRIGGER AS $$
DECLARE
    v_owner TEXT;
    v_id TEXT;
    v_conversation TEXT;
BEGIN
    BEGIN
        IF TG_OP = 'DELETE' THEN
            v_owner := OLD."ownerId"; v_id := OLD.id; v_conversation := OLD."conversationId";
        ELSE
            v_owner := NEW."ownerId"; v_id := NEW.id; v_conversation := NEW."conversationId";
        END IF;
        PERFORM atlas_publish_user_event(v_owner, 'bot', jsonb_build_object(
            'botId', v_id,
            'conversationId', v_conversation,
            'op', lower(TG_OP)
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_bot: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_bot
    AFTER INSERT OR UPDATE OR DELETE ON bots
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_bot();

-- Sessões de código (estado, PR, erro).
CREATE OR REPLACE FUNCTION atlas_evt_dev_session() RETURNS TRIGGER AS $$
BEGIN
    BEGIN
        PERFORM atlas_publish_user_event(NEW."userId", 'dev-session', jsonb_build_object(
            'sessionId', NEW.id,
            'conversationId', NEW."conversationId",
            'status', NEW.status
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_dev_session: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_dev_session_insert
    AFTER INSERT ON dev_sessions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_dev_session();

CREATE CONSTRAINT TRIGGER atlas_evt_dev_session_update
    AFTER UPDATE OF status, "prState", "prNumber", "lastError" ON dev_sessions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_dev_session();

-- Reflexão do orquestrador.
CREATE OR REPLACE FUNCTION atlas_evt_reflection() RETURNS TRIGGER AS $$
BEGIN
    BEGIN
        PERFORM atlas_publish_user_event(NEW."userId", 'reflection', jsonb_build_object(
            'reflectionId', NEW.id,
            'botId', NEW."botId",
            'status', NEW.status
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_reflection: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_reflection_insert
    AFTER INSERT ON orchestrator_reflections
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_reflection();

CREATE CONSTRAINT TRIGGER atlas_evt_reflection_status
    AFTER UPDATE OF status ON orchestrator_reflections
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_reflection();
