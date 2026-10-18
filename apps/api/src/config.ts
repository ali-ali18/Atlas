import type { ChatCompletionQueue, AgentRunQueue, RoutineQueue } from "@workspace/queue";

const DEFAULT_PORT = 3001;
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

export type ApiConfig = {
	port: number;
	hostname: string;
	openRouterApiKey: string | undefined;
	openRouterModel: string;
	redisUrl: string;
	databaseUrl: string | undefined;
	chatQueue: ChatCompletionQueue | null;
	agentRunQueue: AgentRunQueue | null;
	routineQueue: RoutineQueue | null;
};

export function loadConfig(): Omit<
	ApiConfig,
	"chatQueue" | "agentRunQueue" | "routineQueue"
> {
	const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

	return {
		port: Number.isFinite(port) ? port : DEFAULT_PORT,
		hostname:
			process.env.HOST?.trim() ||
			(process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
		openRouterApiKey: process.env.OPENROUTER_API_KEY,
		openRouterModel:
			process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
		redisUrl: process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379",
		databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
	};
}
