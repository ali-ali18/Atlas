// Capacidade `deliverables` (F2.3): arquivos ricos, painéis e gráficos. Lazy: não é núcleo, entra no índice de uma
// linha e só carrega (tools + moldes) quando o modelo chama `use_capability`. Fala só com as portas de `ports/deliverables.ts`.
import { defineCapability } from "../../capabilities/define-capability.js";
import type { DeliverablePorts } from "../../ports/deliverables.js";
import { createChartTool } from "./chart.js";
import { createCreateFileTool } from "./create-file.js";
import { createCreatePageTool } from "./create-page.js";
import { createInspectFileTool } from "./inspect-file.js";
import { createPanelListTool, createPanelReadTool, createPanelShareTool, createPanelUnshareTool, createPanelUpdateTool } from "./panel-tools.js";
import { DELIVERABLES_INSTRUCTIONS } from "./instructions.js";

export { CREATABLE_EXTENSIONS } from "./create-file.js";
export { DELIVERABLES_INSTRUCTIONS } from "./instructions.js";

export function createDeliverablesCapability(ports: DeliverablePorts) {
	return defineCapability({
		id: "deliverables",
		title: "Entregas",
		summary: "Create files (docx, pdf, xlsx, pptx, md, csv), dashboard panels (create, read, update, share by link) and charts; read files.",
		tools: [
			createCreateFileTool(ports.files),
			createCreatePageTool(ports.pages),
			createChartTool(ports.charts),
			createInspectFileTool(ports.files),
			createPanelListTool(ports.pages),
			createPanelReadTool(ports.pages),
			createPanelUpdateTool(ports.pages),
			createPanelShareTool(ports.pages),
			createPanelUnshareTool(ports.pages),
		],
		instructions: DELIVERABLES_INSTRUCTIONS,
		cards: ["file", "page", "chart"],
	});
}
