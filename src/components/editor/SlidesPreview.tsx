import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeckDiagnostic } from '../../lib/pptx/native/diagnostics';
import { parseDeckSpec } from '../../lib/pptx/native/validate';
import { resolveDeck, type ResolvedDeck } from '../../lib/pptx/native/resolve';
import { nativeEnvironment } from '../../lib/pptx/native/environment';
import { applyNativePptx, prepareNativePptx, releaseNativePptx, type NativePptxReceipt } from '../../lib/pptx/native/approval';
import { isPptxExportEnabled } from '../../lib/pptx/flag';
import { resolveWorkspacePath } from '../../lib/paths';
import { flushIfOpen } from '../../stores/openDocument';
import { useEditorStore } from '../../stores/editorStore';
import { useProjectStore } from '../../stores/projectStore';
import { NativeSlideView } from './NativeSlideView';
import styles from './SlidesPreview.module.css';

export default function SlidesPreview({ source, filePath, projectPath }: { source: string; filePath: string; projectPath: string }) {
  const { t } = useTranslation();
  const describe = (items: DeckDiagnostic[]) => items.slice(0, 20).map(d => `${d.slideId ?? ''} ${d.path || '/'} · ${d.code}: ${t(`editor.nativeSlides.diagnostics.${d.code}`)}`).join('\n');
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ source: string; revision: number; deck?: ResolvedDeck; error?: string }>();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<NativePptxReceipt>();
  const [message, setMessage] = useState('');
  const pending = useRef<NativePptxReceipt | undefined>(undefined);
  const operation = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const target = filePath.replace(/\.slides\.json$/i, '.pptx');
  const discard = () => { if (pending.current) releaseNativePptx(pending.current.artifactId); pending.current = undefined; setReceipt(undefined); };
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); if (pending.current) releaseNativePptx(pending.current.artifactId); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    discard(); setMessage('');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const parsed = parseDeckSpec(source);
          if (!parsed.ok) throw new Error(describe(parsed.diagnostics));
          const unsafe = parsed.value.assets.find(a => !resolveWorkspacePath(projectPath, a.path));
          if (unsafe) throw new Error(describe([{ code: 'unsafe_path', path: '/assets' }]));
          const resolved = await resolveDeck(parsed.value, nativeEnvironment(projectPath));
          if (!resolved.ok) throw new Error(describe(resolved.diagnostics));
          if (!cancelled) setResult({ source, revision, deck: resolved.value });
        } catch (error) {
          if (!cancelled) setResult({ source, revision, error: String(error) });
        }
      })();
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [source, projectPath, revision, t]);
  const current = result?.source === source && result.revision === revision ? result : undefined;
  const deck = current?.deck;
  const page = deck ? Math.min(index, deck.slides.length - 1) : 0;
  const enabled = isPptxExportEnabled();
  const run = async (write: boolean) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setMessage('');
    const signal = lifetime.current!.signal;
    try {
      if (!isPptxExportEnabled()) throw new Error(t('editor.nativeSlides.disabled'));
      const check = () => {
        signal.throwIfAborted();
        const editor = useEditorStore.getState();
        const project = useProjectStore.getState();
        if (project.projectPath !== projectPath || project.activeFilePath !== filePath || editor.filePath !== filePath || editor.content !== source)
          throw new Error(t('editor.nativeSlides.changed'));
      };
      check(); await flushIfOpen(filePath); check();
      if (write && pending.current) {
        const backup = await applyNativePptx(projectPath, filePath, target, pending.current, signal);
        discard();
        await useProjectStore.getState().refreshFileTree();
        if (!signal.aborted) setMessage(t('editor.nativeSlides.done', { path: target }) + (backup ? `\n${t('editor.nativeSlides.backup', { path: backup })}` : ''));
      } else {
        discard();
        const prepared = await prepareNativePptx(projectPath, filePath, target, source);
        if (!prepared.ok) throw new Error(describe(prepared.diagnostics));
        try { check(); } catch (error) { releaseNativePptx(prepared.receipt.artifactId); throw error; }
        pending.current = prepared.receipt; setReceipt(prepared.receipt);
        // External image edits may have happened since the last preview. Review
        // the exact immutable graph serialized into these prepared bytes.
        setResult({ source, revision, deck: prepared.deck });
      }
    } catch (error) {
      discard(); if (!signal.aborted) setMessage(String(error));
    } finally { operation.current = false; if (!signal.aborted) setBusy(false); }
  };
  return <div className={styles.wrap}>
    <div className={styles.bar}>
      <button className={styles.button} disabled={busy} onClick={() => setRevision(r => r + 1)}>{t('editor.htmlPreview.refresh')}</button>
      {enabled && <button className={styles.button} disabled={busy || !deck || !!receipt} onClick={() => void run(false)}>{t(busy ? 'editor.htmlPreview.pptxBusy' : 'editor.htmlPreview.exportPptx')}</button>}
    </div>
    <p className={styles.note}>{t('editor.nativeSlides.approximate')}</p>
    {deck && <p className={styles.note}>{t('editor.nativeSlides.fonts', { ...deck.fonts })}</p>}
    {!enabled && <p className={styles.note}>{t('editor.nativeSlides.disabled')}</p>}
    {receipt && <div className={styles.review}>
      <p className={styles.note}>{t('editor.nativeSlides.review', { count: receipt.slides, theme: receipt.theme, path: target })}</p>
      <p className={styles.note}>{t('editor.nativeSlides.fonts', receipt.fonts)}</p>
      <p className={styles.note}>{t(receipt.targetHash === null ? 'editor.nativeSlides.create' : 'editor.nativeSlides.overwrite')}</p>
      <div className={styles.bar}>
        <button className={styles.button} disabled={busy || !enabled} onClick={() => void run(true)}>{t('editor.nativeSlides.confirm')}</button>
        <button className={styles.button} disabled={busy} onClick={discard}>{t('common.cancel')}</button>
      </div>
    </div>}
    {message && <p role="status" className={styles.note}>{message}</p>}
    {current?.error && <p role="alert" className={styles.error}>{current.error}</p>}
    {!current && <p role="status" className={styles.note}>{t('editor.nativeSlides.loading')}</p>}
    {deck && <>
      <nav className={styles.bar} aria-label={t('editor.nativeSlides.navigation')}>
        <button className={styles.button} disabled={page === 0} onClick={() => setIndex(page - 1)} aria-label={t('editor.nativeSlides.previous')}>←</button>
        <span>{page + 1} / {deck.slides.length}</span>
        <button className={styles.button} disabled={page === deck.slides.length - 1} onClick={() => setIndex(page + 1)} aria-label={t('editor.nativeSlides.next')}>→</button>
      </nav>
      <div className={styles.slide}><NativeSlideView deck={deck} index={page} /></div>
      {deck.slides[page].notes && <details className={styles.notes}><summary>{t('editor.nativeSlides.notes')}</summary>{deck.slides[page].notes}</details>}
    </>}
  </div>;
}
