import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckSquare, Clock, FileText, MinusSquare, Play, Square, X } from "lucide-react";
import { useAgentStore } from "../../stores/agentStore";
import { useProjectStore } from "../../stores/projectStore";
import {
  listTaskNotes,
  listTaskSummaries,
  loadTaskDoc,
  parseSteps,
  type TaskDoc,
  type TaskNoteHeader,
  type TaskStep,
  type TaskSummary,
} from "../../lib/agent/taskWorkspace";
import styles from "./TaskWorkspaceView.module.css";

interface TaskWorkspaceViewProps {
  onClose: () => void;
}

export function TaskWorkspaceView({ onClose }: TaskWorkspaceViewProps) {
  const { t } = useTranslation();
  const projectPath = useProjectStore((s) => s.projectPath);
  const resumeTask = useAgentStore((s) => s.resumeTask);
  const chatRunning = useAgentStore((s) => s.chatRunning);

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<TaskDoc | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<TaskStep[]>([]);
  const [selectedNotes, setSelectedNotes] = useState<TaskNoteHeader[]>([]);
  const [loading, setLoading] = useState(true);

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
      default:
        return status;
    }
  };

  const renderStepIcon = (status: TaskStep["status"]) => {
    switch (status) {
      case "done":
        return <CheckSquare size={13} strokeWidth={2} style={{ color: "var(--color-success-text)" }} />;
      case "in_progress":
        return <Clock size={13} strokeWidth={2} style={{ color: "var(--color-info-text)" }} />;
      case "skipped":
        return <MinusSquare size={13} strokeWidth={2} style={{ color: "var(--color-text-muted)" }} />;
      case "pending":
      default:
        return <Square size={13} strokeWidth={1.8} style={{ color: "var(--color-text-muted)" }} />;
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          {t("ai.taskWorkspace.title", { defaultValue: "任务工作区" })}
        </div>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
          <X size={15} strokeWidth={1.8} />
        </button>
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
                <div>
                  <div className={styles.detailTitle}>
                    {tasks.find((t) => t.taskId === selectedId)?.title || selectedId}
                  </div>
                  <div className={styles.detailTaskId}>
                    ID: {selectedId} · {new Date(selectedDoc.meta.updatedAt).toLocaleString()}
                  </div>
                </div>
                {selectedDoc.meta.status !== "completed" && (
                  <button
                    className={styles.resumeBtn}
                    onClick={() => handleResume(selectedId)}
                    disabled={chatRunning}
                  >
                    <Play size={12} strokeWidth={2.2} />
                    {t("ai.taskWorkspace.resume", { defaultValue: "恢复并继续" })}
                  </button>
                )}
              </div>

              {selectedSteps.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>
                    {t("ai.taskWorkspace.steps", { defaultValue: "任务步骤" })}
                  </div>
                  <ul className={styles.stepsList}>
                    {selectedSteps.map((step) => (
                      <li key={step.index} className={styles.stepRow}>
                        {renderStepIcon(step.status)}
                        <span>{step.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {selectedNotes.length > 0 && (
                <div className={styles.section}>
                  <div className={styles.sectionTitle}>
                    {t("ai.taskWorkspace.notes", { defaultValue: "相关笔记" })} ({selectedNotes.length})
                  </div>
                  <div className={styles.notesGrid}>
                    {selectedNotes.map((note) => (
                      <div key={note.slug} className={styles.noteCard}>
                        <div className={styles.noteTitle}>
                          <FileText size={12} strokeWidth={1.8} style={{ marginRight: 4, verticalAlign: -1 }} />
                          {note.title}
                        </div>
                        <div className={styles.notePath}>{note.path}</div>
                      </div>
                    ))}
                  </div>
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
    </div>
  );
}
