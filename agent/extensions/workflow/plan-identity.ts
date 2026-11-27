/**
 * Workflow Extension — stable row identity, dependency-free.
 *
 * Frozen rows must keep the identity they were frozen with, and the compiler
 * must assign the same id the freeze path has always assigned. Keeping the
 * rule in one tiny module lets `utils.ts`, the compiler and the todo/freeze
 * code share it without an import cycle.
 *
 * The ids are content-based, not positional: rewording a later step does not
 * renumber an earlier row, and a repeated phase label still disambiguates.
 */

function stableHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function identityKey(parts: Array<string | undefined>): string {
  return parts
    .map((part) =>
      String(part ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
    )
    .join("|");
}

/** The fields every identity helper reads; structurally compatible with TodoItem. */
export interface IdentityFields {
  text: string;
  group?: string;
  label?: string;
}

/** Stable identity for a row that predates ids (content-based, not positional). */
export function todoItemId(item: IdentityFields): string {
  return `todo-${stableHash(identityKey([item.text, item.group, item.label]))}`;
}

/** Stable plan binding: label + group, falling back to the plan text. */
export function planStepIdFor(
  item: IdentityFields & { planStepId?: string },
): string {
  if (item.planStepId) return item.planStepId;
  const key = identityKey([item.group, item.label]);
  return `plan-${stableHash(key || item.text)}`;
}
