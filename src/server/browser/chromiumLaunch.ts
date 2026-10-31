export type ChromiumLaunchOptions = {
  headless: boolean;
  args?: string[];
};

const CONTAINER_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];

export function chromiumLaunchOptions(headed: boolean, env: NodeJS.ProcessEnv = process.env): ChromiumLaunchOptions {
  if (headed) return { headless: false };
  if (!runsInContainer(env)) return { headless: true };
  return { headless: true, args: CONTAINER_ARGS };
}

function runsInContainer(env: NodeJS.ProcessEnv): boolean {
  return (env.WEBSITE_SITE_NAME ?? "").trim().length > 0 || env.SCOUT_CONTAINER === "1";
}
