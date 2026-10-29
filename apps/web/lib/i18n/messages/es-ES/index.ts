/** Dicionário es-ES. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { app } from "./app";
import { chat } from "./chat";
import { common } from "./common";
import { composer } from "./composer";
import { errors } from "./errors";
import { library } from "./library";
import { login } from "./login";
import { marketplace } from "./marketplace";
import { mobile } from "./mobile";
import { settings } from "./settings";
import { sharedLabels } from "./sharedLabels";
import { sidebar } from "./sidebar";
import { status } from "./status";
import { ui } from "./ui";

export const esES: MessageDictionary = {
	...app,
	...chat,
	...common,
	...composer,
	...errors,
	...library,
	...login,
	...marketplace,
	...mobile,
	...settings,
	...sharedLabels,
	...sidebar,
	...status,
	...ui,
};
