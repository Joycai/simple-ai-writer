import { isCodeDevelopmentCommand } from "../cli/codeDevelopment";
import { shellSyntax } from "../cli/shell";
import { isWorkspacePath, pathKey } from "../paths";
import type { CommandProposal } from "./toolTypes";

export interface CodeDevelopmentGrant { projectPath: string }

/** The owner/run is bound by the caller; never infer it from the active tab. */
export function grantsCodeDevelopment(
  grant: CodeDevelopmentGrant | null | undefined,
  projectPath: string | null | undefined,
  proposal: CommandProposal,
): boolean {
  return !!grant?.projectPath && !!projectPath
    && pathKey(grant.projectPath) === pathKey(projectPath)
    && isWorkspacePath(projectPath, proposal.path)
    && !proposal.requiresIndividualApproval && proposal.danger === null
    && isCodeDevelopmentCommand(proposal.command, shellSyntax(proposal.shell));
}
