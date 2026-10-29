export type ProgramStatus = "error" | "attention" | "done" | "working" | "idle" | "unknown";

export const statusPriority: Readonly<Record<ProgramStatus, number>> = {
  error: 5,
  attention: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

/** A blocked pane or a completed task stays visible beside running work. */
export function aggregateStatus(statuses: readonly ProgramStatus[]): ProgramStatus {
  return statuses.reduce<ProgramStatus>((result, status) =>
    statusPriority[status] > statusPriority[result] ? status : result, "unknown");
}

export function herdrStatus(native: unknown): ProgramStatus {
  return native === "blocked" ? "attention"
    : native === "done" || native === "working" || native === "idle" ? native
      : "unknown";
}
