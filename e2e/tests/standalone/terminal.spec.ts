import fs from 'node:fs';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { expectOverlayCount } from '../../helpers/office';
import type { RecordedServerMessage } from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

// A pty spawn goes shell -l -c → mock claude → invocation log; give the whole
// chain (plus xterm mount + scrollback replay) generous slack.
const SPAWN_TIMEOUT_MS = 20_000;

async function readFileWhenNonEmpty(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim().length > 0) return content;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for non-empty ${filePath}`);
}

/** Open the New-agent form and submit it with whatever fields are filled. */
async function spawnFromForm(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '+ Agent' }).click();
  await expect(page.getByRole('dialog', { name: 'New agent' })).toBeVisible();
  await page.getByRole('button', { name: 'Spawn' }).click();
}

test.describe('Standalone / Terminal band', () => {
  test('Terminal Position docks the band right, left, and back to bottom @area:terminal', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await setSettings(page, { alwaysShowLabels: true });
    await spawnFromForm(page);

    const band = page.getByTestId('terminal-band');
    await expect(band).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expect(band).toHaveAttribute('data-position', 'bottom');

    // Dock right: the band hugs the right viewport edge, full height.
    await setSettings(page, { terminalPosition: 'right' });
    await expect(band).toHaveAttribute('data-position', 'right');
    const viewport = page.viewportSize()!;
    const rightBox = (await band.boundingBox())!;
    expect(rightBox.x + rightBox.width).toBeGreaterThan(viewport.width - 4);
    expect(rightBox.height).toBeGreaterThan(viewport.height * 0.9);

    // Dock left.
    await setSettings(page, { terminalPosition: 'left' });
    await expect(band).toHaveAttribute('data-position', 'left');
    const leftBox = (await band.boundingBox())!;
    expect(leftBox.x).toBeLessThan(4);
    expect(leftBox.height).toBeGreaterThan(viewport.height * 0.9);

    // And back to bottom.
    await setSettings(page, { terminalPosition: 'bottom' });
    await expect(band).toHaveAttribute('data-position', 'bottom');
    const bottomBox = (await band.boundingBox())!;
    expect(bottomBox.y + bottomBox.height).toBeGreaterThan(viewport.height - 4);
    expect(bottomBox.width).toBeGreaterThan(viewport.width * 0.9);
  });

  test('the band toggles with character selection: spawn opens, floor click closes, character click reopens @area:terminal', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await spawnFromForm(page);

    // Spawning auto-opens the band on the new agent.
    const band = page.getByTestId('terminal-band');
    await expect(band).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });

    // The nameplate anchors to the character's feet — its box gives us real
    // canvas coordinates for a genuine user click on the sprite above it.
    const nameplate = page.getByTestId('agent-nameplate');
    await expect(nameplate).toHaveCount(1, { timeout: SPAWN_TIMEOUT_MS });

    // Click empty space: deselects → band closes. Upper-middle of the canvas
    // is void above the office map — clear of the zoom buttons (top-left),
    // toasts (right edge), and the bottom toolbar.
    const canvas = page.locator('canvas').first();
    const canvasBox = (await canvas.boundingBox())!;
    const emptyX = canvasBox.x + canvasBox.width * 0.35;
    const emptyY = canvasBox.y + 60;
    await page.mouse.click(emptyX, emptyY);
    await expect(band).toBeHidden();

    // Click the character: selects → band reopens.
    const np = (await nameplate.boundingBox())!;
    await page.mouse.click(np.x + np.width / 2, np.y - 10);
    await expect(band).toBeVisible();

    // Click the character again: toggle off (same-agent deselect).
    const np2 = (await nameplate.boundingBox())!;
    await page.mouse.click(np2.x + np2.width / 2, np2.y - 10);
    await expect(band).toBeHidden();
  });

  test('the rail/pane divider drags like DevTools and persists the width @area:terminal', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    await setSettings(page, { alwaysShowLabels: true });
    await spawnFromForm(page);
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });

    const rail = page.getByRole('tablist', { name: 'Agent terminals' });
    const divider = page.getByRole('separator', { name: 'Resize agent rail' });
    const before = (await rail.boundingBox())!;

    // Drag the divider 80px to the right — the rail grows by the same amount.
    const handleBox = (await divider.boundingBox())!;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 5 });
    await page.mouse.up();

    const after = (await rail.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 60);

    // The dragged width survives a reload (localStorage persistence).
    await page.reload();
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    const reloaded = (await page.getByRole('tablist', { name: 'Agent terminals' }).boundingBox())!;
    expect(Math.abs(reloaded.width - after.width)).toBeLessThan(3);
  });

  test('+ Agent spawns a pty agent: character, band, mock invocation @area:terminal', async ({
    page,
    standalone,
  }) => {
    // Overlays only render for hovered/selected agents unless labels are on.
    await setSettings(page, { alwaysShowLabels: true });
    await spawnFromForm(page);

    // Character appears in the office.
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);

    // Terminal band appears with the agent's rail entry.
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expect(page.getByRole('tab')).toHaveCount(1);

    // The MOCK claude answered the spawn — not a real CLI. The login shell can
    // reorder PATH, so the invocation log is the authoritative proof.
    const log = await readFileWhenNonEmpty(standalone.mockLogFile, SPAWN_TIMEOUT_MS);
    expect(log).toContain('session-id=');
  });

  test('typed keystrokes reach the pty and echo back @area:terminal', async ({
    page,
    standalone,
  }) => {
    await spawnFromForm(page);
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await readFileWhenNonEmpty(standalone.mockLogFile, SPAWN_TIMEOUT_MS);

    // Focus the xterm pane and type. The mock does not read stdin, but the tty
    // line discipline echoes typed input — so the keystroke round-trips as a
    // ptyData frame if and only if ptyInput reached the server-side pty.
    await standalone.drainMessages();
    await page.locator('[data-testid="terminal-band"] .xterm').click();
    await page.keyboard.type('marker-echo-xyz');

    await expect
      .poll(
        async () => {
          const messages: RecordedServerMessage[] = await standalone.drainMessages();
          return messages
            .filter((m) => m.type === 'ptyData')
            .map((m) => String(m['data'] ?? ''))
            .join('');
        },
        { timeout: SPAWN_TIMEOUT_MS, message: 'typed keystrokes should echo back as ptyData' },
      )
      .toContain('marker-echo-xyz');
  });

  test('pty exit shows the Restart control and restart re-invokes claude @area:terminal', async ({
    page,
    standalone,
  }) => {
    // First spawn claims this scenario: session ends (code 0) shortly after
    // start, while the pane is already mounted (single agent → auto-focused).
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('exit-early').exitAt(3_000, 0),
    );
    await spawnFromForm(page);
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    const firstLog = await readFileWhenNonEmpty(standalone.mockLogFile, SPAWN_TIMEOUT_MS);
    const firstInvocations = firstLog.trim().split('\n').length;

    // The scenario exits ~3s in → exit marker + Restart button.
    const restart = page.getByRole('button', { name: 'Restart agent' });
    await expect(restart).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });

    // Restart relaunches the SAME session in the same cwd: the button clears
    // and mock-claude logs a second invocation.
    await restart.click();
    await expect(restart).toBeHidden({ timeout: SPAWN_TIMEOUT_MS });
    await expect
      .poll(
        () => {
          try {
            return fs.readFileSync(standalone.mockLogFile, 'utf8').trim().split('\n').length;
          } catch {
            return 0;
          }
        },
        { timeout: SPAWN_TIMEOUT_MS, message: 'restart should log a second mock invocation' },
      )
      .toBeGreaterThan(firstInvocations);
  });

  test('a pane mounted AFTER the pty exited still shows the Restart control @area:terminal', async ({
    page,
    standalone,
  }) => {
    // The dead worker is RETAINED server-side: terminalPaneReady replays its
    // scrollback and a synthetic ptyExit, so a page reload (= every pane
    // mounts late) reconstructs the exit marker. This is the retention model
    // M2's always-late-mounting webview panes depend on.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('exit-early-remount').exitAt(3_000, 0),
    );
    await spawnFromForm(page);
    const restart = page.getByRole('button', { name: 'Restart agent' });
    await expect(restart).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });

    await page.reload();
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expect(page.getByRole('button', { name: 'Restart agent' })).toBeVisible({
      timeout: SPAWN_TIMEOUT_MS,
    });
  });
});
