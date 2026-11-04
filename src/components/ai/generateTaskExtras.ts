import type { TaskExtras } from "../../lib/context/rag";
import type { TaskDef } from "../../lib/profile/model";

/** Pins apply to every task; a reference-window picker controls only contextChars. */
export function generateTaskExtras(
  task: Pick<TaskDef, "continuation" | "referenceWindow" | "freeform">,
  paths: string[], requirement: string, contextChars: number,
): TaskExtras {
  return {
    manualLorePaths: paths.length ? paths : undefined,
    ...(!task.continuation && !task.freeform ? { requirement: requirement.trim() || undefined } : {}),
    ...(task.referenceWindow ? { contextChars } : {}),
  };
}
