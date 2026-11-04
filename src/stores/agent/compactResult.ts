export type CompactResult =
  | { status: "success"; fromTokens: number; toTokens: number }
  | { status: "failed"; message: string }
  | { status: "skipped"; reason: "busy" | "missing" | "nothing" }
  | { status: "cancelled" };

export interface CompactFeedback {
  requestId: number;
  contextVersion: number;
  result?: CompactResult;
}
