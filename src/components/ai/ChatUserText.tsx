import { splitMentions } from "../../lib/agent/mentionText";
import { mcpTarget, parseSlash } from "../../lib/agent/slashCommands";
import styles from "./ChatUserText.module.css";

/** Presentation only: keep the stored command and request verbatim for copying. */
export function ChatUserText({ text }: { text: string }) {
  const parsed = parseSlash(text);
  const command = parsed && (parsed.command === "imageGen" || mcpTarget(parsed.command))
    ? `/${parsed.command}` : null;
  const body = command ? text.slice(command.length) : text;
  return <>
    {command && <code className={styles.command}>{command}</code>}
    {splitMentions(body).map((seg, i) =>
      <span key={i} className={seg.kind === "mention" ? styles.mention : undefined}>{seg.text}</span>,
    )}
  </>;
}
