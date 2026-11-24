/**
 * Workflow Extension — workspace path helpers.
 *
 * Only the path-shape predicate survives: workspaces are now declared directly
 * by the model (`orchestrator_start.workspaces`), so there is no baseline,
 * diff or identity half to carry.
 */

/** True for a Windows-style path (drive letter or UNC). */
export function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
