/** Dicionário en-US. Precisa ter toda chave do pt-BR (o typecheck e o teste de paridade garantem). */
import type { MessageDictionary } from "../../translator";
import { common } from "./common";
import { composer } from "./composer";
import { library } from "./library";
import { login } from "./login";
import { settings } from "./settings";
import { sidebar } from "./sidebar";
import { ui } from "./ui";

export const enUS: MessageDictionary = {
	...common,
	...composer,
	...library,
	...login,
	...settings,
	...sidebar,
	...ui,
};
