/**
 * 混合文本的稿面排版：`*动作*` / `「台词」` / 裸文本＝场景 / `[元指令]`。
 *
 * 设计稿 08 屏 1c 的口径落在这里和 ScriptText.module.css：四种标记各有自己的
 * 字体、字号、行高和色阶，元指令整块出戏（底色下沉 + 虚线左规 + META 角标）。
 * 解析本身在 lib/roleplay/markup——**发给模型的永远是原文**，排版只影响作者
 * 看到的东西。
 */

import { useTranslation } from "react-i18next";
import { parseScript, type ScriptSegment } from "../../lib/roleplay/markup";
import styles from "./ScriptText.module.css";

function Segment({ seg, metaLabel }: { seg: ScriptSegment; metaLabel: string }) {
  if (seg.kind === "meta") {
    return (
      <div className={styles.meta}>
        <span className={styles.metaTag}>{metaLabel}</span>
        <span className={styles.metaBody}>{seg.plain}</span>
      </div>
    );
  }
  return (
    <div className={styles[seg.kind]}>
      {seg.runs.map((run, i) =>
        run.kind === "mark"
          ? <span key={i} className={styles.quote}>{run.text}</span>
          : <span key={i}>{run.text}</span>,
      )}
    </div>
  );
}

export function ScriptText({
  text,
  requireClosed,
  caret,
}: {
  text: string;
  /** 输入框传 true：未闭合的标记不着色，免得打字过程满屏跳色。 */
  requireClosed?: boolean;
  /** 末尾追加一个闪烁光标（流式生成中）。 */
  caret?: boolean;
}) {
  const { t } = useTranslation();
  const segments = parseScript(text, { requireClosed });
  const metaLabel = t("roleplay.syntax.metaTag", { defaultValue: "META" });

  if (!segments.length) {
    return caret ? <div className={styles.speech}><span className={styles.caret} /></div> : null;
  }

  return (
    <>
      {segments.map((seg, i) => (
        <div key={i} className={styles.line}>
          <Segment seg={seg} metaLabel={metaLabel} />
          {caret && i === segments.length - 1 && <span className={styles.caret} />}
        </div>
      ))}
    </>
  );
}
