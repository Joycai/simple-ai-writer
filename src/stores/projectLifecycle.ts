/**
 * Opening, switching and closing a project — the one entry point for all
 * three. Not a store: like `configImportRefresh.ts`, it is the function that
 * sequences several stores that must not import each other.
 *
 * `projectStore` owns the switch itself (flush, lock, scaffold, rescan); the
 * chat side owns two steps inside it — asking before conversations in the
 * project being left are stopped, and restoring the new project's chats once
 * the switch can no longer fail. Those used to be `await import("./agentStore")`
 * calls from inside `projectStore`, and agentStore reads projectStore, so the
 * two formed an import cycle (docs/feature/code-structure-plan.md P4). Here
 * they are handed in as hooks, at the same points and in the same order:
 *
 *   open:  confirmLeave (only when the target differs) → flush → claim →
 *          scaffold / rescan → onSwitched(target) → composer reset
 *   close: confirmLeave(null) → flush → reset documents → onSwitched(null) →
 *          composer reset → DB / workspace reset
 */

import { useAgentStore } from "./agentStore";
import { useProjectStore, type OpenProjectOutcome, type ProjectSwitchHooks } from "./projectStore";

const chatHooks: ProjectSwitchHooks = {
  confirmLeave: (name) => useAgentStore.getState().confirmProjectSwitch(name),
  onSwitched: (projectPath) => useAgentStore.getState().resetChatForProject(projectPath),
};

/** Open `path`, or prompt for a folder when it is omitted. */
export function openProject(path?: string): Promise<OpenProjectOutcome> {
  return useProjectStore.getState().openProject(path, chatHooks);
}

export function closeProject(): Promise<void> {
  return useProjectStore.getState().closeProject(chatHooks);
}
