/**
 * Navigation, the palette, and the promise a link makes.
 *
 * `navigation.test.ts` already proves every href resolves to a route file.
 * These prove the route actually answers, and that the menus behave for a
 * keyboard — which the unit test cannot see.
 */

import { expect, test } from '@playwright/test';

/** Every destination in the header model. Kept in sync by the unit test. */
const DESTINATIONS = [
  '/search',
  '/localities',
  '/developers',
  '/compare',
  '/decision-room',
  '/valuation',
  '/document-ai',
  '/methodology',
  '/investment',
  '/tools',
  '/tools/emi',
  '/tools/rental-yield',
  '/tools/carpet-area',
  '/site-visit-checklist',
  '/checks/khata',
  '/research',
  '/data-sources',
  '/about',
  '/pricing',
  '/privacy',
];

test.describe('routes answer', () => {
  for (const path of DESTINATIONS) {
    test(`${path} responds and has one h1`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status(), `${path} should not error`).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    });
  }
});

test.describe('mega menu', () => {
  test('hovering then clicking keeps the menu open', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'the mega menu is a desktop surface');
    await page.goto('/');

    // The regression this pins: hover opened the panel, and the click that
    // naturally follows a hover toggled it shut again.
    const trigger = page.locator('[data-trigger="discover"]');
    await expect(async () => {
      await trigger.hover();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Not anchored: each menu link's accessible name is its label plus its
    // blurb ("Properties Scored, ranked and filterable"), which is the right
    // name to expose — a screen reader gets the same context a sighted reader
    // does — and the wrong thing to match exactly.
    await expect(
      page
        .locator('#nav-discover')
        .getByRole('link', { name: /properties/i })
        .first(),
    ).toBeVisible();

    // And a second click on a pinned menu does close it.
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('opens on click and closes on Escape, returning focus', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'the mega menu is a desktop surface');
    await page.goto('/');

    const trigger = page.locator('[data-trigger="intelligence"]');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Retried until the handler is wired — see the note in homepage.spec.ts.
    await expect(async () => {
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true', { timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    // Scoped to the panel: the footer carries the same label, and an
    // unscoped match is a strict-mode violation rather than a passing test.
    const panel = page.locator('#nav-intelligence');
    await expect(panel.getByRole('link', { name: /price intelligence/i })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });
});

test.describe('command palette', () => {
  test('opens on the shortcut and finds a real locality', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'there is no Cmd-K on a phone');
    await page.goto('/');

    const dialog = page.getByRole('dialog', { name: /search propiq/i });
    await expect(async () => {
      await page.keyboard.press('Control+k');
      await expect(dialog).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });

    await page.keyboard.type('whitef');
    await expect(dialog.getByRole('option').first()).toContainText(/whitefield/i);

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/locality\//);
  });

  test('hands an unmatched query to search rather than a dead end', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'there is no Cmd-K on a phone');
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /search propiq/i });
    await expect(async () => {
      await page.keyboard.press('Control+k');
      await expect(dialog).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.type('zzzznotathing');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=zzzznotathing/);
  });

  test('closes on Escape', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'there is no Cmd-K on a phone');
    await page.goto('/');
    await expect(async () => {
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('responsive', () => {
  for (const width of [320, 375, 390, 430, 768, 1024, 1280, 1440]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'widths are driven explicitly here');
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `page scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
    });
  }
});
