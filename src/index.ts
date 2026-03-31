/**
 * Aliasist LLM Chat Worker
 * Powers the AI chat widget on aliasist.com
 * Uses Groq API — key stored as Cloudflare Worker secret (never in browser)
 */

import { logChat, logUsage } from "./analytics";

export interface Env {
  GROQ_API_KEY: string;
  ASSETS: Fetcher;
  ANALYTICS: D1Database;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const ALIASIST_SYSTEM = `You are the Aliasist AI — the intelligent assistant embedded in aliasist.com, the developer portfolio and project hub of Blake, an AI security developer and CS student.

About Aliasist:
- Tagline: "Adversarial by Nature. Defensive by Design."
- Focus: AI security (AiSec), adversarial machine learning, open-source security tooling
- Projects: Aliasist-Files-Abductor (file automation CLI tool), DataSist (AI data center intelligence platform), PulseSist (stock market intelligence) — more in development
- App suite uses the "-sist" naming convention
- Stack: Python, JavaScript, React, Vite, Cloudflare Workers, D1
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // POST /api/chat
    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    // Health check
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Static assets
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Guard — if key missing the worker will silently fail with a 401 from Groq
  if (!env.GROQ_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GROQ_API_KEY not configured. Run: wrangler secret put GROQ_API_KEY" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }

  try {
    const { messages = [] } = await request.json() as {
      messages: Array<{ role: string; content: string }>;
    };

    // Always use Aliasist system prompt
    const filtered = messages.filter((m) => m.role !== "system");
    filtered.unshift({ role: "system", content: ALIASIST_SYSTEM });

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: filtered,
        max_tokens: 512,
        temperature: 0.7,
      }),
    });

    const data = await groqRes.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(data.error.message);
    }

    const reply = data.choices?.[0]?.message?.content ?? "// signal_lost";
    const userMsg = messages.filter((m) => m.role !== "system").slice(-1)[0]?.content ?? "";

    // Fire-and-forget: log conversation to aliasist-analytics D1
    if (env.ANALYTICS) {
      ctx.waitUntil(logChat(env.ANALYTICS, "llm-chat", userMsg, reply, GROQ_MODEL));
      ctx.waitUntil(logUsage(env.ANALYTICS, "llm-chat", "ai-chat", "complete"));
    }

    return new Response(JSON.stringify({ response: reply }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Chat error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
}
