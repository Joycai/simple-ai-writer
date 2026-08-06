/**
 * What a picture is being generated *for*.
 *
 * The modal that drives generation is the same everywhere — two models, a
 * drafted prompt, candidates, an edit chain. What differs is where the source
 * material comes from and where a kept image ends up: a lore entity reads its
 * own facets and files the result in its gallery; a manuscript document reads
 * the passage being illustrated and files the result in `assets/` with a
 * markdown link at the cursor.
 *
 * Expressing that as a descriptor rather than a branch is what lets a 公众号
 * or 标书 project illustrate a document without the image UI knowing those
 * domains exist.
 */

import type { ReactNode } from "react";

/** One kept image, on its way to wherever the target files it. */
export interface SaveInput {
  bytes: Uint8Array;
  /** File extension without the dot, derived from the image's mime type. */
  ext: string;
  /** The same image as a data URL, for targets that need to show it to a model. */
  dataUrl: string;
  /**
   * One line describing what the picture shows, from the prompt spec. Used as
   * alt text, and as the starting description where the target keeps one.
   */
  note: string;
}

export interface SaveAction {
  label: string;
  run: (img: SaveInput) => Promise<string>;
}

export interface ImageGenTarget {
  /** Identity of the thing being illustrated; changing it resets the modal. */
  key: string;
  /** What the picture is of — feeds the prompt writer and titles the modal. */
  subject: string;
  /** The subject's kind (角色 / 场景 / 文档), which sets the brief's register. */
  subjectKind?: string;
  /**
   * Source text the prompt must be faithful to. Async because a target may
   * read files to assemble it, and lazy because that read should happen when
   * the author asks for a prompt, not when the modal opens.
   */
  material: () => Promise<string>;
  /**
   * Descriptions of pictures that already exist of this subject. What keeps a
   * second portrait recognisably the same character.
   */
  references: string[];
  /**
   * File a kept image. `run` returns the saved path, for the generation
   * record. The label is the target's own wording — 存入图集 and 插入文档 are
   * different enough acts that one shared string would be wrong for both.
   */
  save: SaveAction;
  /** A second way to file it, when the target has one (lore: set as avatar). */
  altSave?: SaveAction & {
    /** Close after this one — an avatar replaces rather than accumulates. */
    closeAfter?: boolean;
  };
  /** Extra controls between the direction box and the prompt (lore: facets). */
  extras?: ReactNode;
}
