/**
 * Child UI bridge tests: dialog activity is observable, dialogs stay
 * serialized, and disposal closes the Waiting state. Chrome writes must stay
 * no-ops so the child can never repaint the parent composer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createChildUiBridge } from "./orchestrator-child-ui.ts";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

test("a forwarded dialog publishes Waiting while it is open", async () => {
  const answer = deferred<boolean>();
  const activity: boolean[] = [];
  const bridge = createChildUiBridge(
    {
      async confirm() {
        return answer.promise;
      },
    },
    { ref: "2", total: 7 },
    { onDialogActivity: (active) => activity.push(active) },
  );

  const pending = (bridge.uiContext.confirm as Function)("Allow?", "write");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(activity, [true]);
  assert.equal(bridge.activeDialogs, 1);

  answer.resolve(true);
  assert.equal(await pending, true);
  assert.deepEqual(activity, [true, false]);
  assert.equal(bridge.activeDialogs, 0);
});

test("dialog activity closes on a rejected/denied dialog", async () => {
  const activity: boolean[] = [];
  const bridge = createChildUiBridge(
    {
      async confirm() {
        throw new Error("host refused");
      },
    },
    { ref: "1", total: 1 },
    { onDialogActivity: (active) => activity.push(active) },
  );
  const result = await (bridge.uiContext.confirm as Function)("Allow?", "edit");
  assert.equal(result, false);
  assert.deepEqual(activity, [true, false]);
});

test("dispose closes an open dialog activity once", async () => {
  const answer = deferred<boolean>();
  const activity: boolean[] = [];
  const bridge = createChildUiBridge(
    {
      async confirm() {
        return answer.promise;
      },
    },
    { ref: "1", total: 1 },
    { onDialogActivity: (active) => activity.push(active) },
  );
  const pending = (bridge.uiContext.confirm as Function)("Allow?", "write");
  await Promise.resolve();
  await Promise.resolve();
  bridge.dispose();
  assert.deepEqual(activity, [true, false]);
  answer.resolve(true);
  await pending;
  assert.deepEqual(activity, [true, false], "no duplicate close event");
});

test("chrome writes stay no-ops", () => {
  const bridge = createChildUiBridge({}, { ref: "1", total: 1 });
  const ui = bridge.uiContext;
  assert.doesNotThrow(() => {
    (ui.setStatus as Function)("k", "v");
    (ui.setWidget as Function)("k", []);
    (ui.setWorkingMessage as Function)("Working");
    (ui.setWorkingVisible as Function)(true);
    (ui.setFooter as Function)(() => undefined);
  });
});
