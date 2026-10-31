/** Recovery references are author-controlled; forgetting never cancels the vendor's job. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "../../common/Select";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { listImageTasks, forgetImageTask } from "../../../lib/ai/imageTasks";
import { Field } from "./ModelDrawerBits";
import s from "./ModelDrawer.module.css";
export function ImageTaskRecovery({ endpoint, modelId }: { endpoint: string; modelId: string }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<Awaited<ReturnType<typeof listImageTasks>>>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void listImageTasks(endpoint, modelId).then(value => { if (active) setTasks(value); }, e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [endpoint, modelId]);
  if (!tasks.length && !error) return null;
  return <>
    <Field label={t("aiConfig.models.imagePending")} hint={t("aiConfig.models.imagePendingHint")} warn={error || undefined}>
      <Select className={s.fieldSelect} value="" onChange={setSelected}
        options={[{ value: "", label: t("aiConfig.models.imageForget") }, ...tasks.map(task => ({ value: task.key,
          label: `${task.taskId || t("aiConfig.models.imageUnknown")} · ${new Date(task.submittedAt).toLocaleString()}` }))]} />
    </Field>
    {selected && <ConfirmDialog title={t("aiConfig.models.imageForget")} message={t("aiConfig.models.imageForgetWarning")}
      confirmLabel={t("aiConfig.models.imageForget")} onClose={() => setSelected("")}
      onConfirm={() => { void forgetImageTask(selected).then(() => { setTasks(items => items.filter(item => item.key !== selected)); setSelected(""); }, e => setError(String(e))); }} />}
  </>;
}
