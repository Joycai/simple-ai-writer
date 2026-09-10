import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";
import { imageToDataUrl } from "../../lib/fs/images";
import { useProjectStore } from "../../stores/projectStore";
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
  const setImageSize = useProjectStore((s) => s.setImageSize);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(false);
    // The title bar reports this picture's pixel size (设计稿 01e 屏 1d-3) and
    // reads it from the store; clear the previous file's before the new bytes
    // arrive, or the bar shows one image's dimensions under another's name for
    // as long as the read takes.
    setImageSize(null);
    imageToDataUrl(path)
      .then(({ dataUrl }) => { if (!cancelled) setUrl(dataUrl); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path, setImageSize]);

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
          <img
            src={url}
            alt={name}
            className={styles.img}
            onLoad={(e) => {
              const img = e.currentTarget;
              setImageSize({ path, width: img.naturalWidth, height: img.naturalHeight });
            }}
          />
          <figcaption className={styles.caption}>{name}</figcaption>
        </figure>
      ) : (
        <div className={styles.state} />
      )}
    </div>
  );
}
