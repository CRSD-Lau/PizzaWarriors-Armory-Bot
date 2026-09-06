import type { Browser } from "playwright";

/** Every card owns one short-lived context, including when page creation fails. */
export async function screenshotCard(browser: Browser, html: string, viewport: { width: number; height: number }): Promise<Buffer> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 3 });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });
    // Slow or unavailable third-party icons must not prevent an otherwise usable card.
    await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), undefined, { timeout: 8_000 })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      });
    return await page.locator(".card").screenshot({ type: "png", timeout: 15_000 });
  } finally {
    await context.close().catch(() => undefined);
  }
}
