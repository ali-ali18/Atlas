import { Queue } from "bullmq";
import { propagateRequestId } from "./request-id.js";
import type { Redis } from "ioredis";
import {
	ATLAS_JOB_NAMES,
	ATLAS_QUEUE_NAMES,
	type AttachmentExtractJobPayload,
	type AttachmentExtractJobResult,
	type ChatCompletionJobPayload,
	type ConnectorGuideJobPayload,
	type ConnectorGuideJobResult,
	type ConnectorLessonJobPayload,
	type ConnectorLessonJobResult,
	type LessonReviewJobPayload,
	type LessonReviewJobResult,
	type ChatCompletionJobResult,
	type MemoryCleanupJobPayload,
	type MemoryCleanupJobResult,
	type MemoryReviewJobPayload,
	type MemoryReviewJobResult,
	type SkillReviewJobPayload,
	type SkillReviewJobResult,
	type SummaryJobPayload,
	type SummaryJobResult,
} from "@workspace/shared";

export const CHAT_QUEUE_NAME = ATLAS_QUEUE_NAMES.chat;

export type ChatCompletionQueue = Queue<
	ChatCompletionJobPayload | MemoryReviewJobPayload | MemoryCleanupJobPayload | SummaryJobPayload | AttachmentExtractJobPayload | ConnectorGuideJobPayload | ConnectorLessonJobPayload | LessonReviewJobPayload | SkillReviewJobPayload,
	ChatCompletionJobResult | MemoryReviewJobResult | MemoryCleanupJobResult | SummaryJobResult | AttachmentExtractJobResult | ConnectorGuideJobResult | ConnectorLessonJobResult | LessonReviewJobResult | SkillReviewJobResult,
	| typeof ATLAS_JOB_NAMES.chatCompletion
	| typeof ATLAS_JOB_NAMES.memoryReview
	| typeof ATLAS_JOB_NAMES.memoryCleanup
	| typeof ATLAS_JOB_NAMES.summaryWrite
	| typeof ATLAS_JOB_NAMES.attachmentExtract
	| typeof ATLAS_JOB_NAMES.connectorGuide
	| typeof ATLAS_JOB_NAMES.connectorLesson
	| typeof ATLAS_JOB_NAMES.lessonReview
	| typeof ATLAS_JOB_NAMES.skillReview
>;

export function createChatCompletionQueue(
	connection: Redis,
): ChatCompletionQueue {
	return propagateRequestId(new Queue<
		ChatCompletionJobPayload | MemoryReviewJobPayload | MemoryCleanupJobPayload | SummaryJobPayload | AttachmentExtractJobPayload | ConnectorGuideJobPayload | ConnectorLessonJobPayload | LessonReviewJobPayload | SkillReviewJobPayload,
		ChatCompletionJobResult | MemoryReviewJobResult | MemoryCleanupJobResult | SummaryJobResult | AttachmentExtractJobResult | ConnectorGuideJobResult | ConnectorLessonJobResult | LessonReviewJobResult | SkillReviewJobResult,
		| typeof ATLAS_JOB_NAMES.chatCompletion
		| typeof ATLAS_JOB_NAMES.memoryReview
	| typeof ATLAS_JOB_NAMES.memoryCleanup
		| typeof ATLAS_JOB_NAMES.summaryWrite
	| typeof ATLAS_JOB_NAMES.attachmentExtract
	| typeof ATLAS_JOB_NAMES.connectorGuide
	| typeof ATLAS_JOB_NAMES.connectorLesson
	| typeof ATLAS_JOB_NAMES.lessonReview
	| typeof ATLAS_JOB_NAMES.skillReview
	>(CHAT_QUEUE_NAME, {
		connection,
		defaultJobOptions: {
			removeOnComplete: 100,
			removeOnFail: 200,
			attempts: 3,
			backoff: { type: "exponential", delay: 1000 },
		},
	}));
}
