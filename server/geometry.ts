export type Size = { cols: number; rows: number };
export type FocusGeometry = {
  type: "focus-resize";
  token?: string;
  active: boolean;
  owned: boolean;
  reason?: "superseded" | "ended";
};
interface Lease<Owner> {
  owner: Owner;
  token: string;
  baseline: Size;
}

/** Owns the Canvas client's viewport; herdr arbitrates native pane dimensions. */
export class GeometryController<Owner extends object> {
  current: Size;
  private lease?: Lease<Owner>;
  private requested = new Map<Owner, string>();
  private updates = new Map<Owner, { token: string; size: Size }>();
  private pendingResize?: Size;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    initial: Size,
    readonly apply: (size: Size) => void,
    readonly notify: (reason?: FocusGeometry["reason"]) => void,
    readonly failure: (error: unknown) => void,
  ) {
    this.current = initial;
  }

  private enqueue(action: () => void) {
    this.queue = this.queue.then(action).catch(error => this.failure(error));
    return this.queue;
  }
  private adopt(size: Size) {
    if (size.cols === this.current.cols && size.rows === this.current.rows) return;
    this.apply(size);
    this.current = size;
  }
  begin(owner: Owner, token: string, size: Size) {
    if (this.stopped) return;
    this.requested.set(owner, token);
    void this.enqueue(() => {
      if (this.stopped || this.requested.get(owner) !== token) return;
      const previous = this.lease;
      const baseline = previous?.baseline ?? this.current;
      this.adopt(size);
      if (previous && previous.owner !== owner) this.requested.delete(previous.owner);
      this.lease = { owner, token, baseline };
      this.notify("superseded");
    });
  }
  update(owner: Owner, token: string, size: Size) {
    if (this.stopped || this.requested.get(owner) !== token) return;
    const previous = this.updates.get(owner);
    if (previous?.token === token) {
      previous.size = size;
      return;
    }
    const pending = { token, size };
    this.updates.set(owner, pending);
    void this.enqueue(() => {
      if (this.updates.get(owner) !== pending) return;
      this.updates.delete(owner);
      if (this.stopped || this.requested.get(owner) !== token ||
          this.lease?.owner !== owner || this.lease.token !== token) return;
      this.adopt(pending.size);
    });
  }
  end(owner: Owner, token?: string) {
    if (token && this.requested.get(owner) !== token) return Promise.resolve();
    this.requested.delete(owner);
    return this.enqueue(() => {
      if (this.lease?.owner === owner && (!token || this.lease.token === token)) this.restore();
    });
  }
  private restore() {
    const lease = this.lease;
    if (!lease) return;
    try {
      this.adopt(lease.baseline);
    } finally {
      if (this.requested.get(lease.owner) === lease.token) this.requested.delete(lease.owner);
      this.lease = undefined;
      this.notify("ended");
    }
  }
  persistent(size: Size) {
    if (this.stopped) return;
    const scheduled = !!this.pendingResize;
    this.pendingResize = size;
    if (scheduled) return;
    void this.enqueue(() => {
      const pending = this.pendingResize;
      this.pendingResize = undefined;
      if (this.stopped || !pending) return;
      // Card changes become the restore size while a maximized view is active.
      if (this.lease) this.lease.baseline = pending;
      else this.adopt(pending);
    });
  }
  state(owner: Owner): FocusGeometry {
    return {
      type: "focus-resize",
      active: !!this.lease,
      owned: this.lease?.owner === owner,
      ...(this.lease ? { token: this.lease.token } : {}),
    };
  }
  async drain() { await this.queue; }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.requested.clear();
    this.updates.clear();
    this.pendingResize = undefined;
    await this.enqueue(() => this.restore());
  }
}
