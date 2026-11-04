/** Transport gate. UI/persistence are injected at boot to keep HTTP below prefs/i18n. */
import { requiresPrivacyConsent } from "../distribution";

const NOTICE_VERSION = 1;
export type PrivacyPurpose = "ai" | "probe" | "retrieval" | "audio" | "mcp" | "sync" | "backup" | "fonts";
interface Recipient { endpoint: string; scope: string; purpose: PrivacyPurpose; key: string }
export interface Decision { version: number; allowed: boolean; at: string; epoch: string }
export interface ConsentState { epoch: string; paused: boolean; decision?: Decision }
export interface ConsentAdapter {
  read(key: string): Promise<ConsentState>;
  save(key: string, decision: Decision): Promise<void>;
  ask(recipient: Recipient): Promise<boolean>;
  errorText?(code: string): string;
}
let adapter: ConsentAdapter | undefined;
const pending = new Map<string, Promise<void>>();
const active = new Set<AbortController>();
let revision = 0;
let suspended = false;

export function installConsentAdapter(value: ConsentAdapter): void { adapter = value; }
export function setPrivacySessionPaused(paused: boolean): void {
  suspended = paused;
  revision++;
  for (const controller of active) controller.abort();
}
export function recipientOf(raw: string, purpose: PrivacyPurpose): Recipient {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("PRIVACY_INVALID_ENDPOINT");
  // Never persist query credentials, fragments or bodies. Exact path is deliberately conservative.
  const endpoint = url.origin + url.pathname;
  let path = url.pathname;
  if (purpose === "fonts") path = "/"; // Pinned public font assets; never project data.
  if (purpose === "sync") path = path.replace(/\/v1\/kbs(?:\/.*)?$/, "/v1/kbs");
  if (purpose === "backup") path = path.replace(/\/v1\/configs(?:\/.*)?$/, "/v1/configs");
  if (purpose === "ai" || purpose === "audio" || purpose === "probe") {
    path = path.replace(/(\/models\/)[^/]+(:[^/:]+)$/, "$1{model}$2")
      .replace(/(\/tasks\/)[^/]+$/, "$1{task}")
      .replace(/(\/history\/)[^/]+$/, "$1{task}");
  }
  const scope = url.origin + path;
  return { endpoint, scope, purpose, key: JSON.stringify([NOTICE_VERSION, purpose, scope]) };
}
function allowed(state: ConsentState): boolean {
  return !state.paused && state.decision?.version === NOTICE_VERSION
    && state.decision.epoch === state.epoch && state.decision.allowed;
}
export function privacyError(code: string): Error {
  return new Error(`${code}: ${adapter?.errorText?.(code) ?? ""}`);
}
function denied(): Error { return privacyError("PRIVACY_CONSENT_REQUIRED"); }

async function authorize(recipient: Recipient): Promise<ConsentState> {
  const store = adapter;
  if (!store || suspended) throw denied();
  let state = await store.read(recipient.key);
  if (allowed(state)) return state;
  if (state.paused || (state.decision?.epoch === state.epoch && state.decision.version === NOTICE_VERSION)) throw denied();
  let work = pending.get(recipient.key);
  if (!work) {
    const startRevision = revision;
    work = (async () => {
      const accepted = await store.ask(recipient);
      const current = await store.read(recipient.key);
      if (revision !== startRevision || current.epoch !== state.epoch || current.paused) throw denied();
      await store.save(recipient.key, { version: NOTICE_VERSION, allowed: accepted,
        at: new Date().toISOString(), epoch: state.epoch });
      if (!accepted) throw denied();
    })().finally(() => pending.delete(recipient.key));
    pending.set(recipient.key, work);
  }
  await work;
  state = await store.read(recipient.key);
  if (!allowed(state)) throw denied();
  return state;
}

/** Lease lasts through body consumption, including SSE. Other processes are re-read, not cached. */
export async function privacyLease(raw: string, purpose: PrivacyPurpose, signal?: AbortSignal | null) {
  if (!requiresPrivacyConsent()) return undefined;
  signal?.throwIfAborted();
  const recipient = recipientOf(raw, purpose);
  const startRevision = revision;
  const state = await authorize(recipient);
  signal?.throwIfAborted();
  if (revision !== startRevision || suspended) throw denied();
  const controller = new AbortController();
  active.add(controller);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void adapter!.read(recipient.key).then((current) => {
      if (!allowed(current) || current.epoch !== state.epoch) controller.abort();
    }).catch(abort).finally(() => { checking = false; });
  }, 500);
  const release = () => {
    clearInterval(timer);
    active.delete(controller);
    signal?.removeEventListener("abort", abort);
  };
  controller.signal.addEventListener("abort", release, { once: true });
  return { signal: controller.signal, release };
}
