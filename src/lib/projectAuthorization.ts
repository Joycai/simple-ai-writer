/** UI coordination stays above project.ts: i18n depends on prefs/project DB. */
import { invoke } from "@tauri-apps/api/core";
import { openProjectFolder, registerProjectRoot } from "./project";
import { toPosixPath } from "./paths";

export async function authorizeProjectRoot(path: string): Promise<string | null> {
  try {
    return await registerProjectRoot(path);
  } catch (error) {
    const unsafeMetadata = String(error) === "PROJECT_ACCESS_UNSAFE_METADATA";
    if (!unsafeMetadata && !String(error).startsWith("PROJECT_ACCESS_REQUIRED:")) throw error;
    const [{ ask, message }, { default: i18n }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"), import("../i18n"),
    ]);
    if (unsafeMetadata) {
      await message(i18n.t("project.reauthorizeUnsafeMetadata"), {
        title: i18n.t("project.reauthorizeTitle"), kind: "error",
      });
      return null;
    }
    if (!await ask(i18n.t("project.reauthorizeBody", { path }), {
      title: i18n.t("project.reauthorizeTitle"), kind: "warning",
      okLabel: i18n.t("project.reauthorizeChoose"), cancelLabel: i18n.t("project.lockCancel"),
    })) return null;
    try {
      const picked = await invoke<string | null>("project_reauthorize", {
        path, title: i18n.t("project.reauthorizeTitle"),
      });
      return picked === null ? null : toPosixPath(picked);
    } catch (reason) {
      const key = String(reason) === "PROJECT_ACCESS_UNSAFE_METADATA" ? "reauthorizeUnsafeMetadata"
        : String(reason) === "PROJECT_ACCESS_WRONG_FOLDER" ? "reauthorizeWrongFolder"
        : String(reason) === "PROJECT_ACCESS_MISSING_PROJECT" ? "reauthorizeMissingProject"
        : "reauthorizeFailed";
      await message(i18n.t(`project.${key}`, { path }), {
        title: i18n.t("project.reauthorizeTitle"), kind: "error",
      });
      return null;
    }
  }
}


/** A fresh selection also fails visibly if the OS grant cannot be persisted. */
export async function chooseAuthorizedProjectFolder(): Promise<string | null> {
  try {
    return await openProjectFolder();
  } catch (error) {
    const [{ message }, { default: i18n }] = await Promise.all([
      import("@tauri-apps/plugin-dialog"), import("../i18n"),
    ]);
    const key = String(error) === "PROJECT_ACCESS_UNSAFE_METADATA"
      ? "reauthorizeUnsafeMetadata" : "reauthorizeFailed";
    await message(i18n.t(`project.${key}`), {
      title: i18n.t("project.reauthorizeTitle"), kind: "error",
    });
    return null;
  }
}
