import type ExcelJS from "exceljs";
import { findDangerousFormulaFunctions, isFormulaCell, type SheetCell, type SheetInput } from "@workspace/shared";

function toCellValue(cell: SheetCell): ExcelJS.CellValue {
	// Texto que começa com "=" vira fórmula. Função de rede/execução dispara ao abrir: recusa (auditoria F2, S4).
	if (isFormulaCell(cell)) {
		const bad = findDangerousFormulaFunctions(cell.slice(1));
		if (bad.length > 0) throw new Error(`Formula not accepted: ${bad.join(", ")} reaches the network or runs code when the file opens.`);
		return { formula: cell.slice(1) };
	}
	return cell;
}

/** Planilha: cabeçalho em negrito, 1ª linha congelada, largura automática. */
export async function renderXlsx(sheets: SheetInput[]): Promise<Uint8Array> {
	const { default: ExcelJSRuntime } = await import("exceljs");
	const workbook = new ExcelJSRuntime.Workbook();
	workbook.creator = "Atlas";
	for (const sheet of sheets) {
		const ws = workbook.addWorksheet(sheet.name);
		const widths: number[] = [];
		const track = (col: number, value: unknown) => {
			const len = String(value ?? "").length;
			widths[col] = Math.max(widths[col] ?? 8, Math.min(60, len + 2));
		};
		if (sheet.columns?.length) {
			const header = ws.addRow(sheet.columns);
			header.font = { bold: true };
			sheet.columns.forEach((c, i) => track(i, c));
			ws.views = [{ state: "frozen", ySplit: 1 }];
		}
		for (const row of sheet.rows) {
			ws.addRow(row.map(toCellValue));
			row.forEach((cell, i) => track(i, cell));
		}
		widths.forEach((w, i) => {
			if (w) ws.getColumn(i + 1).width = w;
		});
	}
	return new Uint8Array(await workbook.xlsx.writeBuffer());
}
