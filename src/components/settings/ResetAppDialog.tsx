/**
 * 重置应用配置的确认流程：两道门，第二道要手打一个词。
 *
 * 两道不是同一道来两遍。第一道给的是**事实**——这台机器上到底有多少供应商、
 * 多少偏好会消失，数字从库里数出来（`collectResetInventory`），因为「将清除
 * 全部配置」这句话在什么都没配过的机器上和配了十八个供应商的机器上长得一模
 * 一样。第二道要的是**手上的一个停顿**：连点两次「确定」是一个动作，打四个字
 * 不是。
 *
 * 清完就重载窗口。内存里的 store 和偏好缓存还停在旧值上，而重新走一遍
 * `main.tsx` 的启动（空 prefs → 引导页）恰好就是重置后应该看到的样子。
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { ModalShell } from "../common/ModalShell";
import {
  collectResetInventory,
  resetApp,
  SecretWipeError,
  type ResetInventory,
} from "../../lib/appReset";
import styles from "./ResetAppDialog.module.css";

type Stage = "review" | "type" | "running" | "done";

export function ResetAppDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>("review");
  const [inventory, setInventory] = useState<ResetInventory | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const word = t("systemSettings.reset.confirmWord");
  const matches = typed.trim().toLocaleLowerCase() === word.toLocaleLowerCase();
  const busy = stage === "running" || stage === "done";

  useEffect(() => {
    let alive = true;
    collectResetInventory()
      .then((inv) => alive && setInventory(inv))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (stage === "type") inputRef.current?.focus();
  }, [stage]);

  const run = async () => {
    if (!matches || busy) return;
    setStage("running");
    setError(null);
    try {
      await resetApp();
      setStage("done");
      // 一拍，好让「已重置」这句话被读到；重载之后它就不在了。
      window.setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setStage("type");
      setError(
        e instanceof SecretWipeError
          ? t("systemSettings.reset.keyringFailed", { count: e.failed })
          : `${t("systemSettings.reset.failed")} ${e}`,
      );
    }
  };

  // 清除已经开始就不再接受背景点击和 Escape：中途关掉窗口不会让它停下，
  // 只会让作者看不见结果。
  return (
    <ModalShell
      overlayClassName={styles.overlay}
      onClose={onClose}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
    >
      <div className={styles.panel} role="alertdialog" aria-modal="true">
        <div className={styles.title}>
          <AlertTriangle size={18} className={styles.titleIcon} />
          {stage === "done"
            ? t("systemSettings.reset.doneTitle")
            : stage === "type"
              ? t("systemSettings.reset.step2Title")
              : t("systemSettings.reset.title")}
        </div>

        {stage === "done" ? (
          <div className={styles.body}>{t("systemSettings.reset.doneBody")}</div>
        ) : stage === "type" ? (
          <>
            <div className={styles.body}>{t("systemSettings.reset.step2Body", { word })}</div>
            <input
              ref={inputRef}
              className={styles.input}
              value={typed}
              disabled={busy}
              placeholder={t("systemSettings.reset.placeholder", { word })}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
            />
          </>
        ) : (
          <>
            <div className={styles.body}>{t("systemSettings.reset.intro")}</div>
            <ul className={styles.list}>
              {inventory === null ? (
                <li className={styles.item}>{t("systemSettings.reset.counting")}</li>
              ) : (
                <>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemProviders", { count: inventory.providers })}
                  </li>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemModels", { count: inventory.models })}
                  </li>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemPrompts", { count: inventory.prompts })}
                  </li>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemDocFormats", { count: inventory.docFormats })}
                  </li>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemSecrets", { count: inventory.secrets })}
                  </li>
                  <li className={styles.item}>
                    {t("systemSettings.reset.itemPrefs", { count: inventory.prefs })}
                  </li>
                </>
              )}
            </ul>
            <div className={styles.keep}>
              <span className={styles.keepLabel}>{t("systemSettings.reset.keepTitle")}</span>{" "}
              {t("systemSettings.reset.keep")}
              <br />
              {t("systemSettings.reset.backupFirst")}
            </div>
          </>
        )}

        {error && <div className={styles.error}>{error}</div>}

        {stage !== "done" && (
          <div className={styles.actions}>
            <button
              className={styles.cancelBtn}
              disabled={busy}
              onClick={() => (stage === "type" ? setStage("review") : onClose())}
            >
              {stage === "type" ? t("systemSettings.reset.back") : t("common.cancel")}
            </button>
            {stage === "review" ? (
              <button
                className={styles.confirmBtn}
                disabled={inventory === null}
                onClick={() => setStage("type")}
              >
                {t("systemSettings.reset.next")}
              </button>
            ) : (
              <button className={styles.confirmBtn} disabled={!matches || busy} onClick={run}>
                {stage === "running"
                  ? t("systemSettings.reset.running")
                  : t("systemSettings.reset.doIt")}
              </button>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  );
}
