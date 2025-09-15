import { StreamChunk, ReasoningData, ReasoningEndData, GeminiFunctionCall, UsageData } from "./types";
import { NativeToolResponse } from "./types/native-tools";
import { OPENAI_CHAT_COMPLETION_OBJECT } from "./config";

// OpenAI API interfaces
interface OpenAIToolCall {
	index: number;
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAIChoice {
	index: number;
	delta: OpenAIDelta;
	finish_reason: string | null;
	logprobs?: null;
	matched_stop?: null;
}

interface OpenAIDelta {
	role?: string;
	content?: string | null;
	reasoning?: string;
	reasoning_content?: string | null;
	reasoning_finished?: boolean;
	tool_calls?: OpenAIToolCall[];
	native_tool_calls?: NativeToolResponse[];
	grounding?: unknown;
}

interface OpenAIChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIChoice[];
	usage?: null;
}

interface OpenAIFinalChoice {
	index: number;
	delta: Record<string, never>;
	finish_reason: string;
}

interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

interface OpenAIFinalChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIFinalChoice[];
	usage?: OpenAIUsage;
}

// Type guard functions
function isReasoningData(data: unknown): data is ReasoningData {
	return typeof data === "object" && data !== null && ("reasoning" in data || "toolCode" in data);
}

function isReasoningEndData(data: unknown): data is ReasoningEndData {
	return typeof data === "object" && data !== null && "finished" in data;
}

function isGeminiFunctionCall(data: unknown): data is GeminiFunctionCall {
	return typeof data === "object" && data !== null && "name" in data && "args" in data;
}

function isUsageData(data: unknown): data is UsageData {
	return typeof data === "object" && data !== null && "inputTokens" in data && "outputTokens" in data;
}
function isNativeToolResponse(data: unknown): data is NativeToolResponse {
	return typeof data === "object" && data !== null && "type" in data && "data" in data;
}

/**
 * Creates a TransformStream to convert Gemini's output chunks
 * into OpenAI-compatible server-sent events.
 */
export function createOpenAIStreamTransformer(
    model: string,
    outputMode: string = "tagged"
): TransformStream<StreamChunk, Uint8Array> {
	const chatID = `chatcmpl-${crypto.randomUUID()}`;
	const creationTime = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	let firstChunk = true;
	let toolCallId: string | null = null;
	let toolCallName: string | null = null;
	let usageData: UsageData | undefined;

    // Normalize output mode aliases: prefer "tagged"; accept legacy "think-tags" as alias
    const rawMode = (outputMode || "tagged").toLowerCase();
    const mode = rawMode === "think-tags" ? "tagged" : rawMode;
    const isR1 = mode === "r1"; // DeepSeek Reasoner-compatible stream

    return new TransformStream({
		transform(chunk, controller) {
			const delta: OpenAIDelta = {};
			let openAIChunk: OpenAIChunk | null = null;

            switch (chunk.type) {
                case "text":
                case "thinking_content":
                    if (typeof chunk.data === "string") {
                        delta.content = chunk.data;
                        if (firstChunk) {
                            delta.role = "assistant";
                            firstChunk = false;
                        }
                    }
                    break;
                case "real_thinking":
                    if (typeof chunk.data === "string") {
                        if (isR1) {
                            // DeepSeek R1 spec: use delta.reasoning_content
                            delta.reasoning_content = chunk.data;
                        } else {
                            // Default custom field for non-R1 modes
                            delta.reasoning = chunk.data;
                        }
                    }
                    break;
                case "reasoning":
                    if (isReasoningData(chunk.data)) {
                        if (isR1) {
                            delta.reasoning_content = chunk.data.reasoning;
                        } else {
                            delta.reasoning = chunk.data.reasoning;
                        }
                    }
                    break;
                case "reasoning_end":
                    // DeepSeek chunks do not send a reasoning_finished flag; omit in R1 mode
                    if (!isR1 && isReasoningEndData(chunk.data)) {
                        delta.reasoning_finished = chunk.data.finished;
                    }
                    break;
                case "tool_code":
                    if (isGeminiFunctionCall(chunk.data)) {
						const toolData = chunk.data;
						toolCallName = toolData.name;
						toolCallId = `call_${crypto.randomUUID()}`;
						delta.tool_calls = [
							{
								index: 0,
								id: toolCallId,
								type: "function",
								function: {
									name: toolCallName,
									arguments: JSON.stringify(toolData.args)
								}
							}
						];
						if (firstChunk) {
							delta.role = "assistant";
							delta.content = null;
							firstChunk = false;
						}
					}
					break;
				case "native_tool":
					if (isNativeToolResponse(chunk.data)) {
						delta.native_tool_calls = [chunk.data];
					}
					break;
				case "grounding_metadata":
					if (chunk.data) {
						delta.grounding = chunk.data;
					}
					break;
				case "usage":
					if (isUsageData(chunk.data)) {
						usageData = chunk.data;
					}
					return; // Don't send a chunk for usage data
			}

			if (Object.keys(delta).length > 0) {
				openAIChunk = {
					id: chatID,
					object: OPENAI_CHAT_COMPLETION_OBJECT,
					created: creationTime,
					model: model,
					choices: [
						{
							index: 0,
							delta: delta,
							finish_reason: null,
							logprobs: null,
							matched_stop: null
						}
					],
					usage: null
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
			}
		},
        flush(controller) {
            const finishReason = toolCallId ? "tool_calls" : "stop";
            const finalChunk: OpenAIFinalChunk = {
                id: chatID,
                object: OPENAI_CHAT_COMPLETION_OBJECT,
                created: creationTime,
                model: model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            };

            if (usageData) {
                finalChunk.usage = {
                    prompt_tokens: usageData.inputTokens,
                    completion_tokens: usageData.outputTokens,
                    total_tokens: usageData.inputTokens + usageData.outputTokens
                };
            }

            // In R1 mode, DeepSeek also returns completion_tokens_details on responses;
            // for stream chunks we append the same object fields to the final event payload.
            type R1FinalPayload = OpenAIFinalChunk & {
                completion_tokens_details?: {
                    reasoning_tokens: number;
                };
            };
            const payload: R1FinalPayload = { ...finalChunk } as R1FinalPayload;
            if (isR1) {
                payload.completion_tokens_details = {
                    // Without tokenizer we can only provide a conservative placeholder
                    // to match the field shape; downstream can ignore if unused.
                    reasoning_tokens: 0
                };
            }

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
    });
}
