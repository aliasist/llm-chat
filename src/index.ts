/**
 * Aliasist LLM Chat Worker
 * Powers the AI chat widget on aliasist.com via Cloudflare Workers AI.
 * API key never reaches the browser — all inference runs server-side.
 */
import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const ALIASIST_SYSTEM_PROMPT = `You are the Aliasist AI — the intelligent assistant embedded in aliasist.com, the developer portfolio and project hub of Blake, an AI security developer and CS student.

About Aliasist:
- Tagline: "Adversarial by Nature. Defensive by Design."
- Focus: AI security (AiSec), adversarial machine learning, open-source security tooling
- Projects: Aliasist-Files-Abductor (file automation CLI tool), DataSist (AI data center intelligence platform with 35+ facilities tracked), more in development
- App suite uses the "-sist" naming convention: FileSist, DataSist, etc.
- Stack: Python, JavaScript, React, Vite, Node.js, Cloudflare Workers
- Contact: dev@aliasist.com | github.com/aliasist
- Blake is self-taught, now formally studying Computer Information Systems, building toward AI security specialization (AiSec)

Your role: Answer questions about Aliasist, Blake's work, AI security, and tech topics. Be concise, technical, and direct. Keep responses under 3 paragraphs. Use the brand voice — professional, slightly alien-themed but grounded. Do not hallucinate project details not listed above.`;

// CORS headers — allow calls from aliasist.com and local dev
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// Serve static assets for non-API routes
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// POST /api/chat
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}
			return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Always inject Aliasist system prompt — override any client-provided one
		const filtered = messages.filter((m) => m.role !== "system");
		filtered.unshift({ role: "system", content: ALIASIST_SYSTEM_PROMPT });

		const stream = await env.AI.run(
			MODEL_ID,
			{
				messages: filtered,
				max_tokens: 512,
				stream: true,
			},
		);

		return new Response(stream, {
			headers: {
				...CORS_HEADERS,
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			},
		});
	} catch (error) {
		console.error("Chat error:", error);
		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { ...CORS_HEADERS, "content-type": "application/json" },
			},
		);
	}
}
