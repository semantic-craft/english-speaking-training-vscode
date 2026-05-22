import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type { JsonObject, ProviderName } from "./types.js";

export const MINIMAX_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic";
export const MIMO_ANTHROPIC_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";
export const MIMO_OPENAI_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MINIMAX_TTS_BASE_URL = "https://api.minimaxi.com/v1/t2a_v2";

export const secretKeys: Record<ProviderName, string> = {
  openai: "englishTraining.openaiKey",
  gemini: "englishTraining.geminiKey",
  minimax: "englishTraining.minimaxKey",
  mimo: "englishTraining.mimoKey",
};

let _output: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel): void {
  _output = channel;
}

export function getOutputChannel(): vscode.OutputChannel {
  if (!_output) {
    throw new Error("English Training output channel has not been initialized.");
  }
  return _output;
}

export function appendOutput(line: string): void {
  _output?.appendLine(line);
}

export function showOutput(preserveFocus = true): void {
  _output?.show(preserveFocus);
}

export function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("englishTraining").get<T>(key) as T;
}

export function configString(key: string, fallback = ""): string {
  const raw = config<unknown>(key);
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || fallback.trim();
}

export function expandHomePath(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const home = process.env.HOME;
  if (trimmed === "~") {
    return home || trimmed;
  }
  if (trimmed.startsWith("~/")) {
    return home ? path.join(home, trimmed.slice(2)) : trimmed;
  }
  return trimmed;
}

export function userConfigurationTarget(): vscode.ConfigurationTarget {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFile)
    || ((vscode.workspace.workspaceFolders?.length ?? 0) > 0);
  return hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * A bounded fetch. Node's global fetch has no default timeout, so a stalled
 * network (captive portal, dead VPN tunnel, a provider edge holding the
 * socket) makes `await fetch()` — or a stalled `await response.text()` —
 * never resolve and never reject, wedging the whole practice turn with no
 * self-recovery. AbortSignal.timeout stays armed through the body read too
 * (unlike a manually-cleared timer) and self-cleans, so the deadline covers
 * the entire request. 90s is well beyond any healthy LLM/STT/TTS response
 * but finite, so a true hang surfaces a clear, retryable error instead.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 90_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = HTTP_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s — the network or provider ` +
          `did not respond. Check your connection and press ↻ to retry.`,
      );
    }
    throw error;
  }
}

export function readJson(filePath: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseJsonObject(text: string, label = "JSON response"): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${label} returned invalid JSON: ${errorMessage(error)}. Body: ${text.slice(0, 600)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error(`${label} returned ${kind} instead of a JSON object. Body: ${text.slice(0, 600)}`);
  }
  return parsed as JsonObject;
}

/**
 * Like readJson, but distinguishes "file is absent" (legitimately empty,
 * fall back silently) from "file exists but is unreadable or malformed JSON"
 * (the user has materials and made a typo / path mistake — must NOT degrade
 * silently). The plain readJson swallows both as undefined; for the core
 * lesson package that conflation shows an enabled record button over a totally
 * empty lesson with no hint that a trailing comma / markdown fence broke the
 * JSON.
 */
export function readJsonDiagnosed(
  filePath: string,
): { data: JsonObject | undefined; parseError?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (fs.existsSync(filePath)) {
      return { data: undefined, parseError: `Could not read JSON: ${errorMessage(error)}` };
    }
    return { data: undefined };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      return { data: undefined, parseError: `JSON root must be an object; got ${kind}` };
    }
    return { data: parsed as JsonObject };
  } catch (error) {
    return { data: undefined, parseError: errorMessage(error) };
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveFfmpegPath(): string {
  const configured = expandHomePath(configString("nativeRecorderFfmpegPath", "ffmpeg"));
  if (configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return configured;
}

export async function getRequiredKey(
  context: vscode.ExtensionContext,
  provider: ProviderName,
): Promise<string> {
  const key = (await context.secrets.get(secretKeys[provider]) || "").trim();
  if (!key) {
    throw new Error(
      `Missing ${providerLabel(provider)} API key. Open the Command Palette and run “${providerKeyCommandTitle(provider)}”.`,
    );
  }
  return key;
}

// Exact Command Palette titles from package.json `contributes.commands`.
// "Run the configure command first" sent users hunting through five
// near-identical commands; naming the precise one makes the error actionable.
export function providerKeyCommandTitle(provider: ProviderName): string {
  const titles: Record<ProviderName, string> = {
    openai: "English Training: Configure OpenAI API Key",
    gemini: "English Training: Configure Gemini API Key",
    minimax: "English Training: Configure MiniMax API Key",
    mimo: "English Training: Configure Xiaomi MiMo API Key",
  };
  return titles[provider];
}

export function providerLabel(provider: ProviderName): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  if (provider === "minimax") return "MiniMax";
  return "MiMo";
}

export function isProviderName(value: unknown): value is ProviderName {
  return (
    value === "openai" ||
    value === "gemini" ||
    value === "minimax" ||
    value === "mimo"
  );
}

export function normalizedProviderName(value: unknown): ProviderName | undefined {
  const provider = stringValue(value).trim().toLowerCase();
  return isProviderName(provider) ? provider : undefined;
}

export function isCoachProvider(value: unknown): value is ProviderName {
  return (
    value === "gemini" ||
    value === "mimo" ||
    value === "openai"
  );
}

export function isAudioUnderstandingProvider(value: unknown): value is ProviderName {
  return value === "gemini" || value === "openai" || value === "mimo";
}

export function isTtsProvider(value: unknown): value is ProviderName {
  return (
    value === "minimax" || value === "gemini" || value === "openai" || value === "mimo"
  );
}

export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

export function parseLooseJson(text: string): JsonObject {
  const cleaned = stripJsonFence(text);
  const candidates = uniqueStrings([
    cleaned,
    extractCompleteJsonObject(cleaned),
    extractOuterJsonObject(cleaned),
  ]);

  for (const candidate of candidates) {
    for (const variant of repairJsonCandidates(candidate)) {
      const parsed = tryParseJsonObject(variant);
      if (parsed) {
        if (variant !== candidate) {
          appendOutput("Recovered malformed coaching JSON from provider response.");
        }
        return parsed;
      }
    }
  }

  const recovered = recoverCoachingJson(cleaned);
  if (recovered) {
    appendOutput("Recovered partial coaching JSON from provider response.");
    return recovered;
  }
  throw new Error(`Could not parse coaching JSON after repair: ${cleaned.slice(0, 600)}`);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]));
}

function tryParseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function repairJsonCandidates(text: string): string[] {
  const escaped = escapeControlCharsInJsonStrings(text);
  return uniqueStrings([
    text,
    escaped,
    removeTrailingCommas(escaped),
    closePartialJsonObject(escaped),
    closePartialJsonObject(removeTrailingCommas(escaped)),
  ]);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function escapeControlCharsInJsonStrings(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      result += char;
      inString = !inString;
      continue;
    }
    if (inString && char === "\n") {
      result += "\\n";
      continue;
    }
    if (inString && char === "\r") {
      result += "\\r";
      continue;
    }
    if (inString && char === "\t") {
      result += "\\t";
      continue;
    }
    result += char;
  }
  return result;
}

function extractCompleteJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function extractOuterJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function closePartialJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return trimmed;

  const state = scanJsonState(trimmed);
  let repaired = trimmed;
  if (state.escaped) {
    repaired += "\\";
  }
  if (state.inString) {
    repaired += '"';
  }
  repaired = repaired.replace(/,\s*$/g, "");
  repaired = repaired.replace(/:\s*$/g, '""');
  for (const closer of [...state.stack].reverse()) {
    repaired += closer;
  }
  return removeTrailingCommas(repaired);
}

function scanJsonState(text: string): {
  escaped: boolean;
  inString: boolean;
  stack: string[];
} {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if ((char === "}" || char === "]") && stack[stack.length - 1] === char) {
      stack.pop();
    }
  }
  return { escaped, inString, stack };
}

function recoverCoachingJson(text: string): JsonObject | undefined {
  const nativeVersion = extractJsonStringField(text, "native_version");
  const problems = extractJsonStringArray(text, "problems");
  const quickFix = extractJsonStringField(text, "quick_fix");
  const shadowingInstruction = extractJsonStringField(text, "shadowing_instruction");
  const followUpQuestion = extractJsonStringField(text, "follow_up_question");
  const nextDrill = extractJsonStringField(text, "next_drill");
  const errorTags = extractJsonStringArray(text, "error_tags");
  const scores = recoverScores(text);

  if (!nativeVersion && problems.length === 0 && !quickFix && !followUpQuestion) {
    return undefined;
  }

  const recovered: JsonObject = {
    _parse_recovered: true,
    native_version: nativeVersion,
    problems,
    error_tags: errorTags,
    scores,
    quick_fix: quickFix,
    shadowing_instruction:
      shadowingInstruction || (nativeVersion ? `Repeat once: ${nativeVersion}` : ""),
    follow_up_question: followUpQuestion,
    next_drill: nextDrill,
  };
  return recovered;
}

function extractJsonStringField(text: string, key: string): string {
  const valueStart = findJsonValueStart(text, key);
  if (valueStart < 0) return "";
  const start = skipWhitespace(text, valueStart);
  if (text[start] === '"') {
    return readJsonLikeString(text, start).value.trim();
  }
  const endMatch = text.slice(start).match(/[,}\]\n\r]/);
  const end = endMatch?.index === undefined ? text.length : start + endMatch.index;
  return text.slice(start, end).trim();
}

function extractJsonStringArray(text: string, key: string): string[] {
  const valueStart = findJsonValueStart(text, key);
  if (valueStart < 0) return [];
  let index = skipWhitespace(text, valueStart);
  if (text[index] !== "[") return [];
  index += 1;
  const values: string[] = [];
  while (index < text.length) {
    index = skipWhitespaceAndCommas(text, index);
    if (text[index] === "]") break;
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const item = readJsonLikeString(text, index);
    if (item.value.trim()) {
      values.push(item.value.trim());
    }
    index = item.nextIndex;
    if (!item.closed) break;
  }
  return values;
}

function findJsonValueStart(text: string, key: string): number {
  const keyPattern = `"${key}"`;
  const keyStart = text.indexOf(keyPattern);
  if (keyStart < 0) return -1;
  const colon = text.indexOf(":", keyStart + keyPattern.length);
  return colon < 0 ? -1 : colon + 1;
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }
  return index;
}

function skipWhitespaceAndCommas(text: string, index: number): number {
  while (index < text.length && (/[\s,]/.test(text[index]))) {
    index += 1;
  }
  return index;
}

function readJsonLikeString(text: string, quoteIndex: number): {
  closed: boolean;
  nextIndex: number;
  value: string;
} {
  let value = "";
  let escaped = false;
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      value += unescapeJsonChar(char);
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { closed: true, nextIndex: index + 1, value };
    }
    value += char;
  }
  return { closed: false, nextIndex: text.length, value };
}

function unescapeJsonChar(char: string): string {
  if (char === "n") return "\n";
  if (char === "r") return "\r";
  if (char === "t") return "\t";
  if (char === "b") return "\b";
  if (char === "f") return "\f";
  return char;
}

function recoverScores(text: string): JsonObject {
  const scores: JsonObject = {};
  for (const key of ["fluency", "accuracy", "naturalness"]) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*("?)(\\d)\\1`));
    if (match?.[2]) {
      scores[key] = Number(match[2]);
    }
  }
  return scores;
}

export function parseFirstJson(stdout: string): JsonObject | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    const parsed = tryParseJsonObject(trimmed);
    if (parsed) {
      return parsed;
    }
  }
  return tryParseJsonObject(stdout) ?? tryParseJsonObject(extractCompleteJsonObject(stdout) ?? "");
}

export function extractOpenAIText(parsed: JsonObject): string {
  const direct = stringValue(parsed.output_text);
  if (direct) return direct;
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        continue;
      }
      const messageValue = (choice as JsonObject).message;
      const message = messageValue && typeof messageValue === "object" && !Array.isArray(messageValue)
        ? messageValue as JsonObject
        : undefined;
      const content = message?.content;
      const textContent = typeof content === "string" ? content : "";
      if (textContent) return textContent;
      if (Array.isArray(content)) {
        const parts = content
          .map((part) =>
            part && typeof part === "object" && !Array.isArray(part)
              ? stringValue((part as JsonObject).text)
              : "",
          )
          .filter(Boolean);
        if (parts.length) return parts.join("\n");
      }
    }
  }
  const output = parsed.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const content = (item as JsonObject).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== "object" || Array.isArray(part)) {
            continue;
          }
          const partObj = part as JsonObject;
          const text = stringValue(partObj.text) || stringValue(partObj.output_text);
          if (text) parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return JSON.stringify(parsed);
}

export function extractGeminiText(parsed: JsonObject): string {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) return JSON.stringify(parsed);
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const contentValue = (candidate as JsonObject).content;
    const content = contentValue && typeof contentValue === "object" && !Array.isArray(contentValue)
      ? contentValue as JsonObject
      : undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    const text = parts
      .map((part) =>
        part && typeof part === "object" && !Array.isArray(part)
          ? stringValue((part as JsonObject).text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return JSON.stringify(parsed);
}

export function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item).trim()).filter(Boolean);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name || "Unknown error";
  }
  const direct = stringValue(error).trim();
  if (direct) {
    return direct;
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const obj = error as JsonObject;
    for (const key of ["message", "error", "reason", "statusText", "code"]) {
      const value = stringValue(obj[key]).trim();
      if (value) {
        return value;
      }
    }
  }
  return "Unknown error";
}

export function normalizeTtsSpeed(value: unknown, fallback = 0.9): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  const speed = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.max(0.5, Math.min(1.5, Number(speed.toFixed(2))));
}
