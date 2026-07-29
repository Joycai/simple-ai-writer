/**
 * Workspace profiles — the per-project declaration of *what kind of writing*
 * this project is (see ./model). Import from here; the split is only about
 * dependencies: ./model and ./active are pure, ./store touches the filesystem.
 */

export * from "./model";
export * from "./active";
export * from "./store";
