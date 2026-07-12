import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { imageToDataUrl } from "../../lib/loreGenerator";
import styles from "./ImagePreview.module.css";

interface Props {
  path: string;
}

/**
 * Renders a local image file. Reads the file as a base64 data URL via
 * `imageToDataUrl` — the same path the lore gallery uses — because Webview2's
 * strict URL parsing makes the `ai-writer-asset://` protocol unreliable for
 * Windows drive-letter paths.
 */
export function ImagePreview({ path }: Props) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(false);
    imageToDataUrl(path)
      .then(({ dataUrl }) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path]);

  const name = path.split(/[/\\]/).pop() ?? path;

  return (
    <div className={styles.wrap}>
      {error ? (
        <div className={styles.state}>
          <ImageOff size={26} strokeWidth={1.5} />
          <span>{t("editor.imageLoadError")}</span>
        </div>
      ) : url ? (
        <figure className={styles.figure}>
          <img src={url} alt={name} className={styles.img} />
          <figcaption className={styles.caption}>{name}</figcaption>
        </figure>
      ) : (
        <div className={styles.state} />
      )}
    </div>
  );
}
