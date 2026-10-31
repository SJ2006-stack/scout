import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";

// Usage: npm run bolna:setup -- https://scout.example.com [--agent <id>] [--save]
// Registers that site's /api/bolna/v1 endpoint as a Bolna custom LLM and creates or updates its voice agent.
// Each site gets its own agent because profile memory and the live relay live on that site.
// --save writes BOLNA_AGENT_ID to the local .env; without it the id is printed for the site's app settings.

const BOLNA = "https://api.bolna.ai";
const envPath = new URL("../.env", import.meta.url).pathname;
if (existsSync(envPath)) loadEnvFile(envPath);

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const save = process.argv.includes("--save");
const agentFlag = process.argv.indexOf("--agent");
const MODEL = `scout-${(base.match(/^https:\/\/([^./]+)/)?.[1] ?? "site").toLowerCase()}`;
const apiKey = process.env.BOLNA_API_KEY ?? "";
const llmKey = process.env.BOLNA_LLM_KEY ?? "";
if (!/^https:\/\/[^/]+/.test(base)) fail("Pass the public https origin that serves Scout, for example https://scout.example.com.");
if (!apiKey.startsWith("bn-") || llmKey.length < 32) fail("Set BOLNA_API_KEY and BOLNA_LLM_KEY in .env first.");
const llmUrl = `${base}/api/bolna/v1`;

const probe = await fetch(`${llmUrl}/models`, { headers: { authorization: `Bearer ${llmKey}` } }).catch(() => null);
if (!probe?.ok) fail(`Scout did not answer at ${llmUrl}/models (${probe?.status ?? "unreachable"}). Start the server with BOLNA_LLM_KEY set.`);

const existing = (await bolna("GET", "/user/model/custom")) as unknown;
const models = Array.isArray(existing) ? existing : ((existing as { data?: unknown[] } | null)?.data ?? []);
for (const model of models as { id?: string; custom_model_name?: string; custom_model_url?: string }[]) {
  if (model.custom_model_name !== MODEL || model.custom_model_url === llmUrl || !model.id) continue;
  await bolna("DELETE", `/user/model/custom/${model.id}`, undefined, true);
}
if (!(models as { custom_model_name?: string; custom_model_url?: string }[]).some((model) => model.custom_model_name === MODEL && model.custom_model_url === llmUrl)) {
  await bolna("POST", "/user/model/custom", {
    custom_model_name: MODEL,
    custom_model_url: llmUrl,
    custom_model_key: llmKey,
    custom_model_family: "openai",
  });
}

const agent = {
  agent_config: {
    agent_name: `Scout (${base.replace(/^https:\/\//, "")})`,
    agent_welcome_message: "Namaste {{name}}! Main Scout hoon. Events, shopping, khaana, ya phone pe kuch set karna ho, bas boliye.",
    tasks: [
      {
        task_type: "conversation",
        toolchain: { execution: "parallel", pipelines: [["transcriber", "llm", "synthesizer"]] },
        tools_config: {
          llm_agent: {
            agent_type: "simple_llm_agent",
            agent_flow_type: "streaming",
            llm_config: { provider: "custom", model: MODEL, base_url: llmUrl, family: "openai", max_tokens: 300, temperature: 0.2 },
          },
          transcriber: {
            provider: "sarvam",
            model: "saaras:v4",
            language: "hi",
            stream: true,
            endpointing: 400,
            keywords: "Scout, Luma, District, BookMyShow, Blinkit, Zepto, Swiggy, Instamart, Delhi, Gurgaon, Noida, Bengaluru",
            context: "Personal assistant for an Indian user who mixes Hindi and English. Requests are about events, shopping, food, travel, home services, alarms and reminders.",
          },
          synthesizer: {
            provider: "sarvam",
            provider_config: { voice: "Aparna", voice_id: "aparna_hi_customer", model: "bulbul:v4-flash", language: "hi", speed: 1.05 },
            stream: true,
            buffer_size: 150,
            audio_format: "wav",
          },
          input: { provider: "plivo", format: "wav" },
          output: { provider: "plivo", format: "wav" },
        },
        task_config: { call_terminate: 600, hangup_after_silence: 20, incremental_delay: 300, number_of_words_for_interruption: 2 },
      },
    ],
  },
  agent_prompts: {
    task_1: {
      system_prompt: [
        "You are Scout, a voice-first personal assistant. Reply in the caller's language, Hindi, English or Hinglish, in one or two short spoken sentences.",
        "Never read out links, card numbers, or long lists. Say that details are on screen.",
        "scout_ticket: {{scout_ticket}}",
      ].join("\n"),
    },
  },
};

let agentId = agentFlag > 0 ? (process.argv[agentFlag + 1] ?? "") : save ? (process.env.BOLNA_AGENT_ID ?? "") : "";
if (agentId) {
  await bolna("PUT", `/v2/agent/${agentId}`, agent);
  console.log(`Updated Bolna agent ${agentId}.`);
} else {
  const created = (await bolna("POST", "/v2/agent", agent)) as { agent_id?: string };
  agentId = created.agent_id ?? "";
  if (!agentId) fail("Bolna did not return an agent id.");
  console.log(`Created Bolna agent ${agentId}.`);
}
if (save) {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `BOLNA_AGENT_ID=${agentId}`;
  writeFileSync(envPath, /^BOLNA_AGENT_ID=.*$/m.test(text) ? text.replace(/^BOLNA_AGENT_ID=.*$/m, line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
  console.log("Saved BOLNA_AGENT_ID to .env.");
} else {
  console.log(`Set BOLNA_AGENT_ID=${agentId} on this site.`);
}
console.log(`Bolna now sends every turn to ${llmUrl}/chat/completions.`);

async function bolna(method: string, path: string, body?: unknown, quiet = false): Promise<unknown> {
  const response = await fetch(`${BOLNA}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    if (quiet) return null;
    fail(`Bolna ${method} ${path} failed with ${response.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
