export { loadSandboxConfig, type SandboxRuntimeConfig } from "./config.js";
export {
	createSandboxManager,
	type SandboxManager,
	profileVolumeName,
	SandboxDockerUnavailableError,
	SandboxControlError,
} from "./docker-manager.js";
export { startSandboxReaper } from "./reaper.js";
export type { ControlActivity } from "./control-client.js";
export { pickVmsToStop, loadMemoryGuardLimits, type RunningVm } from "./memory-guard.js";
export type {
	ControlActionEffect,
	ControlPageChanges,
	ControlPointer,
	ControlActionResult,
	ControlBrowserClickResult,
	ControlBrowserLinksResult,
	ControlBrowserTextOptions,
	ControlBrowserTextResult,
	ControlScrollResult,
	ControlActParams,
	ControlActResult,
	ControlActAction,
	ControlFindMatch,
	ControlFindOptions,
	ControlFindResult,
	ControlReadOptions,
	ControlReadResult,
	ControlSnapshotOptions,
	ControlSnapshotResult,
	ControlWaitParams,
	ControlWaitResult,
	SandboxSessionRecord,
} from "./types.js";

export { runSandboxOperation, assertSandboxExecution, SandboxExecutionAbortedError, SandboxOperationTimeoutError, type SandboxExecutionContext } from "./execution-context.js";

export { workVolumeName, sandboxBinds } from "./docker-manager.js";
export {
	runShell,
	waitShell,
	readSandboxFile,
	listSandboxDir,
	downloadToSandbox,
	writeSandboxFile,
	truncateOutput,
	resolveSandboxPath,
	SandboxShellError,
	SANDBOX_WORK_DIR,
	type ShellExecutor,
} from "./shell.js";
export type {
	SandboxShellResult,
	SandboxShellWaitResult,
	SandboxReadResult,
	SandboxListResult,
	SandboxListEntry,
	SandboxDownloadResult,
	SandboxWriteFileResult,
} from "./types.js";

export {
	DEV_TIERS,
	DEV_TIER_NAMES,
	isDevTier,
	minDevTier,
	loadDevSandboxConfig,
	type DevSandboxConfig,
	type DevTier,
} from "./dev/config.js";
export {
	computeEnvCacheKey,
	decideEnvCache,
	ENV_CACHE_LABEL,
	ENV_CACHE_MOUNT,
	envCacheId,
	envCacheVolumeName,
	hashEnvVars,
	parseEnvCacheMeta,
	selectEnvCacheEvictions,
	type EnvCacheAction,
	type EnvCacheDecision,
	type EnvCacheEntry,
	type EnvCacheMeta,
	type EnvCacheParts,
} from "./dev/env-cache.js";
export { CALLBACK_MAX_SKEW_MS, signDevCallback, verifyDevCallback, type VerifyCallbackInput } from "./dev/callback.js";
export { decideAdmission, type AdmissionDecision, type AdmissionDenied, type AdmissionInput } from "./dev/admission.js";
export type {
	DevContainerInfo,
	DevEndpoint,
	DevEnsureInput,
	DevEnsureResult,
	DevSandboxProvider,
} from "./dev/provider.js";
export {
	buildDevContainerSpec,
	createDockerDevProvider,
	devCacheVolumeName,
	devContainerName,
	devWorkspaceVolumeName,
	egressEnv,
	resolveDevEndpoint,
	DEV_CONTAINER_PORT,
} from "./dev/docker-provider.js";
export {
	createDevClient,
	DevSandboxError,
	type DevClient,
	type DevEgressPolicy,
	type DevExecSnapshot,
	type DevExecStartInput,
	type DevGrepResult,
	type DevListResult,
	type DevPatchResult,
	type DevReadResult,
	type DevWriteResult,
} from "./dev/client.js";
export {
	retryQueuedDevSessionsOnce,
	startDevSessionQueue,
	resetDevQueueState,
	nextQueueDelay,
	type DevQueueOptions,
	type DevQueuedSession,
	type DevQueueStore,
} from "./dev/queue.js";
export {
	reapDevSessionsOnce,
	startDevSessionReaper,
	startDevEnvCacheSweep,
	sweepEnvCachesOnce,
	DEV_CACHE_SWEEP_INTERVAL_MS,
	type DevReaperOptions,
	type DevReaperSession,
	type DevReaperStore,
	type DevReapResult,
} from "./dev/reaper.js";

export * from "./code-runner/index.js";
