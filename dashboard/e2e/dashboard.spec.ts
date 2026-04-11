import { test, expect } from "@playwright/test";

test.describe("Airchive dashboard", () => {
  test("loads the home dashboard with fleet and blockchain sections and a clean console", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/websocket|ws:\/\//i.test(text)) return;
      consoleErrors.push(text);
    });

    await page.goto("/", { waitUntil: "load", timeout: 120_000 });

    await expect(page).toHaveTitle(/Airchive/i);

    await expect(
      page.getByRole("heading", { name: /fleet status/i }),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: /blockchain feed/i }),
    ).toBeVisible();

    expect(
      consoleErrors,
      `Unexpected console errors: ${consoleErrors.join("\n")}`,
    ).toEqual([]);
  });
});
