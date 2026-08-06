/**
 * React error boundaries — the app's last line of defence against a blank window.
 *
 * Without one, a single bad render anywhere (the real case: a `switch` in
 * configDb.ts returning undefined for an unexpected model type, rendered by the
 * settings dropdown) unmounts the *entire* tree. The author sees an empty window
 * with no message — indistinguishable from the process dying.
 *
 * Two boundaries, from the outside in:
 *   - `AppErrorBoundary` wraps the root (main.tsx). Full-screen recovery panel;
 *     the reliable action is a reload, since whatever state produced the bad
 *     render is usually still there after a bare retry.
 *   - `ModalErrorBoundary` wraps a single dialog's contents. Its recovery action
 *     *closes the dialog*, which genuinely fixes things: the broken surface is
 *     unmounted and the editor underneath keeps running, unsaved buffer intact.
 *
 * Scope, so this isn't mistaken for a global net: boundaries catch errors thrown
 * during render, in lifecycle methods, and in constructors of the subtree below
 * them. They do NOT catch errors thrown in event handlers, in async callbacks
 * (setTimeout, promise rejections), or during SSR. Those don't blank the app
 * either — React lets them reach window.onerror with the tree still mounted — so
 * the blank-window failure mode this file exists for is fully covered.
 */

import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight, Copy, RotateCcw, X } from "lucide-react";
import styles from "./ErrorBoundary.module.css";

/** What a fallback needs in order to explain the failure and offer a way out. */
export interface ErrorFallbackProps {
  error: Error;
  /** React's "the component tree above the throw" trace; empty if unavailable. */
  componentStack: string;
  /** Clear the error and re-render children. Useless if the cause is still in state. */
  reset: () => void;
}

interface BoundaryProps {
  children: ReactNode;
  fallback: (props: ErrorFallbackProps) => ReactNode;
}

interface BoundaryState {
  error: Error | null;
  componentStack: string;
}

/**
 * The mechanism. Deliberately presentation-free: a class component can't use
 * hooks, and every fallback below needs `useTranslation`, so rendering is
 * delegated to a function component passed as `fallback`.
 */
class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The panel shows this too, but the console keeps the original stack object
    // (clickable source frames) that the string trace flattens away.
    console.error("[ErrorBoundary]", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  reset = () => this.setState({ error: null, componentStack: "" });

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return this.props.fallback({ error, componentStack, reset: this.reset });
  }
}

/** Message + component stack, collapsed behind a disclosure. Shared by both panels. */
function ErrorDetails({ error, componentStack }: { error: Error; componentStack: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const report = [
    `${error.name}: ${error.message}`,
    error.stack ?? "",
    componentStack ? `\n${t("errorBoundary.stackLabel")}:${componentStack}` : "",
  ].filter(Boolean).join("\n");

  const copy = () => {
    void navigator.clipboard.writeText(report).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1600); },
      () => { /* clipboard may be blocked — the text is on screen either way */ },
    );
  };

  return (
    <div className={styles.details}>
      <div className={styles.message}>{error.message || String(error)}</div>

      <div className={styles.detailsBar}>
        <button className={styles.disclosure} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t("errorBoundary.details")}
        </button>
        <button className={styles.copyBtn} onClick={copy}>
          <Copy size={12} />
          {copied ? t("errorBoundary.copied") : t("errorBoundary.copy")}
        </button>
      </div>

      {open && (
        <pre className={styles.stack}>
          {error.stack || `${error.name}: ${error.message}`}
          {componentStack && `\n\n${t("errorBoundary.stackLabel")}:${componentStack}`}
        </pre>
      )}
    </div>
  );
}

function AppErrorFallback({ error, componentStack, reset }: ErrorFallbackProps) {
  const { t } = useTranslation();
  return (
    <div className={styles.appOverlay} role="alert">
      <div className={styles.panel}>
        <div className={styles.headline}>
          <span className={styles.icon}><AlertTriangle size={18} /></span>
          <div>
            <div className={styles.title}>{t("errorBoundary.appTitle")}</div>
            <div className={styles.subtitle}>{t("errorBoundary.appBody")}</div>
          </div>
        </div>

        <ErrorDetails error={error} componentStack={componentStack} />

        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={reset}>
            <RotateCcw size={13} />
            {t("errorBoundary.retry")}
          </button>
          <button className={styles.btnPrimary} onClick={() => window.location.reload()}>
            {t("errorBoundary.reload")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Wraps the app root. Anything the tree throws during render lands here instead
 * of tearing the document down to an empty <div id="root">.
 */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary fallback={(p) => <AppErrorFallback {...p} />}>
      {children}
    </ErrorBoundary>
  );
}

function ModalErrorFallback({ error, componentStack, onClose }: ErrorFallbackProps & {
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`${styles.panel} ${styles.modalPanel}`} role="alert">
      <div className={styles.headline}>
        <span className={styles.icon}><AlertTriangle size={18} /></span>
        <div>
          <div className={styles.title}>{t("errorBoundary.modalTitle")}</div>
          <div className={styles.subtitle}>{t("errorBoundary.modalBody")}</div>
        </div>
        <button className={styles.dismiss} onClick={onClose} aria-label={t("common.close")}>
          <X size={15} />
        </button>
      </div>

      <ErrorDetails error={error} componentStack={componentStack} />

      <div className={styles.actions}>
        <button className={styles.btnPrimary} onClick={onClose}>
          {t("errorBoundary.closeDialog")}
        </button>
      </div>
    </div>
  );
}

/**
 * Wraps one dialog's contents. On a crash the overlay stays (so the panel is
 * still centred and the backdrop still masks the app) but the dialog's own body
 * is replaced by this card — and its single action unmounts the whole dialog.
 *
 * `onClose` is the dialog's real close handler, called directly rather than
 * through any unsaved-changes guard: the broken surface can't be trusted to
 * report whether it is dirty, and trapping the author in a crashed dialog is
 * strictly worse than losing edits it probably never captured.
 */
export function ModalErrorBoundary({ children, onClose }: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <ErrorBoundary fallback={(p) => <ModalErrorFallback {...p} onClose={onClose} />}>
      {children}
    </ErrorBoundary>
  );
}
