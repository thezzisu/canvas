export type ProgramStatus =
  "error" | "attention" | "working" | "done" | "idle" | "unknown";
export type StatusSource = "herdr" | "osc9" | "osc7501" | "none";
export interface StatusDetails {
  status: ProgramStatus;
  statusSource: StatusSource;
  nativeStatus?: string;
  progress?: number;
}
export interface PaneResource extends StatusDetails {
  id: string;
  name: string;
  active: boolean;
  agent?: string;
}

const priority: Record<ProgramStatus, number> = {
  error: 5,
  attention: 4,
  working: 3,
  done: 2,
  idle: 1,
  unknown: 0,
};

/** Attention in any pane remains visible even when another pane is active. */
export function aggregateStatus(
  panes: readonly StatusDetails[],
): StatusDetails {
  return panes.reduce<StatusDetails>(
    (result, pane) =>
      priority[pane.status] > priority[result.status]
        ? { status: pane.status, statusSource: pane.statusSource }
        : result,
    { status: "unknown", statusSource: "none" },
  );
}

export function herdrStatus(native: unknown): StatusDetails {
  const status: ProgramStatus =
    native === "blocked"
      ? "attention"
      : native === "working" || native === "done" || native === "idle"
        ? native
        : "unknown";
  return {
    status,
    statusSource: "herdr",
    ...(typeof native === "string" ? { nativeStatus: native } : {}),
  };
}

/** OSC 9;4 is task progress, not an agent-idle protocol. Hidden proves no state. */
export function tmuxProgressStatus(
  native: string | undefined,
  progress: string | undefined,
): StatusDetails {
  const status: ProgramStatus =
    native === "normal" || native === "indeterminate"
      ? "working"
      : native === "error"
        ? "error"
        : native === "paused"
          ? "attention"
          : "unknown";
  const value = progress ? Number(progress) : Number.NaN;
  return {
    status,
    statusSource: status === "unknown" ? "none" : "osc9",
    ...(native ? { nativeStatus: native } : {}),
    ...(status !== "unknown" &&
    native !== "indeterminate" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
      ? { progress: value }
      : {}),
  };
}
