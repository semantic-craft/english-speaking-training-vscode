import * as vscode from "vscode";

import {
  configString,
  extractGeminiText,
  fetchWithTimeout,
  getRequiredKey,
  getRequiredQwenCoachKey,
  MIMO_ANTHROPIC_BASE_URL,
  parseJsonObject,
  parseLooseJson,
  stringValue,
} from "../core.js";
import {
  normalizedCoachProvider,
  normalizedQwenCoachBaseUrl,
} from "../runtime/settings.js";
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
    "Use exactly these top-level keys: native_version, problems, error_tags, scores, quick_fix, shadowing_instruction, follow_up_question, next_drill, drill_examples, tts_style.",
    "Keep every string on one line; escape quotation marks as JSON; do not use trailing commas.",
    "When a shadow_target is provided, it is authoritative: native_version must copy shadow_target.reference_text exactly, and user_transcript is only an STT observation of the learner's imitation.",
    "Focus on natural spoken academic English, not generic encouragement.",
    "If a learner profile is provided, use it to adapt examples, terminology, tone, and follow-up questions.",
    "If prior_turn is present, the user_transcript is the learner replying to that follow_up_question; build on it instead of resetting the conversation.",
    "Without a shadow_target, give one native speaker version, 1-2 concrete problems, one quick fix, one shadowing instruction, and one specific follow-up question.",
    "Always include drill_examples: 2-4 short FSI-style substitution sentences the learner can immediately shadow next, using the same scenario, frames, or legal-academic topic.",
    "tts_style is a short English direction (under 25 words) for how the native_version should be SPOKEN aloud: accent, emotion, intonation, pacing, emphasis, or whispering. It steers the TTS voice; it is not feedback to the learner.",
    "Match tts_style to the scenario (e.g., 'Speak like a patient seminar professor; emphasize the modal verbs and slow down on the hedge phrases.' or 'Whisper softly so the learner can shadow the rhythm.'). Avoid generic instructions like 'speak naturally'.",
    "Explanations may be in Chinese, but native_version, follow_up_question, and tts_style must be natural English.",
  ].join(" ");
}

export function coachingUserPrompt(
  state: TrainingState,
  transcript: string,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
): string {
  const training = state.training;
  const frames = promptFrameTexts(training);
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
      tts_style:
        "short English direction for the next native_version's speaking style (accent, emotion, intonation, speed, tone, or whispering). Under 25 words. Specific, not generic.",
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
  const frames = promptFrameTexts(training);
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
    avoid_texts: compactPromptTexts(existing, 40, 240),
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

function promptFrameTexts(training: JsonObject): string[] {
  if (!Array.isArray(training.frames)) {
    return [];
  }
  return training.frames
    .map((item) =>
      typeof item === "object" && item && !Array.isArray(item)
        ? stringValue((item as JsonObject).text)
        : stringValue(item),
    )
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function compactPromptTexts(values: unknown[], maxItems: number, maxLength: number): string[] {
  const items: string[] = [];
  for (const value of values) {
    const text = stringValue(value).replace(/\s+/g, " ").trim();
    if (!text) {
      continue;
    }
    items.push(text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text);
    if (items.length >= maxItems) {
      break;
    }
  }
  return items;
}

export async function composeMaterialBrief(
  context: vscode.ExtensionContext,
  topic: string,
): Promise<string> {
  const parsed = await requestProviderJson(
    context,
    composeMaterialBriefSystemPrompt(),
    composeMaterialBriefUserPrompt(topic),
  );
  return formatMaterialBrief(parsed);
}

export function composeMaterialBriefSystemPrompt(): string {
  return [
    "You are an instructional designer for an English speaking-training tool used by an academic.",
    "The learner gives you a terse topic; you turn it into a precise brief for generating ONE daily",
    "spoken-English lesson (a 20-40s spoken answer the learner shadows and adapts).",
    "Return strict JSON only with these keys: scenario, interlocutor, goal, register, key_expressions,",
    "difficulty, success_sounds_like, prosody_focus, chinese_setup.",
    "scenario/goal/success_sounds_like/register/prosody_focus are short English strings;",
    "interlocutor is who the learner is speaking to; key_expressions is an array of 4-8 natural",
    "academic-spoken phrases or collocations; difficulty is one of beginner|intermediate|advanced;",
    "chinese_setup is a one-sentence Chinese task instruction for the learner.",
    "Stay in the learner's own domain inferred from the topic; do not invent unrelated content.",
    "Do not wrap the JSON in Markdown fences, comments, explanations, or trailing text.",
  ].join(" ");
}

export function composeMaterialBriefUserPrompt(topic: string): string {
  const payload: JsonObject = {
    topic: topic.trim(),
    request: {
      instruction:
        "Expand this topic into a brief for ONE daily speaking lesson. Keep it concrete and speakable; " +
        "the brief will be embedded into a package-generation prompt, not shown raw to the learner.",
    },
    output_shape: {
      scenario: "one line: who the learner talks to and what was asked",
      interlocutor: "who the learner is addressing",
      goal: "what a strong spoken answer accomplishes",
      register: "tone/formality the answer should hit",
      key_expressions: ["natural academic-spoken phrase", "another phrase"],
      difficulty: "beginner | intermediate | advanced",
      success_sounds_like: "what a good 20-40s answer sounds like",
      prosody_focus: "the stress/intonation skill worth drilling here",
      chinese_setup: "中文一句话任务说明",
    },
  };
  return JSON.stringify(payload, null, 2);
}

function formatMaterialBrief(parsed: JsonObject): string {
  const keyExpressions = Array.isArray(parsed.key_expressions)
    ? parsed.key_expressions.map((item) => stringValue(item).trim()).filter(Boolean)
    : [];
  const lines: string[] = [];
  const push = (label: string, value: string): void => {
    const text = value.trim();
    if (text) {
      lines.push(`- **${label}:** ${text}`);
    }
  };
  push("Scenario", stringValue(parsed.scenario));
  push("Speaking to", stringValue(parsed.interlocutor));
  push("Goal", stringValue(parsed.goal));
  push("Register", stringValue(parsed.register));
  push("Difficulty", stringValue(parsed.difficulty));
  push("A strong answer sounds like", stringValue(parsed.success_sounds_like));
  push("Prosody focus", stringValue(parsed.prosody_focus));
  push("Chinese setup", stringValue(parsed.chinese_setup));
  if (keyExpressions.length) {
    lines.push(`- **Key expressions:** ${keyExpressions.join("; ")}`);
  }
  const brief = lines.join("\n").trim();
  if (!brief) {
    throw new Error("Coach returned an empty material brief.");
  }
  return brief;
}

async function requestProviderJson(
  context: vscode.ExtensionContext,
  system: string,
  user: string,
): Promise<JsonObject> {
  const provider = normalizedCoachProvider();
  if (provider === "qwen") {
    const apiKey = await getRequiredQwenCoachKey(context);
    return callAnthropicJson(system, user, {
      provider: "Qwen Token Plan",
      apiKey,
      baseUrl: normalizedQwenCoachBaseUrl(),
      model: configString("qwenCoachModel", "qwen3.6-plus"),
    });
  }
  if (provider === "mimo") {
    const apiKey = await getRequiredKey(context, "mimo");
    return callAnthropicJson(system, user, {
      provider: "MiMo",
      apiKey,
      baseUrl: configString("mimoAnthropicBaseUrl", MIMO_ANTHROPIC_BASE_URL),
      model: configString("mimoCoachModel", "mimo-v2.5-pro"),
    });
  }
  const apiKey = await getRequiredKey(context, "gemini");
  return callGeminiJson(apiKey, configString("geminiCoachModel", "gemini-3.5-flash"), system, user);
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
  const response = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
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
  const parsed = parseJsonObject(body, `${options.provider} coach`);
  const text = extractAnthropicText(parsed);
  return parseLooseJson(stripThinkBlocks(text));
}

async function callGeminiJson(
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<JsonObject> {
  const response = await fetchWithTimeout(
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
  const parsed = parseJsonObject(body, "Gemini coach");
  return parseLooseJson(extractGeminiText(parsed));
}

function extractAnthropicText(parsed: JsonObject): string {
  const content = parsed.content;
  if (!Array.isArray(content)) {
    return JSON.stringify(parsed);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
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
