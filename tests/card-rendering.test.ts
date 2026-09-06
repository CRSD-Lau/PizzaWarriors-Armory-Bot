import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { screenshotCard } from "../src/card-rendering.js";

for (const failure of [undefined, "page", "content", "images", "screenshot", "image-timeout"] as const) {
  let closed = 0;
  let options: unknown;
  const error = new Error(failure);
  if (failure === "image-timeout") error.name = "TimeoutError";
  const browser = { async newContext(value: unknown) {
    options = value;
    return {
      async newPage() {
        if (failure === "page") throw error;
        return {
          async setContent() { if (failure === "content") throw error; },
          async waitForFunction() { if (failure === "images" || failure === "image-timeout") throw error; },
          locator(selector: string) {
            assert.equal(selector, ".card", "only the actual card is captured");
            return { async screenshot() { if (failure === "screenshot") throw error; return Buffer.from("png"); } };
          },
        };
      },
      async close() { closed++; },
    };
  } } as unknown as Browser;
  const render = screenshotCard(browser, "<main class=card>Test</main>", { width: 920, height: 1400 });
  if (failure && failure !== "image-timeout") await assert.rejects(render, (actual) => actual === error);
  else assert.equal((await render).toString(), "png");
  assert.deepEqual(options, { viewport: { width: 920, height: 1400 }, deviceScaleFactor: 3 });
  assert.equal(closed, 1, `context released after ${failure ?? "success"}`);
}
console.log("Card rendering lifecycle tests passed.");
