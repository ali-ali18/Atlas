/** Dicionário es-ES. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { app } from "./app";
import { autonomy } from "./autonomy";
import { chat } from "./chat";
import { chatExtras } from "./chatExtras";
import { common } from "./common";
import { composer } from "./composer";
import { errors } from "./errors";
import { groups } from "./groups";
import { library } from "./library";
import { login } from "./login";
import { marketplace } from "./marketplace";
import { mobile } from "./mobile";
import { settings } from "./settings";
import { sharedLabels } from "./sharedLabels";
import { settingsOps } from "./settingsOps";
import { settingsSearch } from "./settingsSearch";
import { sidebar } from "./sidebar";
import { status } from "./status";
import { ui } from "./ui";
import { routines } from "./routines";
import { libraryPanel } from "./libraryPanel";
import { contextPanel } from "./contextPanel";
import { botSettings } from "./botSettings";

export const esES: MessageDictionary = {
	...app,
	...autonomy,
import { aiElements } from "./aiElements";
import { devSession } from "./devSession";
import { share } from "./share";

	...share,
	...devSession,
	...aiElements,
	...chat,
	...chatExtras,
	...common,
	...composer,
	...errors,
	...groups,
	...library,
	...login,
	...marketplace,
	...mobile,
	...settings,
	...sharedLabels,
	...settingsOps,
	...settingsSearch,
	...sidebar,
	...status,
	...ui,
	...routines,
	...libraryPanel,
	...contextPanel,
	...botSettings,
};
