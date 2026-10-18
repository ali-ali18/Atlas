import type { AtlasQueueName } from "./queues.js";

/** Nomes de jobs BullMQ. */
export const ATLAS_JOB_NAMES = {
	chatCompletion: "chat.completion",
	memoryReview: "memory.review",
	summaryWrite: "summary.write",
	runAgent: "run-agent",
	executeRoutine: "execute-routine",
	embedMemory: "embed-memory",
	learnSkill: "skill.learn",
	attachmentExtract: "attachment.extract",
} as const;

export type AtlasJobName =
	(typeof ATLAS_JOB_NAMES)[keyof typeof ATLAS_JOB_NAMES];

export type AtlasJobDescriptor = {
	queue: AtlasQueueName;
	name: AtlasJobName;
};
