-- Histórico de mudanças da memória (aba Memória: "O que mudou" + desfazer).
CREATE TABLE "memory_changes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT,
    "entryId" TEXT,
    "target" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "beforeMeta" JSONB,
    "source" TEXT NOT NULL,
    "undoOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "memory_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "memory_changes_userId_createdAt_idx" ON "memory_changes"("userId", "createdAt");
CREATE INDEX "memory_changes_userId_botId_createdAt_idx" ON "memory_changes"("userId", "botId", "createdAt");

ALTER TABLE "memory_changes" ADD CONSTRAINT "memory_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- Hub em tempo real: avisa a aba Memória (type 'memory') no commit de cada mudança, como os demais gatilhos.
CREATE OR REPLACE FUNCTION atlas_evt_memory_change() RETURNS TRIGGER AS $$
BEGIN
    BEGIN
        PERFORM atlas_publish_user_event(NEW."userId", 'memory', jsonb_build_object(
            'changeId', NEW.id,
            'botId', NEW."botId",
            'target', NEW.target,
            'action', NEW.action
        ));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_memory_change: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_memory_change_insert
    AFTER INSERT ON memory_changes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_memory_change();
