/**
 * Model-aware thinking levels for the role/profile editors (2026-10-31 UI plan).
 *
 * Pi's `getSupportedThinkingLevels` is the authority. The editors used to list
 * every level (`VALID_THINKING_LEVELS`) for every model, so a profile could
 * store `medium` for a model whose map makes it unsupported; Pi then silently
 * clamped it on activation. These helpers keep the staged value inside the
 * model's set and fall back to the full list only when the model is unknown
 * (offline editing, hand-edited files) so a missing registry entry never
 * blocks the picker.
 */

import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";

import { VALID_THINKING_LEVELS, type ThinkingLevel } from "./roles.ts";

function isKnownModel(model: unknown): model is Record<string, unknown> {
  if (!model || typeof model !== "object") return false;
  const record = model as Record<string, unknown>;
  return typeof record.reasoning === "boolean";
}

function asThinkingLevel(value: string): ThinkingLevel | null {
  return (VALID_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : null;
}

/** The model's supported levels, or all levels when the model is unknown. */
export function thinkingLevelsForModel(model: unknown): ThinkingLevel[] {
  if (!isKnownModel(model)) return [...VALID_THINKING_LEVELS];
  try {
    const levels = getSupportedThinkingLevels(model as never)
      .map((level) => asThinkingLevel(String(level)))
      .filter((level): level is ThinkingLevel => level !== null);
    return levels.length > 0 ? levels : [...VALID_THINKING_LEVELS];
  } catch {
    return [...VALID_THINKING_LEVELS];
  }
}

/** Clamp a stored level to the model's set (no-op for an unknown model). */
export function clampThinkingForModel(model: unknown, level: ThinkingLevel): ThinkingLevel {
  if (!isKnownModel(model)) return level;
  try {
    return asThinkingLevel(String(clampThinkingLevel(model as never, level))) ?? level;
  } catch {
    return level;
  }
}

/** The pair an editor should stage after a model change / before a save. */
export function thinkingLevelsForPair(
  model: unknown,
  level: ThinkingLevel,
): { levels: ThinkingLevel[]; level: ThinkingLevel } {
  const levels = thinkingLevelsForModel(model);
  if (levels.includes(level)) return { levels, level };
  const clamped = clampThinkingForModel(model, level);
  return {
    levels,
    level: levels.includes(clamped) ? clamped : (levels[0] ?? level),
  };
}
