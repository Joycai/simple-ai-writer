import { useRef } from "react";
import styles from "./ResizeHandle.module.css";

interface Props {
  onDelta: (delta: number) => void;
}

export function ResizeHandle({ onDelta }: Props) {
  const dragging = useRef(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    let prevX = e.clientX;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      onDelta(ev.clientX - prevX);
      prevX = ev.clientX;
    };

    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return <div className={styles.handle} onMouseDown={handleMouseDown} />;
}
