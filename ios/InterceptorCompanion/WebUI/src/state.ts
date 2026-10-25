import { emptySnapshot, type Snapshot } from "./types.ts";

export const state: { snapshot: Snapshot } = { snapshot: emptySnapshot() };

export function setSnapshot(next: Snapshot) {
  state.snapshot = next;
}
