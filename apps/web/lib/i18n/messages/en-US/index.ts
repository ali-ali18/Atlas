/** Dicionário en-US. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { aiElements } from "./aiElements";
import { app } from "./app";
import { autonomy } from "./autonomy";
import { botActions } from "./botActions";
import { botSettings } from "./botSettings";
import { chat } from "./chat";
import { chatExtras } from "./chatExtras";
import { common } from "./common";
import { composer } from "./composer";
import { contextPanel } from "./contextPanel";
import { devSession } from "./devSession";
import { errors } from "./errors";
import { groups } from "./groups";
import { library } from "./library";
import { libraryPanel } from "./libraryPanel";
import { login } from "./login";
import { marketplace } from "./marketplace";
import { mobile } from "./mobile";
import { reasoning } from "./reasoning";
import { modelPicker } from "./modelPicker";
import { providerCallback } from "./providerCallback";
import { routines } from "./routines";
import { settings } from "./settings";
import { settingsComposio } from "./settingsComposio";
import { settingsDev } from "./settingsDev";
import { settingsExec } from "./settingsExec";
import { settingsGithub } from "./settingsGithub";
import { settingsModels } from "./settingsModels";
import { settingsOps } from "./settingsOps";
import { settingsPanes } from "./settingsPanes";
import { settingsProviders } from "./settingsProviders";
import { settingsSearch } from "./settingsSearch";
import { settingsSkills } from "./settingsSkills";
import { settingsVault } from "./settingsVault";
import { share } from "./share";
import { sharedLabels } from "./sharedLabels";
import { sidebar } from "./sidebar";
import { status } from "./status";
import { ui } from "./ui";

export const enUS: MessageDictionary = {
	...aiElements,
	...app,
	...autonomy,
	...botActions,
	...botSettings,
	...chat,
	...chatExtras,
	...common,
	...composer,
	...contextPanel,
	...devSession,
	...errors,
	...groups,
	...library,
	...libraryPanel,
	...login,
	...marketplace,
	...mobile,
	...reasoning,
	...modelPicker,
	...providerCallback,
	...routines,
	...settings,
	...settingsComposio,
	...settingsDev,
	...settingsExec,
	...settingsGithub,
	...settingsModels,
	...settingsOps,
	...settingsPanes,
	...settingsProviders,
	...settingsSearch,
	...settingsSkills,
	...settingsVault,
	...share,
	...sharedLabels,
	...sidebar,
	...status,
	...ui,
};
