/**
 * The two flows: push this machine's configuration up, pull one down.
 *
 * Both are deliberately thin. Everything that can be got wrong already lives
 * somewhere with a test around it — what a bundle contains (`lib/ai/config-
 * Transfer`), how it is sealed (`./envelope`), what the wire looks like
 * (`./client`) — and this module only puts them in the right order.
 *
 * The order matters in one place: **a restore never applies what it just
 * downloaded.** `preparePull` stops at a parsed, re-validated bundle and hands
 * it back; applying it is a second call the author makes after reading what it
 * says. A merge that overwrites providers, keyring entries and the theme, done
 * from a button the author pressed expecting a download, is the failure the
 * whole preview convention exists to prevent (`lib/sync` says the same thing
 * about a one-way mirror).
 */

import { getVersion } from "@tauri-apps/api/app";
import {
  applyConfigImport,
  buildConfigBundle,
  parseConfigBundle,
  type ConfigBackup,
  type ParsedConfigBundle,
} from "../ai/configTransfer";
import { deviceLabel } from "../sync/local";
import type { Expect } from "../sync/client";
import {
  bundleHasKeys,
  openEnvelope,
  readEnvelopeHeader,
  sealBundle,
  type EnvelopeHeader,
} from "./envelope";
import type { ConfigSyncClient, RemoteSlot } from "./client";

async function appVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "";
  }
}

export interface PushOptions {
  includeKeys: boolean;
  /** null seals in the clear — `sealBundle` refuses that when keys are included. */
  password: string | null;
}

export interface PushResult {
  hash: string;
  header: EnvelopeHeader;
  /** What was actually uploaded, for the confirmation line. */
  counts: EnvelopeHeader["counts"];
}

/**
 * Build → seal → upload.
 *
 * `expect` is the caller's precondition. The store passes the hash it last saw
 * for this slot, so a second machine that pushed in between produces a 412
 * rather than a silent overwrite — the same rail the knowledge-base entries use,
 * for the same reason.
 */
export async function pushConfig(
  client: ConfigSyncClient,
  slotId: string,
  options: PushOptions,
  expect: Expect,
): Promise<PushResult> {
  const bundle: ConfigBackup = await buildConfigBundle(options.includeKeys);
  const sealed = await sealBundle(bundle, {
    device: await deviceLabel(),
    appVersion: await appVersion(),
    password: options.password,
  });
  const hash = await client.upload(slotId, sealed.bytes, sealed.meta, expect);
  return { hash, header: sealed.header, counts: sealed.header.counts };
}

export interface PreparedPull {
  header: EnvelopeHeader;
  /** Re-validated here, not trusted from the envelope's self-reported counts. */
  bundle: ParsedConfigBundle;
}

/**
 * Open a downloaded envelope into something the author can be shown.
 *
 * Split from the download so a password prompt can sit between them: the header
 * is readable without one (`readEnvelopeHeader`), which is what lets a listing
 * say "encrypted, from the laptop, six providers" before anyone types anything.
 *
 * The counts the caller renders must come from `bundle` — the envelope's own
 * `counts` is self-reported and unverifiable once encrypted (see `./envelope`).
 */
export async function preparePull(
  bytes: Uint8Array,
  password: string | null,
  existingProviderIds: string[],
): Promise<PreparedPull> {
  const opened = await openEnvelope(bytes, password);
  return {
    header: opened.header,
    bundle: parseConfigBundle(opened.bundle, existingProviderIds),
  };
}

/** Merge a prepared bundle. Same call the file-import path makes. */
export async function applyPull(prepared: PreparedPull): Promise<void> {
  await applyConfigImport(prepared.bundle);
}

/** Re-exported so the store and the UI read a header without importing two modules. */
export { readEnvelopeHeader, bundleHasKeys };

/** Whether pushing with these options would need a password. */
export async function pushNeedsPassword(includeKeys: boolean): Promise<boolean> {
  if (!includeKeys) return false;
  // "Include keys" is the author's intent; whether any provider actually has one
  // is a fact about their setup. Asking for a password to protect nothing would
  // be a ritual, so the question is answered from the bundle, not the checkbox.
  return bundleHasKeys(await buildConfigBundle(true));
}

/** A slot's display name, falling back to its id. */
export function slotLabel(slot: RemoteSlot): string {
  return slot.name.trim() || slot.id;
}
