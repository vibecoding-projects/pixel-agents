import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { expectOverlayCount } from '../../helpers/office';
import {
  drainRecordedMessages,
  installMessageRecorder,
  type RecordedServerMessage,
} from '../../helpers/standalone';
import { setSettings } from '../../helpers/webview';

const SPAWN_TIMEOUT_MS = 20_000;

test.describe('Standalone / New-agent form', () => {
  test('named spawn in an explicit folder: rail label, recents on disk and in the form @area:agent-form', async ({
    page,
    standalone,
  }) => {
    const spawnFolder = path.join(standalone.workspaceDir, 'spawn-here');
    fs.mkdirSync(spawnFolder, { recursive: true });

    // Overlays only render for hovered/selected agents unless labels are on.
    await setSettings(page, { alwaysShowLabels: true });

    await page.getByRole('button', { name: '+ Agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('Agent name').fill('Named Bot');
    await page.getByLabel('Starting folder').fill(spawnFolder);
    await page.getByRole('button', { name: 'Spawn' }).click();
    await expect(dialog).toBeHidden();

    // Rail label shows the user-chosen name.
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expect(page.getByRole('tab', { name: /Named Bot/ })).toBeVisible();
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);

    // The folder was recorded under the STANDALONE adapter namespace with the
    // bare key (settingNameOf strips the pixel-agents. prefix before writing).
    await expect
      .poll(
        () => {
          try {
            const config = JSON.parse(
              fs.readFileSync(
                path.join(standalone.tmpHome, '.pixel-agents', 'config.json'),
                'utf8',
              ),
            ) as { standalone?: { recentAgentFolders?: string[] } };
            return config.standalone?.recentAgentFolders ?? [];
          } catch {
            return [];
          }
        },
        { timeout: SPAWN_TIMEOUT_MS, message: 'spawn folder should land in recentAgentFolders' },
      )
      .toContain(spawnFolder);

    // Reopening the form lists the folder as a quick-pick.
    await page.getByRole('button', { name: '+ Agent' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: spawnFolder })).toBeVisible();
  });

  test('a folder that does not resolve refuses the spawn and surfaces the error @area:agent-form', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await page.getByRole('button', { name: '+ Agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('Starting folder').fill('Desktop/not-a-real-dir-xyz');
    await page.getByRole('button', { name: 'Spawn' }).click();

    // The server refuses instead of silently spawning in its own cwd; the
    // form comes back with the rejected folder and the reason.
    await expect(dialog.getByText(/Folder not found/)).toBeVisible();
    await expect(page.getByLabel('Starting folder')).toHaveValue('Desktop/not-a-real-dir-xyz');
    const messages = await standalone.drainMessages();
    expect(messages.some((m) => m.type === 'launchAgentFailed')).toBe(true);
    // No character, no terminal band — nothing was spawned.
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);
    await expect(page.getByTestId('terminal-band')).toBeHidden();
  });

  test('a home-relative folder (no ~, no leading slash) spawns normally @area:agent-form', async ({
    page,
    standalone,
  }) => {
    fs.mkdirSync(path.join(standalone.tmpHome, 'projects', 'app'), { recursive: true });
    await setSettings(page, { alwaysShowLabels: true });

    await page.getByRole('button', { name: '+ Agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'New agent' });
    await expect(dialog).toBeVisible();
    await page.getByLabel('Starting folder').fill('projects/app');
    await page.getByRole('button', { name: 'Spawn' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);
  });

  test('an unprivileged page sees the character but never receives ptyData @area:agent-form', async ({
    page,
    context,
    standalone,
  }) => {
    // Labels persist in config.json, so the unprivileged viewer page below
    // inherits them and its character is assertable without hover.
    await setSettings(page, { alwaysShowLabels: true });

    // Privileged page spawns the agent.
    await page.getByRole('button', { name: '+ Agent' }).click();
    await page.getByRole('button', { name: 'Spawn' }).click();
    await expect(page.getByTestId('terminal-band')).toBeVisible({ timeout: SPAWN_TIMEOUT_MS });
    await expectOverlayCount(page, 1, SPAWN_TIMEOUT_MS);

    // Second page: same origin, NO ?token= — an untokened local viewer.
    const viewer = await context.newPage();
    try {
      await installMessageRecorder(viewer);
      await viewer.goto(standalone.hostUrl);

      // It still sees the office and the character (broadcasts are public)...
      await expectOverlayCount(viewer, 1, SPAWN_TIMEOUT_MS);
      // ...but no terminal band: existingAgents' ptyBackedAgents rides the
      // same handshake for every client, while pty OUTPUT stays privileged.
      // Generate fresh output on the privileged page, then assert the
      // unprivileged recorder saw none of it.
      await page.locator('[data-testid="terminal-band"] .xterm').click();
      await page.keyboard.type('secret-keystrokes');
      await viewer.waitForTimeout(3_000);
      const messages: RecordedServerMessage[] = await drainRecordedMessages(viewer);
      const ptyFrames = messages.filter((m) => m.type === 'ptyData' || m.type === 'ptyScrollback');
      expect(ptyFrames).toEqual([]);
    } finally {
      await viewer.close();
    }
  });
});
