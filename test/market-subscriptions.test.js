import test from "node:test";
import assert from "node:assert/strict";
import { createMarketSubscriptions } from "../lib/market-subscriptions.js";

test("temporary search subscriptions are shared and released without removing permanent subscriptions", () => {
  const subscriptions = createMarketSubscriptions(["featured"]);
  const first = {};
  const second = {};
  assert.deepEqual(subscriptions.replaceScope(first, ["featured", "one"]), { added: ["one"], removed: [], total: 2 });
  assert.deepEqual(subscriptions.replaceScope(second, ["one", "two"]), { added: ["two"], removed: [], total: 3 });
  assert.deepEqual(subscriptions.addPermanent(["one"]), { added: [], removed: [], total: 3 });
  assert.deepEqual(subscriptions.replaceScope(first, []), { added: [], removed: [], total: 3 });
  assert.deepEqual(subscriptions.replaceScope(second, ["three"]), { added: ["three"], removed: ["two"], total: 3 });
  assert.deepEqual(subscriptions.replaceScope(second, []), { added: [], removed: ["three"], total: 2 });
  assert.deepEqual([...subscriptions.keys()], ["featured", "one"]);
});

test("exceeding the subscription limit leaves existing subscriptions intact", () => {
  const subscriptions = createMarketSubscriptions(["featured"], 2);
  const scope = {};
  subscriptions.replaceScope(scope, ["one"]);
  assert.throws(() => subscriptions.replaceScope(scope, ["two", "three"]), /up to 2/);
  assert.deepEqual([...subscriptions.keys()], ["featured", "one"]);
  assert.throws(() => subscriptions.addPermanent(["two"]), /up to 2/);
  assert.deepEqual(subscriptions.replaceScope(scope, []), { added: [], removed: ["one"], total: 1 });
});
