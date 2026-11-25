import { expect, test } from '@playwright/test';

test.describe('Component 2: Dynamic Tenant Analytics & Realization Verification', () => {
  test('renders real tenant clients & blocks in Analytics, supports search/filter/scope switching, and drills down to Timeline', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const txt = msg.text();
        if (!txt.includes('WebSocket')) consoleErrors.push(txt);
      }
    });

    await page.goto('/');

    // Sign in as Demo Accountant Maya Patel
    const demoMayaBtn = page.getByRole('button', { name: /Maya Patel/i });
    if (await demoMayaBtn.isVisible().catch(() => false)) {
      await demoMayaBtn.click();
    } else {
      await page.getByRole('button', { name: /^Sign In$/i }).first().click();
      await page.getByRole('button', { name: /Maya Patel/i }).click();
    }

    await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 15_000 });

    // Create a distinct Time Block on Timeline so we verify live aggregation into Analytics
    const uniqueSuffix = Date.now().toString().slice(-5);
    const blockTitle = `E2E Analytics Ledger Audit ${uniqueSuffix}`;
    await page.getByRole('button', { name: /Quick Log/i }).first().click();
    await page.getByPlaceholder(/Acme Corp Q3 Bank Reconciliation/i).fill(blockTitle);
    const selectedClient = await page
      .locator('select')
      .filter({ has: page.locator('option') })
      .nth(1)
      .inputValue()
      .catch(() => 'Acme Corp');
    await page.locator('input[type="time"]').first().fill('11:00');
    await page.locator('input[type="time"]').nth(1).fill('12:00');
    await page.getByRole('button', { name: /Log to Timeline/i }).click();
    await expect(page.getByText(blockTitle).first()).toBeVisible({ timeout: 10_000 });

    // Navigate to Analytics tab
    await page.getByRole('button', { name: /^Analytics$/i }).click();
    await expect(page.getByText('Productivity & Estimation Analytics')).toBeVisible({
      timeout: 10_000,
    });

    const matrix = page.getByTestId('analytics-project-matrix');
    await expect(matrix).toBeVisible();
    // Should contain real tenant clients (e.g., Acme Corp)
    await expect(matrix).toContainText(/Acme/i);

    // Toggle All Recorded vs 7-Day Window
    const filterBar = page.getByTestId('analytics-filter-bar');
    await filterBar.getByRole('button', { name: 'All Recorded' }).click();
    await expect(matrix).toContainText('all recorded time');
    await filterBar.getByRole('button', { name: '7-Day Window' }).click();
    await expect(matrix).toContainText('7-day window');

    // Filter using search input for the logged block title
    const searchInput = page.getByLabel('Search analytics data');
    await searchInput.fill(blockTitle);
    await expect(matrix).toContainText(selectedClient || 'Acme');

    // Clear filter and click first row to scope by client
    await filterBar.getByRole('button', { name: 'Clear Filter' }).click();
    const acmeRow = matrix.locator('tbody tr', { hasText: /Acme/i }).first();
    await acmeRow.click();
    await expect(filterBar.getByRole('button', { name: 'Clear Filter' })).toBeVisible();
    await filterBar.getByRole('button', { name: 'Clear Filter' }).click();

    // Click today's date row in Daily Focus Distribution to jump straight to Timeline
    const todayIso = new Date().toISOString().slice(0, 10);
    const dayRow = page.locator('div', { hasText: todayIso }).filter({ hasText: /m|h/ }).last();
    if (await dayRow.isVisible().catch(() => false)) {
      await dayRow.click();
      await expect(page.getByText('Day View Activity Timeline')).toBeVisible({ timeout: 10_000 });
    }

    // Verify Executive Role Analytics view also renders real realization data and filters cleanly
    const roleSelect = page.getByLabel('Switch preview role');
    if (await roleSelect.isVisible().catch(() => false)) {
      await roleSelect.selectOption('executive');
      await page.getByRole('button', { name: /^Analytics$/i }).click();
      await expect(page.getByText('Firm Analytics & Realization Matrix')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText('Client Engagement Realization & Profitability')).toBeVisible();
      await page.getByLabel('Filter client engagements').fill('zzzz-nonexistent-client');
      await expect(
        page.getByText('No client engagements match the current filter.')
      ).toBeVisible();
      await page.getByRole('button', { name: 'Clear Filter' }).click();
    }

    expect(pageErrors, `Uncaught page errors: ${pageErrors.join('; ')}`).toEqual([]);
    expect(consoleErrors, `Console errors: ${consoleErrors.join('; ')}`).toEqual([]);
  });
});
