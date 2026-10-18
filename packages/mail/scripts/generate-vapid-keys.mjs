// Gera o par de chaves VAPID das notificações push.
// Uso: pnpm --filter @workspace/mail push:vapid
// Copie as três linhas para as variáveis de ambiente da API e do worker (Dokploy).
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`WEB_PUSH_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_PRIVATE_KEY=${privateKey}`);
console.log("WEB_PUSH_SUBJECT=mailto:voce@exemplo.com.br");
console.log("");
console.log("Guarde a chave privada como segredo. Trocar o par invalida as inscrições existentes.");
