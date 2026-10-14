// Shared bits for the browser tests. They need the game served (npx vite preview --port 4173) with a
// Supabase-compatible backend behind it, e.g. tests/online/stack.mjs.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(`${execSync('npm root -g').toString().trim()}/`);
export const { chromium } = require('playwright');
export const GAME_URL = process.env.GAME_URL || 'http://localhost:4173/';
export const SHOTS = process.env.SHOTS || '.scratch';
/** The shared world persists between runs, so every run uses fresh names and a fresh corner of the map. */
export const RUN = Date.now() % 100000;
export const OFFSET = (RUN % 40) * 0.015;
export const step = (s) => console.log(`• ${s}`);

export function launch() {
  return chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
}

/** Open the game, sign in as a guest and found a company. */
export async function joinAsGuest(page, name, color = '#dc2626') {
  await page.goto(GAME_URL);
  await page.click('.start-card button.primary:not([disabled])', { timeout: 20000 });
  await page.waitForSelector('.screen.auth button.primary', { timeout: 30000 });
  await page.click('.screen.auth button.primary');
  await page.waitForSelector('.screen.found input', { timeout: 30000 });
  await page.fill('.screen.found input:not([type])', name);
  await page.fill('.screen.found input[type=color]', color);
  await page.click('.screen.found button.primary');
  await page.waitForSelector('.topbar .company', { timeout: 30000 });
}
