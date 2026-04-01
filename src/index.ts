/**
 * Aliasist LLM Chat Worker
 * Powers the AI chat widget on aliasist.com
 * Primary: Claude (Anthropic) — Fallback: Groq (llama-3.3-70b)
 * Keys stored as Cloudflare Worker secrets — never in the browser
 */

import { logChat, logUsage } from "./analytics";

export interface Env {
  ANTHROPIC_API_KEY: string;
  GROQ_API_KEY: string;
  ASSETS: Fetcher;
  ANALYTICS: D1Database;
}

// — Claude
const CLAUDE_MODEL = "claude-3-5-haiku-20241022"; // fast, cheap, great for chat
const CLAUDE_URL   = "https://api.anthropic.com/v1/messages";

// — Groq fallback
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";

const ALIASIST_SYSTEM = `You are the Aliasist AI — the intelligent assistant embedded in aliasist.com, the developer portfolio and project hub of Blake, an AI security developer and CS student.

About Aliasist:
- Tagline: "Adversarial by Nature. Defensive by Design."
- Focus: AI security (AiSec), adversarial machine learning, open-source security tooling
- Suite (all use the -sist suffix): DataSist (AI data center intelligence, 340+ global facilities), PulseSist (stock market intelligence), SpaceSist (live space portal), TikaSist (TikTok keyword intelligence), Aliasist-Files-Abductor (file automation CLI)
- Stack: Python, JavaScript, React, Vite, Cloudflare Workers, D1, Groq, Anthropic
- Contact: dev@aliasist.com | github.com/aliasist
- Blake is self-taught, now formally studying Computer Information Systems, building toward AI security specialization

Your role: Answer questions about Aliasist, Blake's work, AI security, and tech topics. Be concise, technical, and direct. Keep responses under 3 paragraphs. Professional, slightly alien-themed brand voice. Do not hallucinate project details.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({
        status: "ok",
        primary: env.ANTHROPIC_API_KEY ? "claude" : "groq",
        fallback: env.GROQ_API_KEY ? "groq" : "none",
      }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ── Claude (Anthropic Messages API) ──────────────────────────────────────────
async function callClaude(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const userMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: userMessages,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Claude ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);
  return data.content?.find((b) => b.type === "text")?.text ?? "// signal_lost";
}

// ── Groq (OpenAI-compatible) ──────────────────────────────────────────────────
async function callGroq(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const withSystem = [
    { role: "system", content: systemPrompt },
    ...messages.filter((m) => m.role !== "system"),
  ];

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: withSystem,
      max_tokens: 512,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Groq ${res.status}: ${err}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content ?? "// signal_lost";
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY) {
    return new Response(
      JSON.stringify({ error: "No AI keys configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY." }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  try {
    const { messages = [] } = await request.json() as {
      messages: Array<{ role: string; content: string }>;
    };

    const userMsg = messages.filter((m) => m.role !== "system").slice(-1)[0]?.content ?? "";
    let reply = "";
    let modelUsed = "";

    // Try Claude first, fall back to Groq
    if (env.ANTHROPIC_API_KEY) {
      try {
        reply = await callClaude(env.ANTHROPIC_API_KEY, ALIASIST_SYSTEM, messages);
        modelUsed = CLAUDE_MODEL;
      } catch (claudeErr) {
        console.warn("Claude failed, falling back to Groq:", claudeErr);
        if (env.GROQ_API_KEY) {
          reply = await callGroq(env.GROQ_API_KEY, ALIASIST_SYSTEM, messages);
          modelUsed = GROQ_MODEL;
        } else {
          throw claudeErr;
        }
      }
    } else {
      reply = await callGroq(env.GROQ_API_KEY, ALIASIST_SYSTEM, messages);
      modelUsed = GROQ_MODEL;
    }

    // Fire-and-forget analytics
    if (env.ANALYTICS) {
      ctx.waitUntil(logChat(env.ANALYTICS, "llm-chat", userMsg, reply, modelUsed));
      ctx.waitUntil(logUsage(env.ANALYTICS, "llm-chat", "ai-chat", "complete"));
    }

    return new Response(JSON.stringify({ response: reply, model: modelUsed }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Chat error:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
}
