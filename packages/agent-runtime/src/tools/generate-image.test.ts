import { expect, it } from "vitest";
import { GENERATE_IMAGE_TOOL, parseGenerateImageArgs } from "./generate-image.js";
it("anuncia somente criação e recusa referência antes de gastar", () => {
 expect(GENERATE_IMAGE_TOOL.function.parameters.properties).not.toHaveProperty("reference_artifact_id");
 expect(GENERATE_IMAGE_TOOL.function.description).toContain("unavailable");
 expect(parseGenerateImageArgs({ prompt: "blue flower" })).toEqual({ prompt: "blue flower", n: 1 });
 expect(() => parseGenerateImageArgs({ prompt: "blue flower", reference_artifact_id: "image-a" })).toThrow();
 expect(GENERATE_IMAGE_TOOL.function.description).toMatch(/Call it directly whenever/);
 expect(GENERATE_IMAGE_TOOL.function.description).toMatch(/Do not use/);
});
