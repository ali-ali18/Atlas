# Notificações no app mobile (anotado, não iniciado)

Status: **planejado**. Nada implementado. Decisão do dono (04/11/2026): só anotar e fazer depois.

## O que é
Notificação no Android (e iOS) quando o bot responde, uma rotina ou alerta dispara ou falha, como o web já faz pelo Web Push.
Visual de referência: estilo conversa do Android, com avatar do bot, ícone do Atlas pequeno no canto, título "Grupo · Bot"
e o texto. Ao tocar, abre a conversa e marca como lida.

## O que já existe (web)
- Servidor: `apps/api/src/routes/push.ts` (config VAPID, inscrições por aparelho, teste, presença "estou olhando").
- Banco: `packages/db/src/push.ts` (inscrições, coalescência, presença por Redis).
- Envio: `packages/mail/src/push.ts` (`web-push`).
- Quem dispara: `apps/worker/src/processors/agent-run.ts`, `routine.ts`, `routine-failure.ts`, `routine-alert.ts`.
- Web: `apps/web/hooks/use-push-notifications.ts`, `apps/web/lib/push-client.ts`, `apps/web/public/sw.js`.

## Por que Firebase (FCM)
No Android, notificação com o app fechado só chega pelo FCM do Google (o serviço de push do Expo também passa por ele).
FCM é gratuito e sem limite de mensagens. Plano Spark do Firebase, sem cartão. Não usar outros serviços pagos do Firebase.

## Plano
1. **Firebase (dono):** criar projeto no plano Spark, app Android `com.<pacote do app.json>`, baixar `google-services.json`
   e subir a chave de conta de serviço do FCM V1 no EAS (credenciais do projeto).
2. **Servidor (PR separado, com ok do dono):**
   - aceitar inscrição do tipo "expo" (token do aparelho) na mesma lista de aparelhos, ao lado das do Web Push;
   - segundo remetente (Expo Push API ou FCM HTTP v1 direto) usado pelos mesmos gatilhos, presença e coalescência;
   - payload com `conversationId`, `botId`, nome e avatar do bot, nome do grupo;
   - remover token inválido (DeviceNotRegistered), como já faz com endpoint web que falha;
   - teste de escopo: usuário B não lista nem apaga aparelho do A.
3. **App (precisa de APK novo):**
   - `expo-notifications` (permissão, token, toque abre `/chat/<id>`);
   - estilo conversa com avatar (MessagingStyle): `expo-notifications` não faz avatar sobreposto, avaliar Notifee;
   - ao abrir a conversa, marcar como lida (já existe `markConversationRead`) e limpar a notificação dela;
   - avisar o servidor de "estou olhando" (presença) como o web.
4. Mudar `runtimeVersion` para a policy `fingerprint` antes, para OTA nunca chegar num APK sem o módulo nativo.

## Pendência do servidor achada junto (anexos)
`apps/api/src/middleware/json-body-limit.ts` não isenta `/v1/uploads/files`: arquivo (não imagem) acima de 1 MiB volta 413
"JSON body exceeds 1 MiB", no web e no app. Correção: incluir `/v1/uploads/files` na isenção (a rota já tem o teto de 20 MB)
e um teste em `uploads-limits.test.ts`.
