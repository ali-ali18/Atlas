/** Dicionário pt-BR: fonte da verdade das chaves. Um arquivo por área; acrescente o `...area` abaixo. */
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
import { sidebar } from "./sidebar";
import { status } from "./status";
import { ui } from "./ui";
import { routines } from "./routines";
import { libraryPanel } from "./libraryPanel";
import { contextPanel } from "./contextPanel";
import { botSettings } from "./botSettings";

export const ptBR = {
	...app,
	...autonomy,
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
	...sidebar,
	...status,
	...ui,
	...routines,
	...libraryPanel,
	...contextPanel,
	...botSettings,
} as const;
