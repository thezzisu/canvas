import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStatus, herdrStatus, statusPriority, type ProgramStatus } from "./status.ts";

test("herdr status preserves completion and maps blocked panes to attention", () => {
  assert.equal(herdrStatus("done"), "done");
  assert.equal(herdrStatus("blocked"), "attention");
  assert.equal(herdrStatus("working"), "working");
  assert.equal(herdrStatus("idle"), "idle");
  assert.equal(herdrStatus("future-status"), "unknown");
  assert.equal(herdrStatus(undefined), "unknown");
  assert.equal(herdrStatus("error"), "unknown", "herdr does not report an error agent state");
});

test("every pane contributes to window status independently of pane order", () => {
  const panes = ["idle", "done", "working", "blocked"].map(herdrStatus);
  assert.equal(aggregateStatus(panes), "attention");
  assert.equal(aggregateStatus(panes.toReversed()), aggregateStatus(panes));
  assert.equal(aggregateStatus(panes.slice(0, 3)), "done");
  assert.equal(aggregateStatus(panes.slice(0, 2)), "done");
  assert.equal(aggregateStatus(["working", "idle", "unknown"]), "working");
  assert.equal(aggregateStatus(["idle", "unknown"]), "idle");
  assert.equal(aggregateStatus([]), "unknown");
});

test("sorting priority and pane aggregation share one complete ordering", () => {
  const order: ProgramStatus[] = ["error", "attention", "done", "working", "idle", "unknown"];
  assert.deepEqual(order.toReversed().sort((a, b) => statusPriority[b] - statusPriority[a]), order);
  for (let higher = 0; higher < order.length; higher++) {
    for (let lower = higher; lower < order.length; lower++) {
      assert.equal(aggregateStatus([order[higher]!, order[lower]!]), order[higher]);
      assert.equal(aggregateStatus([order[lower]!, order[higher]!]), order[higher]);
    }
  }
});
