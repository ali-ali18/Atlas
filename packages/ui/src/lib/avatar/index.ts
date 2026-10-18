export { createAvatarEngine, type AvatarEngine, type EngineOptions } from "./engine";
export {
	AVATAR_COLORS,
	eyeColorFor,
	identityFor,
	normalizeShape,
	resolveColor,
	resolveShape,
	type AvatarColor,
	type AvatarIdentity,
} from "./identity";
export { DRAWABLE_SHAPES, SHAPE_IDS, SHAPE_POINTS, isShape, shapeFit, shapeOutline, shapeScale, worstPointRadius, type Shape } from "./geometry/shapes";
export { EXPRESSIONS, normalizeExpression, type Expression } from "./model/expressions";
export { Character, type EyeFrame, type Frame, type Orientation } from "./model/character";
export { rotationMatrix, applyMat, type Mat3 } from "./geometry/math";
export { createProjector, projectBody, projectEyes, projectFrame } from "./render/project";
export { StateMachine, type AvatarState } from "./model/behavior";
export { renderFrame, bodyPath, eyePath, eyesPath, groupTransform, maskId, resolveEyes } from "./render/svg";
export { stillFrame, toDataUrl, toSvg, toSvgFile } from "./render/still";
export { createTicker, getTicker, type FollowMode } from "./runtime/ticker";
