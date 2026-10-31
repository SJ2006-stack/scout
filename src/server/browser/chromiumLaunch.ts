export type ChromiumLaunchOptions = {
  headless: boolean;
  channel?: "chromium";
  args: string[];
};

export type ChromiumContextProfile = {
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  userAgent: string;
};

const CONTAINER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];
const SITE_ARGS = ["--disable-blink-features=AutomationControlled"];

/**
 * Headless runs use full Chromium's new headless mode. Zepto renders a blank
 * page and Swiggy a block page for the stripped headless shell.
 */
export function chromiumLaunchOptions(headed: boolean, env: NodeJS.ProcessEnv = process.env): ChromiumLaunchOptions {
  if (headed) return { headless: false, args: SITE_ARGS };
  const args = runsInContainer(env) ? [...CONTAINER_ARGS, ...SITE_ARGS] : SITE_ARGS;
  return { headless: true, channel: "chromium", args };
}

/** An Indian desktop Chrome profile, so stores serve their normal Indian pages. */
export function chromiumContextProfile(version: string): ChromiumContextProfile {
  const major = /^\d+/.exec(version)?.[0] ?? "141";
  return {
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1366, height: 820 },
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  };
}

function runsInContainer(env: NodeJS.ProcessEnv): boolean {
  return (env.WEBSITE_SITE_NAME ?? "").trim().length > 0 || env.SCOUT_CONTAINER === "1";
}
