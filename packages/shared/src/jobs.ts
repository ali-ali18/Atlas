import type { AtlasQueueName } from "./queues.js";

/** Nomes de jobs BullMQ. */
export const ATLAS_JOB_NAMES = {
	chatCompletion: "chat.completion",
	memoryReview: "memory.review",
	memoryCleanup: "memory.cleanup",
	summaryWrite: "summary.write",
	runAgent: "run-agent",
	executeRoutine: "execute-routine",
	embedMemory: "embed-memory",
	learnSkill: "skill.learn",
	connectorGuide: "connector.guide",
	connectorLesson: "connector.lesson",
	attachmentExtract: "attachment.extract",
	lessonReview: "lesson.review",
	skillReview: "skill.review",
	/** Retenção diária (run_events antigos, execuções de rotina além das 50 mais recentes). */
	dataRetention: "maintenance.retention",
} as const;

/** Job diário de retenção: sem dados de entrada; devolve só contagens. */
export type DataRetentionJobPayload = Record<string, never>;
export type DataRetentionJobResult = { runEvents: number; routineRuns: number };

export type AtlasJobName =
	(typeof ATLAS_JOB_NAMES)[keyof typeof ATLAS_JOB_NAMES];

export type AtlasJobDescriptor = {
	queue: AtlasQueueName;
	name: AtlasJobName;
};
