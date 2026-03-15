const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Gstack-Browse for Gemini CLI
 * Ported and refined with collaboration from Claude & Codex.
 */

const userDataDir = path.join(os.homedir(), '.gstack', 'gemini-browser-data');

const COMMANDS = {
  goto: {
    argc: 1,
    fn: async (page, [url]) => {
      process.stderr.write(`[Runner] Navigating to ${url}...\n`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      process.stderr.write(`[Runner] Success: Navigated to ${page.url()}\n`);
    }
  },
  screenshot: {
    argc: 1,
    fn: async (page, [filepath]) => {
      process.stderr.write(`[Runner] Taking screenshot to ${filepath}...\n`);
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      await page.screenshot({ path: filepath, fullPage: true });
      process.stderr.write(`[Runner] Success: Screenshot saved.\n`);
    }
  },
  click: {
    argc: 1,
    fn: async (page, [selector]) => {
      process.stderr.write(`[Runner] Clicking ${selector}...\n`);
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
      } catch (e) {
        // Fallback if network doesn't go idle
      }
      process.stderr.write(`[Runner] Success: Clicked.\n`);
    }
  },
  fill: {
    argc: 2,
    fn: async (page, [selector, text]) => {
      process.stderr.write(`[Runner] Filling ${selector}...\n`);
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.fill(selector, text);
      process.stderr.write(`[Runner] Success: Filled.\n`);
    }
  },
  text: {
    argc: 0,
    fn: async (page) => {
      const textContent = await page.evaluate(() => document.body.innerText);
      process.stdout.write(textContent + '\n');
    }
  },
  html: {
    argc: 0,
    fn: async (page) => {
      const htmlContent = await page.evaluate(() => document.documentElement.outerHTML);
      process.stdout.write(htmlContent + '\n');
    }
  }
};

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.error('Usage: node browse.js <command1> [args...] <command2> [args...]');
    console.error('Available commands: ' + Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }

  const taskQueue = [];
  for (let i = 0; i < args.length; ) {
    const cmdName = args[i];
    const definition = COMMANDS[cmdName];
    if (!definition) {
      console.error(`Error: Unknown command "${cmdName}"`);
      process.exit(1);
    }
    if (i + definition.argc >= args.length) {
      console.error(`Error: Command "${cmdName}" requires ${definition.argc} argument(s).`);
      process.exit(1);
    }
    taskQueue.push({
      fn: definition.fn,
      args: args.slice(i + 1, i + 1 + definition.argc)
    });
    i += 1 + definition.argc;
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  page.on('console', msg => process.stderr.write(`[Browser] ${msg.type()}: ${msg.text()}\n`));
  page.on('pageerror', err => process.stderr.write(`[Browser Error] ${err.message}\n`));

  try {
    for (const task of taskQueue) {
      await task.fn(page, task.args);
    }
  } catch (err) {
    process.stderr.write(`[Fatal Error]: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main();