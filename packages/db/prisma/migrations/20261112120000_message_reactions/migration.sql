-- Reações a mensagens: uma por ator (usuário ou bot) e mensagem.
CREATE TABLE "message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_reactions_messageId_actorKind_actorId_key" ON "message_reactions"("messageId", "actorKind", "actorId");
CREATE INDEX "message_reactions_messageId_idx" ON "message_reactions"("messageId");

ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hub em tempo real: reação criada, trocada ou removida avisa as outras abas/aparelhos como evento 'message'
-- (op 'reaction'); o cliente busca as reações da mensagem. Bot reagindo a uma mensagem nova também passa por aqui.
CREATE OR REPLACE FUNCTION atlas_evt_message_reaction() RETURNS TRIGGER AS $$
DECLARE
    v_message TEXT;
    v_conversation TEXT;
    v_user TEXT;
BEGIN
    BEGIN
        v_message := CASE WHEN TG_OP = 'DELETE' THEN OLD."messageId" ELSE NEW."messageId" END;
        SELECT "conversationId" INTO v_conversation FROM conversation_messages WHERE id = v_message;
        IF v_conversation IS NOT NULL THEN
            v_user := atlas_conversation_owner(v_conversation);
            IF v_user IS NOT NULL THEN
                PERFORM atlas_publish_user_event(v_user, 'message', jsonb_build_object(
                    'conversationId', v_conversation,
                    'messageId', v_message,
                    'role', 'reaction',
                    'op', 'reaction'
                ));
            END IF;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'atlas_evt_message_reaction: %', SQLERRM;
    END;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER atlas_evt_message_reaction
    AFTER INSERT OR UPDATE OR DELETE ON message_reactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION atlas_evt_message_reaction();
