import assert from "node:assert/strict";
import { isRecoverableBrowserError } from "../src/browser-recovery.js";

assert.equal(isRecoverableBrowserError(new Error("browserContext.newPage: Target crashed")), true);
assert.equal(isRecoverableBrowserError(new Error("Target page, context or browser has been closed")), true);
assert.equal(isRecoverableBrowserError(new Error("Warmane returned 429")), false);
assert.equal(isRecoverableBrowserError(new Error("No equipped items were found")), false);

console.log("browser recovery tests passed");
