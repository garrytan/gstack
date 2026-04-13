import { existsSync } from "node:fs";
import { stripSlackLinkWrapping } from "../slack/customer-voice-commands";

export interface BrowserSimulationVisit {
  path: string;
  ok: boolean;
  title: string | null;
  heading: string | null;
  notes: string[];
}

export interface BrowserSimulationEvidence {
  enabled: boolean;
  baseUrl: string | null;
  visited: BrowserSimulationVisit[];
  loginAttempted: boolean;
  loginSucceeded: boolean;
  missingCredentialRefs: string[];
  notes?: string[];
}

export function resolveSimulationCredentials(input: {
  credentialRefs: string[];
  env: Record<string, string | undefined>;
}) {
  return Object.fromEntries(
    input.credentialRefs
      .map((ref) => [ref, input.env[ref]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}

export function summarizeBrowserSimulation(evidence: BrowserSimulationEvidence) {
  const lines = [
    `시뮬레이션: ${evidence.enabled ? "실행" : "비활성"}${evidence.baseUrl ? ` / ${evidence.baseUrl}` : ""}`,
  ];

  for (const visit of evidence.visited) {
    const status = visit.ok ? "통과" : "실패";
    const context = [visit.title, visit.heading].filter(Boolean).join(" / ");
    const notes = visit.notes.length > 0 ? ` (${visit.notes.join("; ")})` : "";
    lines.push(`- ${visit.path}: ${status}${context ? ` / ${context}` : ""}${notes}`);
  }

  if (evidence.loginAttempted) {
    lines.push(`- 로그인 시도: ${evidence.loginSucceeded ? "성공" : "실패"}`);
  }

  if (evidence.missingCredentialRefs.length > 0) {
    lines.push(`- 누락 계정 변수: ${evidence.missingCredentialRefs.join(", ")}`);
  }

  for (const note of evidence.notes ?? []) {
    lines.push(`- 참고: ${note}`);
  }

  return lines;
}

function pickExecutablePath() {
  const candidates = [
    process.env.GOOGLE_CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 && existsSync(candidate));
}

function looksLikeLoginPath(path: string) {
  return /(login|signin|sign-in|로그인)/i.test(path);
}

function resolveBaseUrl(input: {
  projectId?: string;
  baseUrl?: string | null;
  env: Record<string, string | undefined>;
}) {
  if (input.baseUrl) return stripSlackLinkWrapping(input.baseUrl);
  const projectKey = input.projectId
    ? input.projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
    : null;
  if (projectKey) {
    const fromProjectEnv = input.env[`RICO_SIMULATION_BASE_URL_${projectKey}`];
    if (fromProjectEnv) return stripSlackLinkWrapping(fromProjectEnv);
  }
  return input.env.RICO_SIMULATION_BASE_URL
    ? stripSlackLinkWrapping(input.env.RICO_SIMULATION_BASE_URL)
    : null;
}

export async function runBrowserSimulation(input: {
  projectId?: string;
  enabled: boolean;
  baseUrl?: string | null;
  allowedJourneys: string[];
  requiresCredentials: boolean;
  credentialRefs: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}) {
  const env = input.env ?? process.env;
  const baseUrl = resolveBaseUrl({
    projectId: input.projectId,
    baseUrl: input.baseUrl,
    env,
  });
  const credentials = resolveSimulationCredentials({
    credentialRefs: input.credentialRefs,
    env,
  });
  const missingCredentialRefs = input.credentialRefs.filter((ref) => !credentials[ref]);

  if (!input.enabled) {
    return {
      enabled: false,
      baseUrl,
      visited: [],
      loginAttempted: false,
      loginSucceeded: false,
      missingCredentialRefs,
      notes: ["시뮬레이션 정책이 비활성입니다."],
    } satisfies BrowserSimulationEvidence;
  }

  if (!baseUrl) {
    return {
      enabled: true,
      baseUrl: null,
      visited: [],
      loginAttempted: false,
      loginSucceeded: false,
      missingCredentialRefs,
      notes: ["base URL이 설정되지 않아 브라우저 시뮬레이션을 건너뛰었습니다."],
    } satisfies BrowserSimulationEvidence;
  }

  let playwright: typeof import("playwright") | null = null;
  try {
    playwright = await import("playwright");
  } catch {
    return {
      enabled: true,
      baseUrl,
      visited: [],
      loginAttempted: false,
      loginSucceeded: false,
      missingCredentialRefs,
      notes: ["playwright 의존성이 없어 브라우저 시뮬레이션을 실행하지 못했습니다."],
    } satisfies BrowserSimulationEvidence;
  }

  const executablePath = pickExecutablePath();
  const browser = await playwright.chromium.launch({
    headless: true,
    executablePath,
  });

  const page = await browser.newPage();
  const visited: BrowserSimulationVisit[] = [];
  let loginAttempted = false;
  let loginSucceeded = false;

  try {
    for (const path of input.allowedJourneys) {
      const targetUrl = new URL(path, baseUrl).toString();
      try {
        const response = await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: input.timeoutMs ?? 10_000,
        });
        await page.waitForTimeout(200);
        const title = (await page.title()) || null;
        const heading = await page.locator("h1, [role='heading']").first().textContent().catch(() => null);
        const ctaCount = await page.locator("a, button").count().catch(() => 0);
        visited.push({
          path,
          ok: Boolean(response?.ok()),
          title,
          heading: heading?.trim() || null,
          notes: ctaCount > 0 ? [`CTA ${ctaCount}개 확인`] : [],
        });

        if (
          looksLikeLoginPath(path)
          && input.requiresCredentials
          && missingCredentialRefs.length === 0
          && !loginAttempted
        ) {
          loginAttempted = true;
          const entries = Object.values(credentials);
          const email = entries[0];
          const password = entries[1];
          if (email && password) {
            const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
            const passwordInput = page.locator('input[type="password"], input[name*="password" i]').first();
            if (await emailInput.count().catch(() => 0) && await passwordInput.count().catch(() => 0)) {
              await emailInput.fill(email);
              await passwordInput.fill(password);
              const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("로그인"), button:has-text("Sign in"), button:has-text("Login")').first();
              if (await submit.count().catch(() => 0)) {
                await Promise.allSettled([
                  page.waitForLoadState("networkidle", { timeout: input.timeoutMs ?? 10_000 }),
                  submit.click(),
                ]);
                loginSucceeded = true;
              }
            }
          }
        }
      } catch (error) {
        visited.push({
          path,
          ok: false,
          title: null,
          heading: null,
          notes: [error instanceof Error ? error.message : "navigation failed"],
        });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    enabled: true,
    baseUrl,
    visited,
    loginAttempted,
    loginSucceeded,
    missingCredentialRefs,
  } satisfies BrowserSimulationEvidence;
}
