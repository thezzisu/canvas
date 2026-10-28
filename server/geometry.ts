import type { NativeSize, TerminalCommand } from "./providers.ts";
import { NativeGeometryConflictError } from "./providers.ts";

export type Size = { cols: number; rows: number };
export type FocusGeometry = {
  type: "focus-resize";
  token?: string;
  active: boolean;
  owned: boolean;
  reason?: "external-resize" | "superseded" | "ended" | "unavailable";
};
interface Lease<Owner> {
  owner: Owner;
  token: string;
  baseline: NativeSize;
  last: NativeSize;
  pending?: Size;
  unavailable?: boolean;
}

/** Serializes temporary geometry changes at the one native window boundary. */
export class GeometryController<Owner extends object> {
  current: NativeSize;
  private lease?: Lease<Owner>;
  private requested = new Map<Owner, string>();
  private updates = new Map<Owner, { token: string; size: Size }>();
  private pendingResize?: { owner: Owner; size: Size };
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private polling = false;
  constructor(
    readonly provider: TerminalCommand,
    initial: NativeSize,
    readonly apply: (size: NativeSize) => void,
    readonly notify: (
      lease: { owner: Owner; token: string } | undefined,
      reason?: FocusGeometry["reason"],
    ) => void,
    readonly failure: (owner: Owner | undefined, error: unknown) => void,
  ) {
    this.current = initial;
  }

  private enqueue(action: () => Promise<void>) {
    const next = this.queue.then(action);
    this.queue = next.catch((error) => this.failure(undefined, error));
    return next;
  }
  private adopt(size: NativeSize) {
    this.current = size;
    this.apply(size);
  }
  private async releaseOwnership(reason: FocusGeometry["reason"]) {
    if (this.lease && this.requested.get(this.lease.owner) === this.lease.token)
      this.requested.delete(this.lease.owner);
    this.lease = undefined;
    try {
      await this.provider.commitSize?.();
    } finally {
      this.notify(undefined, reason);
    }
  }
  private async read(fresh = true) {
    const current = (await this.provider.readSize?.(fresh)) ?? this.current;
    if (this.lease && current.token !== this.lease.last.token) {
      if (current.recoveredFromToken === this.lease.last.token) {
        // Only a native write receipt can attribute a lost response to us.
        this.lease.last = current;
        this.lease.pending = undefined;
        this.lease.unavailable = false;
        if (this.requested.get(this.lease.owner) === this.lease.token)
          this.notify(this.lease, "superseded");
      } else await this.releaseOwnership("external-resize");
    }
    this.adopt(current);
    return current;
  }
  private async writeLease(lease: Lease<Owner>, size: Size) {
    lease.pending = size;
    try {
      const changed =
        size.cols === lease.last.cols && size.rows === lease.last.rows
          ? lease.last
          : await this.provider.resize!(size.cols, size.rows, lease.last.token);
      lease.last = changed;
      lease.pending = undefined;
      lease.unavailable = false;
      this.adopt(changed);
      this.notify(lease, "superseded");
    } catch (error) {
      if (error instanceof NativeGeometryConflictError)
        await this.releaseOwnership("external-resize");
      else {
        // A transport failure does not prove whether the native write applied.
        // Keep its baseline until a receipt or an external revision resolves it.
        lease.unavailable = true;
        this.notify(lease, "unavailable");
      }
      this.failure(lease.owner, error);
      await this.read(true).catch(() => {});
    }
  }
  poll() {
    if (this.stopped || this.polling || !this.provider.readSize) return;
    this.polling = true;
    void this.enqueue(async () => {
      if (this.stopped) return;
      await this.read(false);
      // A disconnect can arrive during a short transport outage. Retry its
      // conditional restore once native reads recover, while respecting CAS.
      if (this.lease && !this.requested.has(this.lease.owner))
        await this.restore();
      else if (this.lease?.unavailable && this.lease.pending)
        await this.writeLease(this.lease, this.lease.pending);
    })
      .catch(() => {})
      .finally(() => {
        this.polling = false;
      });
  }
  begin(owner: Owner, token: string, size: Size) {
    if (this.stopped) return;
    this.requested.set(owner, token);
    void this.enqueue(async () => {
      if (this.stopped || this.requested.get(owner) !== token) return;
      if (
        !this.provider.resize ||
        !this.provider.readSize ||
        !this.provider.restoreSize
      ) {
        this.requested.delete(owner);
        this.notify(undefined, "unavailable");
        return;
      }
      let current: NativeSize;
      try {
        current = await this.read();
      } catch (error) {
        if (this.requested.get(owner) === token) this.requested.delete(owner);
        this.notify(this.lease, "unavailable");
        this.failure(owner, error);
        return;
      }
      if (this.requested.get(owner) !== token) return;
      const previous = this.lease;
      const baseline = previous?.baseline ?? current;
      if (previous && previous.owner !== owner)
        this.requested.delete(previous.owner);
      const lease = { owner, token, baseline, last: current };
      this.lease = lease;
      await this.writeLease(lease, size);
    }).catch(() => {});
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
    void this.enqueue(async () => {
      if (this.updates.get(owner) !== pending) return;
      this.updates.delete(owner);
      const { token, size } = pending;
      if (this.stopped || this.requested.get(owner) !== token) return;
      try {
        await this.read();
      } catch (error) {
        const lease = this.lease;
        if (lease?.owner === owner && lease.token === token) {
          lease.pending = size;
          lease.unavailable = true;
          this.notify(lease, "unavailable");
          this.failure(owner, error);
        }
        return;
      }
      const lease = this.lease;
      if (!lease || lease.owner !== owner || lease.token !== token) return;
      if (size.cols === this.current.cols && size.rows === this.current.rows)
        return;
      await this.writeLease(lease, size);
    }).catch(() => {});
  }
  end(owner: Owner, token?: string) {
    if (token && this.requested.get(owner) !== token) return Promise.resolve();
    this.requested.delete(owner);
    return this.enqueue(async () => {
      if (this.lease?.owner !== owner || (token && this.lease.token !== token))
        return;
      await this.restore();
    }).catch(() => {});
  }
  private async restore() {
    await this.read();
    const lease = this.lease;
    if (!lease) return;
    const unchanged =
      this.current.cols === lease.baseline.cols &&
      this.current.rows === lease.baseline.rows &&
      this.current.policy === lease.baseline.policy &&
      this.current.effectivePolicy === lease.baseline.effectivePolicy;
    const restored = unchanged
      ? this.current
      : await this.provider.restoreSize!(
          lease.baseline,
          lease.last.token,
          async (size) => this.apply(size),
        );
    this.adopt(restored);
    if (this.requested.get(lease.owner) === lease.token)
      this.requested.delete(lease.owner);
    this.lease = undefined;
    await this.provider.commitSize?.();
    this.notify(undefined, "ended");
  }
  persistent(owner: Owner, size: Size) {
    if (this.stopped) return;
    const scheduled = !!this.pendingResize;
    this.pendingResize = { owner, size };
    if (scheduled) return;
    void this.enqueue(async () => {
      const pending = this.pendingResize;
      this.pendingResize = undefined;
      if (!pending) return;
      const { owner, size } = pending;
      if (this.stopped) return;
      const current = await this.read();
      if (this.lease) await this.releaseOwnership("superseded");
      if (!this.provider.resize) return;
      try {
        const changed = await this.provider.resize(
          size.cols,
          size.rows,
          current.token,
        );
        await this.provider.commitSize?.();
        this.adopt(changed);
      } catch (error) {
        // An explicit card resize is lasting even if its acknowledgment is lost.
        // Do not leave the provider's temporary fallback restore armed.
        await this.provider.commitSize?.().catch(() => {});
        this.adopt((await this.provider.readSize?.(true)) ?? this.current);
        this.failure(owner, error);
      }
    }).catch(() => {});
  }
  state(owner: Owner): FocusGeometry {
    return {
      type: "focus-resize",
      active: !!this.lease,
      owned: this.lease?.owner === owner && !this.lease.unavailable,
      ...(this.lease ? { token: this.lease.token } : {}),
    };
  }
  async drain() {
    await this.queue;
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.requested.clear();
    this.updates.clear();
    this.pendingResize = undefined;
    await this.enqueue(async () => {
      if (this.lease) await this.restore();
    }).catch(() => {});
  }
}
