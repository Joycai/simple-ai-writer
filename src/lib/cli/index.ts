/**
 * 命令行（Beta）——对外只露设置、工具与卡片需要的名字。
 *
 * 设计与分片：docs/feature/agent/shell-command-plan.md。Rust 那一半在
 * src-tauri/src/cmd.rs。
 */

export { isCliEnabled, setCliEnabled } from "./flag";
export { shellInfo, cachedShellInfo, shellLabel, shellSyntax, type ShellInfo, type ShellKind } from "./shell";
export { programNameOf, isCompound, looksDangerous, type DangerKind } from "./command";
export { clipForModel, formatResult, CLIP_HEAD, CLIP_TAIL, type CmdResult } from "./output";
export {
  runCommand,
  clampTimeout,
  needsLog,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  CMD_LOG_DIR,
  CMD_LOGS_KEPT,
  type RunCommandRequest,
  type RunCommandOutcome,
} from "./run";
