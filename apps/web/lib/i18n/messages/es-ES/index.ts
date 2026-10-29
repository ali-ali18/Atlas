/** Dicionário es-ES. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { app } from "./app";
import { chat } from "./chat";
import { common } from "./common";
import { composer } from "./composer";
import { library } from "./library";
import { login } from "./login";
import { marketplace } from "./marketplace";
import { mobile } from "./mobile";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { ui } from "./ui";

export const esES: MessageDictionary = {
	...app,
	...chat,
	...common,
	...composer,
	...library,
	...login,
	...marketplace,
	...mobile,
	...settings,
	...sidebar,
	...ui,
};
