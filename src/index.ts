import { Hono } from "hono";
import { Env } from "./types";
import { OpenAIRoute, createOpenAIRoute } from "./routes/openai";
import { DebugRoute } from "./routes/debug";
import { openAIApiKeyAuth } from "./middlewares/auth";
import { loggingMiddleware } from "./middlewares/logging";

/**
 * Gemini CLI OpenAI Worker
 *
 * A Cloudflare Worker that provides OpenAI-compatible API endpoints
 * for Google's Gemini models via the Gemini CLI OAuth flow.
 *
 * Features:
 * - OpenAI-compatible chat completions and model listing
 * - OAuth2 authentication with token caching via Cloudflare KV
 * - Support for multiple Gemini models (2.5 Pro, 2.0 Flash, 1.5 Pro, etc.)
 * - Streaming responses compatible with OpenAI SDK
 * - Debug and testing endpoints for troubleshooting
 */

// Create the main Hono app
const app = new Hono<{ Bindings: Env }>();

// Add logging middleware
app.use("*", loggingMiddleware);

// Add CORS headers for all requests
app.use("*", async (c, next) => {
	// Set CORS headers
	c.header("Access-Control-Allow-Origin", c.env.CORS_ALLOW_ORIGIN || "*");
	c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

	// Handle preflight requests
	if (c.req.method === "OPTIONS") {
		c.status(204);
		return c.body(null);
	}

	await next();
});

// Apply OpenAI API key authentication middleware to all OpenAI-compatible routes
app.use("/v1/*", openAIApiKeyAuth);
// OpenAI mode path (LiteLLM/OpenAI-compatible reasoning fields)
app.use("/openai/v1/*", openAIApiKeyAuth);
app.use("/tagged/v1/*", openAIApiKeyAuth);
app.use("/hidden/v1/*", openAIApiKeyAuth);
app.use("/r1/v1/*", openAIApiKeyAuth);

// Setup OpenAI-compatible route handlers
// Default OpenAI-compatible endpoints (use environment-controlled mode)
app.route("/v1", OpenAIRoute);

// Variant endpoints that pin a specific reasoning output mode
// New canonical path for OpenAI/LiteLLM-style reasoning field
app.route("/openai/v1", createOpenAIRoute("openai"));
app.route("/tagged/v1", createOpenAIRoute("tagged"));
app.route("/hidden/v1", createOpenAIRoute("hidden"));
app.route("/r1/v1", createOpenAIRoute("r1"));

// Debug endpoints
app.route("/v1/debug", DebugRoute);
// Add individual debug routes to main app for backward compatibility
app.route("/v1", DebugRoute);

// Root endpoint - basic info about the service
app.get("/", (c) => {
	const requiresAuth = !!c.env.OPENAI_API_KEY;

	return c.json({
		name: "Gemini CLI OpenAI Worker",
		description: "OpenAI-compatible API for Google Gemini models via OAuth",
		version: "1.0.0",
		authentication: {
			required: requiresAuth,
			type: requiresAuth ? "Bearer token in Authorization header" : "None"
		},
		endpoints: {
			chat_completions: "/v1/chat/completions",
			models: "/v1/models",
			variants: {
				openai: "/openai/v1",
				tagged: "/tagged/v1",
				hidden: "/hidden/v1",
				r1: "/r1/v1"
			},
			debug: {
				cache: "/v1/debug/cache",
				token_test: "/v1/token-test",
				full_test: "/v1/test"
			}
		},
		reasoning_output_mode: (c.env.REASONING_OUTPUT_MODE || "openai").toLowerCase(),
		documentation: "https://github.com/gewoonjaap/gemini-cli-openai"
	});
});

// Health check endpoint
app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
