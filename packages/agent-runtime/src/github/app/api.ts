// Movido para `@workspace/github`. Reexport para o legado.
export {
	convertManifestCode,
	createInstallationAccessToken,
	exchangeUserOAuthCode,
	fetchAppPermissions,
	fetchInstallationInfo,
	githubAppCall,
	listInstallationRepositories,
	listUserInstallationIds,
	type AppApiError,
	type AppApiResult,
	type AppInstallationInfo,
	type FetchFn,
} from "@workspace/github";
