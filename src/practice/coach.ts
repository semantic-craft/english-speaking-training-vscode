import * as vscode from "vscode";

import {
  appendOutput,
  chatCompletionsUrl,
  config,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  extractGeminiText,
  extractOpenAIText,
  getRequiredKey,
  MIMO_ANTHROPIC_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL,
  parseLooseJson,
  stringValue,
} from "../core.js";
import type {
  CoachPriorTurn,
  DrillExample,
  JsonObject,
  PracticeTarget,
  TrainingState,
} from "../types.js";

export async function coachTranscript(
  context: vscode.ExtensionContext,
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
): Promise<JsonObject> {
  return requestProviderJson(
    context,
    coachingSystemPrompt(),
    coachingUserPrompt(state, transcript, priorTurn, practiceTarget),
  );
}

export function coachingSystemPrompt(): string {
  return [
    "You are an English speaking coach for a Chinese legal academic.",
    "Return strict JSON only.",
    "Do not wrap the JSON in Markdown fences, comments, explanations, or trailing text.",
    "Use exactly these top-level keys: native_version, problems, error_tags, scores, quick_fix, shadowing_instruction, follow_up_question, next_drill, drill_examples.",
    "Keep every string on one line; escape quotation marks as JSON; do not use trailing commas.",
    "When a shadow_target is provided, it is authoritative: native_version must copy shadow_target.reference_text exactly, and user_transcript is only an STT observation of the learner's imitation.",
    "Focus on natural spoken academic English, not generic encouragement.",
    "If a learner profile is provided, use it to adapt examples, terminology, tone, and follow-up questions.",
    "If prior_turn is present, the user_transcript is the learner replying to that follow_up_question; build on it instead of resetting the conversation.",
    "Without a shadow_target, give one native speaker version, 1-2 concrete problems, one quick fix, one shadowing instruction, and one specific follow-up question.",
    "Always include drill_examples: 2-4 short FSI-style substitution sentences the learner can immediately shadow next, using the same scenario, frames, or legal-academic topic.",
    "Explanations may be in Chinese, but native_version and follow_up_question must be natural English.",
  ].join(" ");
}

export function coachingUserPrompt(
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
): string {
  const training = state.training;
  const frames = Array.isArray(training.frames)
    ? training.frames
        .map((item) =>
          typeof item === "object" && item ? stringValue((item as JsonObject).text) : stringValue(item),
        )
        .filter(Boolean)
    : [];
  const payload: JsonObject = {
    task: {
      package_date: stringValue(state.next.package_date),
      goal: stringValue(training.goal) || stringValue(state.next.goal),
      scenario: stringValue(training.scenario) || stringValue(state.next.scenario),
      frames,
    },
    learner_profile: state.learnerProfile.loaded
      ? {
          source: state.learnerProfile.source,
          summary: state.learnerProfile.summary,
          content: state.learnerProfile.content,
        }
      : null,
    user_transcript: transcript,
    output_shape: {
      native_version: practiceTarget?.referenceText
        ? "copy shadow_target.reference_text exactly"
        : "one natural spoken English version of what the user meant",
      problems: ["1-2 concrete issues in Chinese, with tiny English examples if useful"],
      error_tags: ["0-3 of [TA], [ART], [COUNT], [REF], [ORG], [LINK], [PRAG], [PROS]"],
      scores: {
        fluency: "integer 1-5",
        accuracy: "integer 1-5",
        naturalness: "integer 1-5",
      },
      quick_fix: "one practical fix in Chinese",
      shadowing_instruction: "short instruction asking user to repeat the native version once",
      follow_up_question: practiceTarget?.followUpQuestion
        ? "copy shadow_target.follow_up_question exactly"
        : practiceTarget?.referenceText
          ? "empty string; this is only a shadowing check"
          : "one specific English follow-up question",
      next_drill: "one short FSI-style drill instruction for the next repetition",
      drill_examples: [
        {
          label: "short cue label",
          text: "one complete English sentence for FSI substitution or shadowing",
          reason: "brief Chinese reason, e.g. 替换 claim slot / 练 nucleus stress",
        },
      ],
    },
  };
  if (state.drill && Object.keys(state.drill).length) {
    payload.fsi_drill = state.drill;
  }
  if (practiceTarget?.referenceText) {
    payload.shadow_target = {
      mode: practiceTarget.mode,
      reference_label: practiceTarget.referenceLabel || "Reference",
      reference_text: practiceTarget.referenceText,
      follow_up_question: practiceTarget.followUpQuestion || "",
      instruction:
        "Compare user_transcript against reference_text for shadowing. Do not treat STT wording errors as the learner's intended wording, and never replace reference_text with user_transcript.",
    };
  }
  if (priorTurn) {
    payload.prior_turn = {
      coach_native_version: priorTurn.nativeVersion,
      coach_follow_up_question: priorTurn.followUpQuestion,
      learner_previous_transcript: priorTurn.userTranscript,
    };
  }
  return JSON.stringify(payload, null, 2);
}

/**
 * Generate fresh FSI-style substitution lines for the current package, so the
 * learner can keep drilling beyond the prebuilt rounds. Routed through the same
 * configured coach provider as {@link coachTranscript}.
 */
export async function generateDrillLines(
  context: vscode.ExtensionContext,
  state: TrainingState,
  count: number,
  existing: string[] = [],
): Promise<DrillExample[]> {
  const n = Math.max(1, Math.min(12, Math.floor(count) || 5));
  const parsed = await requestProviderJson(
    context,
    drillGenSystemPrompt(),
    drillGenUserPrompt(state, n, existing),
  );
  const raw = Array.isArray(parsed.lines)
    ? parsed.lines
    : Array.isArray((parsed as JsonObject).drill_examples)
      ? ((parsed as JsonObject).drill_examples as unknown[])
      : [];
  const out: DrillExample[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = item.replace(/\s+/g, " ").trim();
      if (text) {
        out.push({ label: "FSI drill", text, source: "coach" });
      }
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as JsonObject;
    const text = stringValue(obj.text).replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }
    out.push({
      label: stringValue(obj.label || obj.cue || obj.id).trim() || "FSI drill",
      text,
      reason: stringValue(obj.reason || obj.note).trim(),
      source: "coach",
    });
  }
  return out.slice(0, n);
}

export function drillGenSystemPrompt(): string {
  return [
    "You are an FSI-style English drill writer for a Chinese legal academic.",
    'Return strict JSON only: {"lines":[{"label":"...","text":"...","reason":"..."}]}.',
    "Do not wrap the JSON in Markdown fences, comments, explanations, or trailing text.",
    "Each text is ONE complete, natural spoken English sentence the learner can immediately shadow.",
    "Stay on the same scenario, frames, and legal-academic register as the task; vary the substitution slot every line.",
    "label is a short English cue; reason is a brief Chinese note (e.g. 替换 claim 槽位 / 练 nucleus 重音).",
    "Never repeat or lightly paraphrase any sentence listed in avoid_texts.",
  ].join(" ");
}

export function drillGenUserPrompt(state: TrainingState, count: number, existing: string[]): string {
  const training = state.training;
  const frames = Array.isArray(training.frames)
    ? training.frames
        .map((item) =>
          typeof item === "object" && item ? stringValue((item as JsonObject).text) : stringValue(item),
        )
        .filter(Boolean)
    : [];
  const payload: JsonObject = {
    task: {
      package_date: stringValue(state.next.package_date),
      goal: stringValue(training.goal) || stringValue(state.next.goal),
      scenario: stringValue(training.scenario) || stringValue(state.next.scenario),
      frames,
    },
    learner_profile: state.learnerProfile.loaded
      ? {
          source: state.learnerProfile.source,
          summary: state.learnerProfile.summary,
        }
      : null,
    request: {
      count,
      instruction:
        "Produce fresh FSI substitution lines that extend the existing drill without repeating it.",
    },
    avoid_texts: existing.filter(Boolean).slice(0, 40),
    output_shape: {
      lines: [
        {
          label: "short English cue",
          text: "one complete spoken English sentence",
          reason: "brief Chinese note on the substitution or prosody focus",
        },
      ],
    },
  };
  if (state.drill && Object.keys(state.drill).length) {
    payload.fsi_drill = state.drill;
  }
  return JSON.stringify(payload, null, 2);
}

async function requestProviderJson(
  context: vscode.ExtensionContext,
  system: string,
  user: string,
): Promise<JsonObject> {
  const provider = config<string>("coachProvider") || "gemini";
  if (provider === "gemini") {
    const apiKey = await getRequiredKey(context, "gemini");
    return callGeminiJson(apiKey, config<string>("geminiCoachModel") || "gemini-3-flash-preview", system, user);
  }
  if (provider === "openai") {
    const apiKey = await getRequiredKey(context, "openai");
    return callOpenAIJson(apiKey, config<string>("openaiCoachModel") || "gpt-4o-mini", system, user);
  }
  if (provider === "kimi") {
    const apiKey = await getRequiredKey(context, "kimi");
    return callOpenAICompatibleJson(system, user, {
      provider: "Kimi",
      baseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
      model: config<string>("kimiCoachModel") || "kimi-for-coding",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }
  if (provider === "mimo") {
    const apiKey = await getRequiredKey(context, "mimo");
    return callAnthropicJson(system, user, {
      provider: "MiMo",
      apiKey,
      baseUrl: config<string>("mimoAnthropicBaseUrl") || MIMO_ANTHROPIC_BASE_URL,
      model: config<string>("mimoCoachModel") || "mimo-v2.5-pro",
    });
  }
  if (provider === "deepseek") {
    const apiKey = await getRequiredKey(context, "deepseek");
    return callAnthropicJson(system, user, {
      provider: "DeepSeek",
      apiKey,
      baseUrl: config<string>("deepseekAnthropicBaseUrl") || DEEPSEEK_ANTHROPIC_BASE_URL,
      model: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
    });
  }
  const apiKey = await getRequiredKey(context, "minimax");
  return callAnthropicJson(system, user, {
    provider: "MiniMax",
    apiKey,
    baseUrl: config<string>("minimaxAnthropicBaseUrl") || MINIMAX_ANTHROPIC_BASE_URL,
    model: config<string>("minimaxCoachModel") || "MiniMax-M2.7",
  });
}

async function callOpenAIJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<JsonObject> {
  const input = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input, text: { format: { type: "json_object" } } }),
  });
  const body = await response.text();
  if (response.ok) {
    return parseLooseJson(extractOpenAIText(JSON.parse(body) as JsonObject));
  }

  appendOutput(`OpenAI Responses API failed, falling back to chat completions: ${body.slice(0, 600)}`);
  const fallback = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages: input, response_format: { type: "json_object" } }),
  });
  const fallbackBody = await fallback.text();
  if (!fallback.ok) {
    throw new Error(`OpenAI request failed (${fallback.status}): ${fallbackBody.slice(0, 1200)}`);
  }
  return parseLooseJson(extractOpenAIText(JSON.parse(fallbackBody) as JsonObject));
}

async function callAnthropicJson(
  system: string,
  user: string,
  options: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    model: string;
  },
): Promise<JsonObject> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "X-Api-Key": options.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 2048,
      system,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: user }],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.provider} request failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const text = extractAnthropicText(parsed);
  return parseLooseJson(stripThinkBlocks(text));
}

async function callOpenAICompatibleJson(
  system: string,
  user: string,
  options: {
    provider: string;
    baseUrl: string;
    model: string;
    headers: Record<string, string>;
    responseFormat?: JsonObject;
  },
): Promise<JsonObject> {
  const requestBody: JsonObject = {
    model: options.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
  };
  if (options.provider !== "Kimi") {
    requestBody.temperature = 0.2;
  }
  if (options.responseFormat) {
    requestBody.response_format = options.responseFormat;
  }
  const response = await fetch(chatCompletionsUrl(options.baseUrl), {
    method: "POST",
    headers: {
      ...options.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.provider} request failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  return parseLooseJson(stripThinkBlocks(extractOpenAIText(JSON.parse(body) as JsonObject)));
}

async function callGeminiJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<JsonObject> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: system }],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: user }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  return parseLooseJson(extractGeminiText(parsed));
}

function extractAnthropicText(parsed: JsonObject): string {
  const content = parsed.content;
  if (!Array.isArray(content)) {
    return JSON.stringify(parsed);
  }
  const parts: string[] = [];
  for (const block of content) {
    const blockObj = block as JsonObject;
    const type = stringValue(blockObj.type);
    if (type === "text") {
      const text = stringValue(blockObj.text);
      if (text) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n") : JSON.stringify(parsed);
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}
