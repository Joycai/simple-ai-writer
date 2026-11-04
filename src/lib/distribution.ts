/** The binary owns the channel. Preferences and imported projects never do.
 * Desktop fails closed until boot has read it; browser previews keep their
 * existing UI (routing still requires Tauri before offering a command).
 */
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./platform";

type Distribution = "direct" | "app-store";
let distribution: Distribution | null = IS_TAURI ? null : "direct";
let loading: Promise<void> | undefined;

export function hydrateDistribution(): Promise<void> {
  if (!IS_TAURI) return Promise.resolve();
  return loading ??= invoke<unknown>("distribution_channel").then((value) => {
    if (value !== "direct" && value !== "app-store") throw new Error("Unknown distribution channel");
    distribution = value;
  }).catch((error) => {
    // No fallback to direct: a failed handshake must never enable a shell.
    console.warn("[boot] distribution unavailable; terminal disabled:", error);
  });
}

export function terminalAvailable(): boolean {
  return distribution === "direct";
}

/** Unknown desktop builds must preserve recents on authorization failures too. */
export function requiresFileAuthorization(): boolean {
  return distribution !== "direct";
}

/** Unknown desktop channels cannot send before privacy initialization. */
export function requiresPrivacyConsent(): boolean { return distribution !== "direct"; }

/** First-release product scope; independent of user Beta preferences. */
const STORE_FEATURES = { roleplay: false, sakura: false, comfyui: false };
export function distributionAllows(feature: keyof typeof STORE_FEATURES): boolean {
  return distribution === "direct" || (distribution === "app-store" && STORE_FEATURES[feature]);
}
