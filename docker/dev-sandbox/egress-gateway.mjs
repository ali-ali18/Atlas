import { startGateway } from "./server/egress-gateway.mjs";

// Entrypoint do container do gateway de saída (mesma imagem do dev-sandbox):
//   docker run ... atlas-dev-sandbox node /app/egress-gateway.mjs
const token = process.env.EGRESS_CONTROL_TOKEN ?? "";
if (!token) {
	console.error("EGRESS_CONTROL_TOKEN ausente: recusando iniciar sem autenticação.");
	process.exit(1);
}
process.on("uncaughtException", (error) => console.error("erro não tratado:", error?.message ?? error));
const proxyPort = Number.parseInt(process.env.EGRESS_PROXY_PORT ?? "3128", 10);
const controlPort = Number.parseInt(process.env.EGRESS_CONTROL_PORT ?? "3129", 10);
await startGateway({ token, proxyPort, controlPort });
console.log(`egress-gateway: proxy ${proxyPort}, controle ${controlPort}`);
