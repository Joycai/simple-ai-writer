/**
 * 封存场次的只读查看器。
 *
 * 「新开会话」把上一场移进 `archive/`，一个字都没删——但只有文件里留着不算数，
 * 作者得能在应用里读到它，否则「封存」在他的体感里和「删除」没有区别。
 *
 * 只读，而且刻意只读：能继续的会话只有一个，这是「存档」这个词的全部含义。
 * 要接着往下写，办法是把那段文字读出来、当素材用（旁白的 scene 工具做的正是
 * 这件事），不是把一场戏复活。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { readFile } from "../../lib/fs/fileio";
import { parseTranscript } from "../../lib/roleplay/transcript";
import type { ArchivedScene } from "../../lib/roleplay/store";
import type { SceneTurn } from "../../lib/roleplay/model";
import { ScriptText } from "./ScriptText";
import styles from "./ArchiveViewer.module.css";

export function ArchiveViewer({ scenes, agentName, onClose }: {
  scenes: ArchivedScene[];
  agentName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(scenes[0]?.no ?? 0);
  const [turns, setTurns] = useState<SceneTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scene = scenes.find((s) => s.no === active);
    if (!scene) return;
    let alive = true;
    setTurns(null);
    setError(null);
    void readFile(scene.path)
      .then((text) => { if (alive) setTurns(parseTranscript(text).turns); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [active, scenes]);

  return (
    <>
      <div className={styles.scrim} onClick={onClose} />
      <aside className={styles.drawer} role="dialog" aria-modal>
        <header className={styles.head}>
          <span className={styles.title}>
            {t("roleplay.archive.title", { name: agentName, defaultValue: `${agentName} · 已封存的场次` })}
          </span>
          <div className={styles.spacer} />
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </header>

        <div className={styles.body}>
          <nav className={styles.rail}>
            {scenes.map((s) => (
              <button
                key={s.no}
                type="button"
                className={`${styles.railItem} ${s.no === active ? styles.railItemOn : ""}`}
                onClick={() => setActive(s.no)}
              >
                {t("roleplay.archive.scene", { n: s.no, defaultValue: `第 ${s.no} 场` })}
                {/* 作废的一场：文件一个字都没删，作者仍然能读——但它不属于故事，
                    角色和旁白都读不到它。这个标记是那句话唯一被说出来的地方。 */}
                {s.discarded && (
                  <span className={styles.railTag}>
                    {t("roleplay.archive.discarded", { defaultValue: "作废" })}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className={styles.scroll}>
            <div className={styles.column}>
              {error && <div className={styles.error}>{error}</div>}
              {!error && turns === null && (
                <div className={styles.empty}>{t("common.loading", { defaultValue: "读取中…" })}</div>
              )}
              {turns?.map((turn) => (
                <div
                  key={turn.index}
                  className={turn.speaker === "author" ? styles.authorTurn : styles.agentTurn}
                >
                  <div className={styles.label}>
                    {turn.speaker === "author"
                      ? t("roleplay.me", { defaultValue: "我" })
                      : turn.speakerName}
                    {turn.speaker === "author" && turn.speakerName && (
                      <span className={styles.personaName}>{turn.speakerName}</span>
                    )}
                  </div>
                  <ScriptText text={turn.text} />
                </div>
              ))}
              {turns?.length === 0 && (
                <div className={styles.empty}>{t("roleplay.archive.blank", { defaultValue: "这一场是空的。" })}</div>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
