-- Hub em tempo real: avisa quem escuta (LISTEN atlas_user_events) que o usuário ganhou evento. A API acorda
-- só os streams `GET /v1/events` daquele usuário em vez de cada aba consultar o banco a cada 600 ms.
-- O NOTIFY sai no commit (nunca antes do dado) e repetições do mesmo usuário na transação viram uma só.
-- O payload é só o id do usuário: o conteúdo continua no banco, escopado pelo dono.
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
    PERFORM pg_notify('atlas_user_events', p_user);
    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;
