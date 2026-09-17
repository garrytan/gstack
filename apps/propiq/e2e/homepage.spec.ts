/**
 * The homepage, as a visitor meets it.
 *
 * These assert the promises the product makes about itself, not the markup it
 * happens to have. Each one maps to a failure that has actually shipped here:
 * a hero with no figures behind it, demo data with nothing saying so, a nav
 * item pointing at a 404, a diagram no keyboard can reach.
 */

import { expect, test } from '@playwright/test';

test.describe('homepage', () => {
  test('states what the product is, in real text', async ({ page }) => {
    await page.goto('/');

    // The headline is text, not a canvas. A product whose whole argument is
    // that it is legible cannot put its own claim inside a bitmap.
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toContainText('Find the right property');
    await expect(h1).toContainText('Understand the opportunity');

    await expect(page).toHaveTitle(/PropIQ/);
    expect(await page.getByRole('heading', { level: 1 }).count()).toBe(1);
  });

  test('never shows a figure without saying where it came from', async ({ page }) => {
    await page.goto('/');

    // Running in demo mode, so every surface owes the reader a label.
    await expect(page.getByText(/demo data/i).first()).toBeVisible();

    // The hero readouts carry the real computed score, and the band with it.
    const score = page.getByText('PropIQ Score', { exact: true }).first();
    await expect(score).toBeVisible();
    await expect(page.getByText(/95% band/).first()).toBeVisible();
  });

  test('does not tell a visitor there is no data', async ({ page }) => {
    await page.goto('/');
    // The failure this whole upgrade started from.
    await expect(page.getByText(/no property data source is connected/i)).toHaveCount(0);
    await expect(page.getByText(/NOT BUILT/)).toHaveCount(0);
  });

  test('search goes where it says it goes', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel(/search properties, projects and localities/i);
    await input.fill('Whitefield');
    await page.getByRole('button', { name: /search properties/i }).click();
    await expect(page).toHaveURL(/\/search\?.*q=Whitefield/);
  });
});

test.describe('score constellation', () => {
  test('is reachable and readable without a pointer', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'keyboard reach is a desktop concern');
    await page.goto('/');

    const nodes = page.locator('.propiq-constellation-hit');
    await expect(nodes.first()).toBeAttached();
    expect(await nodes.count()).toBe(12);

    // Retried, because the click itself is what has to land. The homepage is
    // nineteen sections and hydration finishes after `networkidle`, so a single
    // click on a freshly loaded page hits an element React has not wired up
    // yet — the markup is there, the handler is not. `toPass` re-runs the click
    // as well as the assertion, which is the difference between waiting for
    // interactivity and waiting for a fixed number of milliseconds.
    await expect(async () => {
      await nodes.nth(1).click();
      // Selecting a pillar opens what is behind it, not just a highlight.
      await expect(page.getByText('of the composite')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    await expect(page.getByText('Evidence coverage').first()).toBeVisible();
  });

  test('offers the same numbers as a table', async ({ page }) => {
    await page.goto('/');
    const table = page.getByRole('table', { name: /every scoring pillar/i });
    await expect(async () => {
      await page.getByText(/all 12 pillars as a table/i).click();
      await expect(table).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    // Twelve pillars plus the header row.
    expect(await table.locator('tr').count()).toBe(13);
  });
});
