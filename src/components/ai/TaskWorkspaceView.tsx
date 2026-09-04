import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { useActiveChat, useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  clearCompletedTasks,
  deleteTask,
  isFinishedStatus,
  listTaskNotes,
  listTaskSummaries,
  loadTaskDoc,
  parseSteps,
  type TaskDoc,
  type TaskNoteHeader,
  type TaskStep,
  type TaskSummary,
} from "../../lib/agent/taskWorkspace";
import { formatTokenCount } from "../../lib/agent/logFormat";
import { ConfirmDialog } from "../common/ConfirmDialog";
import styles from "./TaskWorkspaceView.module.css";

interface TaskWorkspaceViewProps {
  onClose: () => void;
}

/**
 * Which confirmation is open. One slot rather than a boolean each, so two
 * dialogs can never be open at once and the destructive target always travels
 * with the request instead of being re-derived from the selection at confirm
 * time (which the confirm itself can change).
 */
type PendingConfirm =
  | { kind: "clear" }
  | { kind: "abort"; taskId: string }
  | { kind: "delete"; taskId: string };

/**
 * Step state in the 1g vocabulary — the same square marks TaskPanel speaks,
 * sized for a reading row: success check, filled sienna square (current),
 * outlined square (pending), mono dash (skipped).
 */
function StepMark({ status }: { status: TaskStep["status"] }) {
  if (status === "done") {
    return (
      <svg className={styles.markDone} width="12" height="12" viewBox="0 0 24 24" fill="none" strokeWidth="2" aria-hidden>
        <path d="M5 12 L10 17 L20 7" />
      </svg>
    );
  }
  if (status === "skipped") return <span className={styles.markSkipped} aria-hidden>–</span>;
  return (
    <span
      className={status === "in_progress" ? styles.markCurrent : styles.markPending}
      aria-hidden
    />
  );
}

export function TaskWorkspaceView({ onClose }: TaskWorkspaceViewProps) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const resumeTask = useAgentStore((s) => s.resumeTask);
  const abortTask = useAgentStore((s) => s.abortTask);
  // The task the conversation on screen is working on.
  const chatTaskId = useActiveChat((c) => c.taskWorkspace?.taskId ?? null);

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<TaskDoc | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<TaskStep[]>([]);
  const [selectedNotes, setSelectedNotes] = useState<TaskNoteHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    let active = true;
    void listTaskSummaries(projectPath).then((items) => {
      if (!active) return;
      setTasks(items);
      if (items.length > 0) {
        setSelectedId((prev) => prev ?? items[0].taskId);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath || !selectedId) {
      setSelectedDoc(null);
      setSelectedSteps([]);
      setSelectedNotes([]);
      return;
    }
    let active = true;
    void (async () => {
      const doc = await loadTaskDoc(projectPath, selectedId);
      const notes = await listTaskNotes(projectPath, selectedId);
      if (!active) return;
      setSelectedDoc(doc);
      setSelectedSteps(doc ? parseSteps(doc.body) : []);
      setSelectedNotes(notes);
    })();
    return () => {
      active = false;
    };
  }, [projectPath, selectedId]);

  const handleResume = async (taskId: string) => {
    onClose();
    await resumeTask(taskId);
  };

  /** Re-list after a mutation, keeping the selection if it survived. */
  const refresh = async (root: string) => {
    const next = await listTaskSummaries(root);
    setTasks(next);
    setSelectedId((prev) =>
      prev && next.some((task) => task.taskId === prev) ? prev : next[0]?.taskId ?? null,
    );
    return next;
  };

  // The chat's live workspace handle is spared even when completed — deleting
  // its dir would strand the handle on a recreated empty dir.
  const handleClearCompleted = async () => {
    if (!projectPath) return;
    await clearCompletedTasks(projectPath, chatTaskId);
    await refresh(projectPath);
  };

  const handleAbort = async (taskId: string) => {
    if (!projectPath) return;
    await abortTask(taskId);
    await refresh(projectPath);
    // Re-read the open doc: the status badge and the footer's buttons both
    // hang off it, and abortTask wrote straight to disk behind this view.
    setSelectedDoc(await loadTaskDoc(projectPath, taskId));
  };

  const handleDelete = async (taskId: string) => {
    if (!projectPath) return;
    await deleteTask(projectPath, taskId, chatTaskId);
    await refresh(projectPath);
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case "in_progress":
        return styles.statusInProgress;
      case "paused":
        return styles.statusPaused;
      case "completed":
        return styles.statusCompleted;
      case "failed":
        return styles.statusFailed;
      case "aborted":
        return styles.statusAborted;
      default:
        return "";
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "in_progress":
        return t("ai.taskWorkspace.status.inProgress", { defaultValue: "进行中" });
      case "paused":
        return t("ai.taskWorkspace.status.paused", { defaultValue: "已暂停" });
      case "completed":
        return t("ai.taskWorkspace.status.completed", { defaultValue: "已完成" });
      case "failed":
        return t("ai.taskWorkspace.status.failed", { defaultValue: "失败" });
      case "aborted":
        return t("ai.taskWorkspace.status.aborted", { defaultValue: "已终止" });
      default:
        return status;
    }
  };

  /** Right-hand meta of a note row: who filed it, how big, what it cites. */
  const noteMeta = (note: TaskNoteHeader): string => {
    const parts: string[] = [];
    if (note.origin) {
      parts.push(
        t(`ai.taskWorkspace.noteOrigin.${note.origin}`, { defaultValue: note.origin }),
      );
    }
    parts.push(
      t("ai.taskWorkspace.noteChars", {
        defaultValue: "{{n}} 字",
        n: formatTokenCount(note.chars),
      }),
    );
    if (note.sources) {
      parts.push(
        t("ai.taskWorkspace.noteSources", { defaultValue: "{{n}} 条来源", n: note.sources }),
      );
    }
    return parts.join(" · ");
  };

  const stepsDone = selectedSteps.filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
  const selectedTask = tasks.find((task) => task.taskId === selectedId);
  const isPaused = selectedDoc?.meta.status === "paused";
  const completedCount = tasks.filter(
    (task) => task.status === "completed" && task.taskId !== chatTaskId,
  ).length;

  // A task in play can be terminated; a finished one can be deleted — except
  // the chat's live workspace, whose dir must outlive the handle pointing at it.
  const selectedStatus = selectedDoc?.meta.status;
  const canAbort = !!selectedStatus && !isFinishedStatus(selectedStatus);
  const canDelete =
    !!selectedStatus && isFinishedStatus(selectedStatus) && selectedId !== chatTaskId;
  // Terminated is terminal on purpose: resuming would just undo the decision.
  const canResume = !!selectedStatus && selectedStatus !== "completed" && selectedStatus !== "aborted";

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backBtn} onClick={onClose}>
          {t("ai.taskWorkspace.backToChat", { defaultValue: "← 返回对话" })}
        </button>
        <div className={styles.headerTitle}>
          {t("ai.taskWorkspace.title", { defaultValue: "任务工作区" })}
        </div>
        <div className={styles.headerSpacer} />
        {selectedId && (
          <span className={styles.headerPath}>.ai-writer/tasks/{selectedId}/task.md</span>
        )}
      </div>

      <div className={styles.content}>
        <div className={styles.sidebar}>
          {loading ? (
            <div className={styles.emptyList}>
              {t("ai.taskWorkspace.loading", { defaultValue: "加载中…" })}
            </div>
          ) : tasks.length === 0 ? (
            <div className={styles.emptyList}>
              {t("ai.taskWorkspace.empty", { defaultValue: "暂无历史任务" })}
            </div>
          ) : (
            tasks.map((task) => (
              <button
                key={task.taskId}
                className={`${styles.taskItem} ${task.taskId === selectedId ? styles.taskItemActive : ""}`}
                onClick={() => setSelectedId(task.taskId)}
              >
                <div className={styles.itemHeader}>
                  <span className={styles.taskTitle}>{task.title}</span>
                  <span className={`${styles.statusBadge} ${getStatusClass(task.status)}`}>
                    {getStatusLabel(task.status)}
                  </span>
                </div>
                <div className={styles.itemMeta}>
                  <span>
                    {t("ai.taskWorkspace.stepsCount", {
                      defaultValue: "{{done}}/{{total}} 步",
                      done: task.stepsDone,
                      total: task.stepsTotal,
                    })}
                  </span>
                  <span>{new Date(task.updatedAt).toLocaleDateString()}</span>
                </div>
              </button>
            ))
          )}
        </div>

        <div className={styles.detailArea}>
          {selectedDoc && selectedId ? (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailTitleRow}>
                  <div className={styles.detailTitle}>
                    {selectedTask?.title || selectedId}
                  </div>
                  <span
                    className={`${styles.statusBadge} ${getStatusClass(selectedDoc.meta.status)}`}
                  >
                    {getStatusLabel(selectedDoc.meta.status)}
                  </span>
                  <div className={styles.headerSpacer} />
                  <span className={styles.updatedAt}>
                    {t("ai.taskWorkspace.updatedAt", {
                      defaultValue: "更新于 {{time}}",
                      time: new Date(selectedDoc.meta.updatedAt).toLocaleString(),
                    })}
                  </span>
                </div>
                {isPaused && (
                  <div className={styles.diskNote}>
                    {t("ai.taskWorkspace.diskNote", {
                      defaultValue:
                        "暂停的任务可在新会话中继续——计划与笔记都在磁盘上，不依赖当前对话。",
                    })}
                  </div>
                )}
              </div>

              {selectedSteps.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>
                    {t("ai.taskWorkspace.stepsProgress", {
                      defaultValue: "步骤 · {{done}}/{{total}}",
                      done: stepsDone,
                      total: selectedSteps.length,
                    })}
                  </div>
                  <ul className={styles.stepsList}>
                    {selectedSteps.map((step) => (
                      <li
                        key={step.index}
                        className={`${styles.stepRow} ${styles[`step_${step.status}`]}`}
                      >
                        <StepMark status={step.status} />
                        <span className={styles.stepTitle}>{step.title}</span>
                        {isPaused && step.status === "in_progress" && (
                          <>
                            <div className={styles.headerSpacer} />
                            <span className={styles.pausedHere}>
                              {t("ai.taskWorkspace.pausedHere", { defaultValue: "暂停于此" })}
                            </span>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedNotes.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>
                    {t("ai.taskWorkspace.notesCount", {
                      defaultValue: "笔记 · {{n}}",
                      n: selectedNotes.length,
                    })}
                  </div>
                  <ul className={styles.notesList}>
                    {selectedNotes.map((note) => (
                      <li key={note.slug} className={styles.noteRow}>
                        <FileText size={12} strokeWidth={1.6} className={styles.noteIcon} />
                        <span className={styles.noteName} title={note.title}>
                          {note.slug}.md
                        </span>
                        <div className={styles.headerSpacer} />
                        <span className={styles.noteMeta}>{noteMeta(note)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyList}>
              {t("ai.taskWorkspace.selectPrompt", { defaultValue: "从左侧选择一个任务查看详情" })}
            </div>
          )}
        </div>
      </div>

      <div className={styles.footer}>
        {/* Flex row with gap — the per-task token ledger (subagent-lld §7.3)
            can slot in beside the clear button when it exists. */}
        {completedCount > 0 && (
          <button className={styles.clearBtn} onClick={() => setConfirm({ kind: "clear" })}>
            {t("ai.taskWorkspace.clearCompleted", { defaultValue: "清除已完成任务" })}
          </button>
        )}
        <div className={styles.headerSpacer} />
        {/* Terminate and delete are mutually exclusive by construction: a task
            is either still in play (terminable) or finished (deletable). */}
        {selectedId && canAbort && (
          <button
            className={styles.abortBtn}
            onClick={() => setConfirm({ kind: "abort", taskId: selectedId })}
          >
            {t("ai.taskWorkspace.abort", { defaultValue: "终止任务" })}
          </button>
        )}
        {selectedId && canDelete && (
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirm({ kind: "delete", taskId: selectedId })}
          >
            {t("ai.taskWorkspace.delete", { defaultValue: "删除任务" })}
          </button>
        )}
        {selectedDoc && selectedId && canResume && (
          <button
            className={styles.resumeBtn}
            // Resuming opens a conversation of its own (agentStore.resumeTask),
            // so a run elsewhere is no reason to hold the button.
            onClick={() => handleResume(selectedId)}
          >
            {t("ai.taskWorkspace.resume", { defaultValue: "在新会话中继续" })}
          </button>
        )}
      </div>

      {confirm?.kind === "clear" && (
        <ConfirmDialog
          title={t("ai.taskWorkspace.clearCompletedTitle", { defaultValue: "清除已完成任务" })}
          message={t("ai.taskWorkspace.clearCompletedMessage", {
            defaultValue:
              "将删除 {{n}} 个已完成任务的计划与笔记文件，此操作不可恢复。进行中和已暂停的任务不受影响。",
            n: completedCount,
          })}
          confirmLabel={t("ai.taskWorkspace.clearCompletedConfirm", { defaultValue: "删除" })}
          danger
          onConfirm={() => void handleClearCompleted()}
          onClose={() => setConfirm(null)}
        />
      )}

      {confirm?.kind === "abort" && (
        <ConfirmDialog
          title={t("ai.taskWorkspace.abortTitle", { defaultValue: "终止任务" })}
          message={t("ai.taskWorkspace.abortMessage", {
            defaultValue:
              "将停止「{{title}}」并标记为已终止。计划与笔记会保留在磁盘上，但该任务不能再继续。",
            title: selectedTask?.title ?? selectedId,
          })}
          confirmLabel={t("ai.taskWorkspace.abortConfirm", { defaultValue: "终止" })}
          danger
          onConfirm={() => void handleAbort(confirm.taskId)}
          onClose={() => setConfirm(null)}
        />
      )}

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title={t("ai.taskWorkspace.deleteTitle", { defaultValue: "删除任务" })}
          message={t("ai.taskWorkspace.deleteMessage", {
            defaultValue: "将删除「{{title}}」的计划与笔记文件，此操作不可恢复。",
            title: selectedTask?.title ?? selectedId,
          })}
          confirmLabel={t("ai.taskWorkspace.deleteConfirm", { defaultValue: "删除" })}
          danger
          onConfirm={() => void handleDelete(confirm.taskId)}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
