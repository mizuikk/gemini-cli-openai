import { geminiCliModels } from "../models";
import {
	DEFAULT_THINKING_BUDGET,
	DEFAULT_TEMPERATURE,
	REASONING_EFFORT_BUDGETS,
	GEMINI_SAFETY_CATEGORIES
} from "../constants";
import { ChatCompletionRequest, Env, EffortLevel, SafetyThreshold } from "../types";
import { NativeToolsConfiguration } from "../types/native-tools";

/**
 * Helper class to validate and correct generation configurations for different Gemini models.
 * Handles model-specific limitations and provides sensible defaults.
 */
export class GenerationConfigValidator {
	// --- Internal: JSON Schema (OpenAI-style) -> Gemini Schema converter ---
	private static toGeminiType(type: unknown): string | undefined {
		if (Array.isArray(type)) {
			// e.g. ["string", "null"]
			const nonNull = type.find((t) => t !== "null");
			return this.toGeminiType(nonNull);
		}
		switch (typeof type === "string" ? type.toLowerCase() : "") {
			case "object":
				return "OBJECT";
			case "string":
				return "STRING";
			case "number":
				return "NUMBER";
			case "integer":
				return "INTEGER";
			case "boolean":
				return "BOOLEAN";
			case "array":
				return "ARRAY";
			default:
				return undefined;
		}
	}

	private static normalizeProperties(input: unknown): Record<string, unknown> | undefined {
		if (!input) return undefined;
		if (Array.isArray(input)) {
			// Accept arrays of [key, value] tuples or {key, value} objects
			const obj: Record<string, unknown> = {};
			for (const item of input as unknown[]) {
				if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "string") {
					obj[item[0]] = item[1];
				} else if (item && typeof item === "object" && "key" in (item as any) && "value" in (item as any)) {
					const k = (item as any).key;
					if (typeof k === "string") obj[k] = (item as any).value;
				} else if (item && typeof item === "object" && "name" in (item as any) && "schema" in (item as any)) {
					const k = (item as any).name;
					if (typeof k === "string") obj[k] = (item as any).schema;
				}
			}
			return obj;
		}
		if (typeof input === "object") return input as Record<string, unknown>;
		return undefined;
	}

	private static stripUnsupportedKeys(schema: Record<string, unknown>): Record<string, unknown> {
		const allowList = new Set([
			"type",
			"description",
			"properties",
			"items",
			"required",
			"enum",
			"format",
			"nullable"
		]);

		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(schema)) {
			if (k.startsWith("$")) continue; // drop $schema, $id, etc.
			if (!allowList.has(k)) continue; // drop unknown keys like additionalProperties, oneOf, exclusiveMinimum...
			out[k] = v as unknown;
		}
		return out;
	}

	private static convertJSONSchemaToGeminiSchema(input: unknown): Record<string, unknown> | undefined {
		if (!input || typeof input !== "object") return undefined;

		const src = input as Record<string, unknown>;

		// Start with a shallow copy restricted to known keys
		const initial = this.stripUnsupportedKeys(src);

		// Map type to Gemini enum string
		if ((initial as any).type !== undefined) {
			const mappedType = this.toGeminiType((initial as any).type);
			if (mappedType) (initial as any).type = mappedType;
			else delete (initial as any).type; // unknown types are removed
		}

		// Handle nullable if type contained null previously
		if (Array.isArray((src as any).type) && (src as any).type.includes("null")) {
			(initial as any).nullable = true;
		}

		// Normalize properties
		if ((src as any).properties !== undefined) {
			const props = this.normalizeProperties((src as any).properties);
			if (props) {
				const convertedProps: Record<string, unknown> = {};
				for (const [name, sub] of Object.entries(props)) {
					const conv = this.convertJSONSchemaToGeminiSchema(sub);
					if (conv) convertedProps[name] = conv;
				}
				if (Object.keys(convertedProps).length > 0) (initial as any).properties = convertedProps;
			}
		}

		// Items (arrays)
		if ((src as any).items !== undefined) {
			if (Array.isArray((src as any).items)) {
				// If items is an array, pick the first schema
				const first = ((src as any).items as unknown[])[0];
				const conv = this.convertJSONSchemaToGeminiSchema(first);
				if (conv) (initial as any).items = conv;
			} else {
				const conv = this.convertJSONSchemaToGeminiSchema((src as any).items);
				if (conv) (initial as any).items = conv;
			}
		}

		// required
		if (Array.isArray((src as any).required)) {
			(initial as any).required = ((src as any).required as unknown[]).filter((r) => typeof r === "string");
		}

		// enum
		if (Array.isArray((src as any).enum)) {
			(initial as any).enum = (src as any).enum as unknown[];
		}

		// description
		if (typeof (src as any).description === "string") {
			(initial as any).description = (src as any).description;
		}

		// format (strings)
		if (typeof (src as any).format === "string") {
			(initial as any).format = (src as any).format;
		}

		return initial;
	}
	/**
	 * Maps reasoning effort to thinking budget based on model type.
	 * @param effort - The reasoning effort level
	 * @param modelId - The model ID to determine if it's a flash model
	 * @returns The corresponding thinking budget
	 */
	static mapEffortToThinkingBudget(effort: EffortLevel, modelId: string): number {
		const isFlashModel = modelId.includes("flash");

		switch (effort) {
			case "none":
				return REASONING_EFFORT_BUDGETS.none;
			case "low":
				return REASONING_EFFORT_BUDGETS.low;
			case "medium":
				return isFlashModel ? REASONING_EFFORT_BUDGETS.medium.flash : REASONING_EFFORT_BUDGETS.medium.default;
			case "high":
				return isFlashModel ? REASONING_EFFORT_BUDGETS.high.flash : REASONING_EFFORT_BUDGETS.high.default;
			default:
				return DEFAULT_THINKING_BUDGET;
		}
	}

	/**
	 * Type guard to check if a value is a valid EffortLevel.
	 * @param value - The value to check
	 * @returns True if the value is a valid EffortLevel
	 */
	static isValidEffortLevel(value: unknown): value is EffortLevel {
		return typeof value === "string" && ["none", "low", "medium", "high"].includes(value);
	}

	/**
	 * Creates safety settings configuration for Gemini API.
	 * @param env - Environment variables containing safety thresholds
	 * @returns Safety settings configuration
	 */
	static createSafetySettings(env: Env): Array<{ category: string; threshold: SafetyThreshold }> {
		const safetySettings: Array<{ category: string; threshold: SafetyThreshold }> = [];

		if (env.GEMINI_MODERATION_HARASSMENT_THRESHOLD) {
			safetySettings.push({
				category: GEMINI_SAFETY_CATEGORIES.HARASSMENT,
				threshold: env.GEMINI_MODERATION_HARASSMENT_THRESHOLD
			});
		}

		if (env.GEMINI_MODERATION_HATE_SPEECH_THRESHOLD) {
			safetySettings.push({
				category: GEMINI_SAFETY_CATEGORIES.HATE_SPEECH,
				threshold: env.GEMINI_MODERATION_HATE_SPEECH_THRESHOLD
			});
		}

		if (env.GEMINI_MODERATION_SEXUALLY_EXPLICIT_THRESHOLD) {
			safetySettings.push({
				category: GEMINI_SAFETY_CATEGORIES.SEXUALLY_EXPLICIT,
				threshold: env.GEMINI_MODERATION_SEXUALLY_EXPLICIT_THRESHOLD
			});
		}

		if (env.GEMINI_MODERATION_DANGEROUS_CONTENT_THRESHOLD) {
			safetySettings.push({
				category: GEMINI_SAFETY_CATEGORIES.DANGEROUS_CONTENT,
				threshold: env.GEMINI_MODERATION_DANGEROUS_CONTENT_THRESHOLD
			});
		}

		return safetySettings;
	}

	/**
	 * Validates and corrects the thinking budget for a specific model.
	 * @param modelId - The Gemini model ID
	 * @param thinkingBudget - The requested thinking budget
	 * @returns The corrected thinking budget
	 */
	static validateThinkingBudget(modelId: string, thinkingBudget: number): number {
		const modelInfo = geminiCliModels[modelId];

		// For thinking models, validate the budget
		if (modelInfo?.thinking) {
			// Gemini 2.5 Pro and Flash don't support thinking_budget: 0
			// They require -1 (dynamic allocation) or positive numbers
			if (thinkingBudget === 0) {
				console.log(`[GenerationConfig] Model '${modelId}' doesn't support thinking_budget: 0, using -1 instead`);
				return DEFAULT_THINKING_BUDGET; // -1
			}

			// Validate positive budget values (optional: add upper limits if needed)
			if (thinkingBudget < -1) {
				console.log(
					`[GenerationConfig] Invalid thinking_budget: ${thinkingBudget} for model '${modelId}', using -1 instead`
				);
				return DEFAULT_THINKING_BUDGET; // -1
			}
		}

		return thinkingBudget;
	}

	/**
	 * Creates a validated generation config for a specific model.
	 * @param modelId - The Gemini model ID
	 * @param options - Generation options including thinking budget and OpenAI parameters
	 * @param isRealThinkingEnabled - Whether real thinking is enabled
	 * @param includeReasoning - Whether to include reasoning in response
	 * @param env - Environment variables for safety settings
	 * @returns Validated generation configuration
	 */
	static createValidatedConfig(
		modelId: string,
		options: Partial<ChatCompletionRequest> = {},
		isRealThinkingEnabled: boolean,
		includeReasoning: boolean
	): Record<string, unknown> {
		const generationConfig: Record<string, unknown> = {
			temperature: options.temperature ?? DEFAULT_TEMPERATURE,
			maxOutputTokens: options.max_tokens,
			topP: options.top_p,
			stopSequences: typeof options.stop === "string" ? [options.stop] : options.stop,
			presencePenalty: options.presence_penalty,
			frequencyPenalty: options.frequency_penalty,
			seed: options.seed
		};

		if (options.response_format?.type === "json_object") {
			generationConfig.responseMimeType = "application/json";
		}

		const modelInfo = geminiCliModels[modelId];
		const isThinkingModel = modelInfo?.thinking || false;

		if (isThinkingModel) {
			let thinkingBudget = options.thinking_budget ?? DEFAULT_THINKING_BUDGET;

			// Handle reasoning effort mapping to thinking budget
			const reasoning_effort =
				options.reasoning_effort || options.extra_body?.reasoning_effort || options.model_params?.reasoning_effort;

			if (reasoning_effort && this.isValidEffortLevel(reasoning_effort)) {
				thinkingBudget = this.mapEffortToThinkingBudget(reasoning_effort, modelId);
				// If effort is "none", disable reasoning
				if (reasoning_effort === "none") {
					includeReasoning = false;
				} else {
					includeReasoning = true;
				}
			}

			const validatedBudget = this.validateThinkingBudget(modelId, thinkingBudget);

			if (isRealThinkingEnabled && includeReasoning) {
				// Enable thinking with validated budget
				generationConfig.thinkingConfig = {
					thinkingBudget: validatedBudget,
					includeThoughts: true // Critical: This enables thinking content in response
				};
				console.log(`[GenerationConfig] Real thinking enabled for '${modelId}' with budget: ${validatedBudget}`);
			} else {
				// For thinking models, always use validated budget (can't use 0)
				// Control thinking visibility with includeThoughts instead
				generationConfig.thinkingConfig = {
					thinkingBudget: this.validateThinkingBudget(modelId, DEFAULT_THINKING_BUDGET),
					includeThoughts: false // Disable thinking visibility in response
				};
			}
		}

		// Remove undefined keys
		Object.keys(generationConfig).forEach((key) => generationConfig[key] === undefined && delete generationConfig[key]);
		return generationConfig;
	}

	static createValidateTools(options: Partial<ChatCompletionRequest> = {}) {
		const tools = [];
		let toolConfig = {};
		// Add tools configuration if provided
		if (Array.isArray(options.tools) && options.tools.length > 0) {
			const functionDeclarations = options.tools.map((tool) => {
				const converted = this.convertJSONSchemaToGeminiSchema(tool.function.parameters || {});
				return {
					name: tool.function.name,
					description: tool.function.description,
					parameters: converted
				};
			});

			tools.push({ functionDeclarations });
			// Handle tool choice
			if (options.tool_choice) {
				if (options.tool_choice === "auto") {
					toolConfig = { functionCallingConfig: { mode: "AUTO" } };
				} else if (options.tool_choice === "none") {
					toolConfig = { functionCallingConfig: { mode: "NONE" } };
				} else if (typeof options.tool_choice === "object" && options.tool_choice.function) {
					toolConfig = {
						functionCallingConfig: {
							mode: "ANY",
							allowedFunctionNames: [options.tool_choice.function.name]
						}
					};
				}
			}
		}

		return { tools, toolConfig };
	}
	static createFinalToolConfiguration(
		config: NativeToolsConfiguration,
		options: Partial<ChatCompletionRequest> = {}
	): {
		tools: unknown[] | undefined;
		toolConfig: unknown | undefined;
	} {
		if (config.useCustomTools && config.customTools && config.customTools.length > 0) {
			const { toolConfig } = this.createValidateTools(options);
			return {
				tools: [
					{
						functionDeclarations: config.customTools.map((t) => ({
							name: t.function.name,
							description: t.function.description,
							parameters: this.convertJSONSchemaToGeminiSchema(t.function.parameters || {})
						}))
					}
				],
				toolConfig: toolConfig
			};
		}

		if (config.useNativeTools && config.nativeTools && config.nativeTools.length > 0) {
			return {
				tools: config.nativeTools.map((tool) => {
					if (tool.google_search) {
						return { google_search: tool.google_search };
					}
					if (tool.url_context) {
						return { url_context: tool.url_context };
					}
					return tool;
				}),
				toolConfig: undefined // Native tools don't use toolConfig in the same way
			};
		}

		// If no tools are enabled or the tool lists are empty, return undefined
		return { tools: undefined, toolConfig: undefined };
	}
}
