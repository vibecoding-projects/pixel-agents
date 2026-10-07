import fs from 'node:fs';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { expectOverlayCount } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

// A pty spawn goes shell -l -c → mock claude → invocation log; give the whole
// chain (plus xterm mount + scrollback replay) generous slack.
const SPAWN_TIMEOUT_MS = 20_000;
// Server-side close grace window (CLOSE_GRACE_MS) plus slack for the
// closedSessions broadcast and a React render.
const GRACE_MS = 10_000;
const AFTER_GRACE_MS = GRACE_MS + 5_000;

/** Open the New-agent form, name the agent and spawn it. */
async function spawnNamed(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '+ Agent' }).click();
  await expect(page.getByRole('dialog', { name: 'New agent' })).toBeVisible();
  await page.getByLabel('Agent name').fill(name);
  await page.getByRole('button', { name: 'Spawn' }).click();
}

/** mock-claude's invocation log lines (one per spawned process). */
function invocationLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

test.describe('Standalone / Close, undo, restore', () => {
  test('closing from the rail shows an Undo toast; Undo brings the agent back without a new process @area:terminal', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await spawnNamed(page, 'Keeper');
    await expect(page.getByRole('tab', { name: /Keeper/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(1);

    await page.getByRole('button', { name: 'Close Keeper' }).click();
    const undo = page.getByRole('button', { name: 'Undo closing Keeper' });
    await expect(undo).toBeVisible();
    await expectOverlayCount(page, 0, 5_000);

    await undo.click();
    await expect(undo).toBeHidden();
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);
    await expect(page.getByRole('tab', { name: /Keeper/ })).toBeVisible();
    // Same process: no second mock invocation.
    expect(invocationLines(standalone.mockLogFile)).toHaveLength(1);
  });

  test('a reload inside the window still offers Undo @area:terminal', async ({
    page,
    standalone,
  }) => {
    await spawnNamed(page, 'Reloaded');
    await expect(page.getByRole('tab', { name: /Reloaded/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(1);
    // Budget: close → reload → full handshake (every sprite over WS on a
    // throttled CI runner) → Undo click must all fit inside CLOSE_GRACE_MS
    // (10 s). Drain first so the reload is the only work in between.
    await standalone.drainMessages();
    await page.getByRole('button', { name: 'Close Reloaded' }).click();
    await page.reload();
    const undo = page.getByRole('button', { name: 'Undo closing Reloaded' });
    await expect(undo).toBeVisible({ timeout: 8_000 });
    await undo.click();
    await expect(page.getByRole('tab', { name: /Reloaded/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(invocationLines(standalone.mockLogFile)).toHaveLength(1);
  });

  test('after the window the session is on the Closed list; Restore resumes it; Forget drops it @area:terminal', async ({
    page,
    standalone,
  }) => {
    await spawnNamed(page, 'Phoenix');
    await expect(page.getByRole('tab', { name: /Phoenix/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(1);
    const firstSessionId = invocationLines(standalone.mockLogFile)[0].match(/session-id=(\S+)/)![1];

    await page.getByRole('button', { name: 'Close Phoenix' }).click();
    const restore = page.getByRole('button', { name: 'Restore Phoenix' });
    await expect(restore).toBeVisible({ timeout: AFTER_GRACE_MS });
    await expect(page.getByRole('tab')).toHaveCount(0);

    // Restore: a new rail entry with the same name, and mock-claude is invoked
    // again for the SAME session (the runner logs session-id for --resume too).
    await restore.click();
    await expect(page.getByRole('tab', { name: /Phoenix/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await expect(restore).toBeHidden();
    await expect
      .poll(() => invocationLines(standalone.mockLogFile).length, { timeout: SPAWN_TIMEOUT_MS })
      .toBe(2);
    expect(invocationLines(standalone.mockLogFile)[1]).toContain(`session-id=${firstSessionId}`);

    // Close again, then Forget.
    await page.getByRole('button', { name: 'Close Phoenix' }).click();
    const forget = page.getByRole('button', { name: 'Forget Phoenix' });
    await expect(forget).toBeVisible({ timeout: AFTER_GRACE_MS });
    await forget.click();
    await expect(page.getByTestId('closed-sessions')).toBeHidden();
  });

  test('Alt+ArrowUp reorders the rail and the order survives a reload @area:terminal', async ({
    page,
    standalone,
  }) => {
    // The fixture must be requested for the server to exist at all.
    void standalone;
    await spawnNamed(page, 'First');
    await expect(page.getByRole('tab', { name: /First/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    await spawnNamed(page, 'Second');
    await expect(page.getByRole('tab', { name: /Second/ })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
    const tabs = page.getByRole('tab');
    await expect(tabs.nth(0)).toContainText('First');
    await tabs.nth(1).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(tabs.nth(0)).toContainText('Second');
    await page.reload();
    await expect(page.getByRole('tab').nth(0)).toContainText('Second', {
      timeout: SPAWN_TIMEOUT_MS,
    });
  });
});
