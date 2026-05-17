import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  appendOutput,
  arrayOfStrings,
  config,
  errorMessage,
  stamp,
  stringValue,
  writeJson,
} from "../core.js";
import type {
  CoachPriorTurn,
  DrillExample,
  JsonObject,
  PracticeTarget,
  PracticeResult,
  StageReporter,
  TrainingState,
} from "../types.js";
import { coachTranscript } from "./coach.js";
import { transcribeAudio } from "./transcribe.js";
import {
  speechOutputExtension,
  speechOutputFileName,
  synthesizeWithConfiguredTts,
} from "./tts.js";

export async function processPracticeFile(
  context: vscode.ExtensionContext,
  state: TrainingState,
  inputPath: string,
  mimeType: string,
  sessionDir: string,
  packageDate: string,
  progress?: StageReporter,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
): Promise<PracticeResult> {
  const target = normalizePracticeTarget(practiceTarget);
  progress?.("transcribe", "active");
  const transcript = await transcribeAudio(context, inputPath, mimeType, sessionDir);
  fs.writeFileSync(path.join(sessionDir, "transcript.txt"), `${transcript}\n`, "utf8");
  progress?.("transcribe", "done");

  progress?.("coach", "active");
  const coaching = target
    ? shadowCheckCoaching(state, transcript, target)
    : await coachTranscript(context, state, transcript, priorTurn, target);
  const nativeVersion =
    target?.referenceText ||
    stringValue(coaching.native_version) ||
    stringValue(coaching.nativeVersion) ||
    transcript;
  const problems = normalizeProblems(transcript, nativeVersion, target, coaching);
  const quickFix =
    (target
      ? stringValue(coaching.quick_fix) ||
        stringValue(coaching.quickFix) ||
        "以右侧 Reference 为准，先慢速跟读差异词，再完整读一遍。"
      : stringValue(coaching.quick_fix) || stringValue(coaching.quickFix));
  const followUpQuestion =
    target
      ? stringValue(target.followUpQuestion)
      : stringValue(coaching.follow_up_question) || stringValue(coaching.followUpQuestion);
  const shadowingInstruction =
    stringValue(coaching.shadowing_instruction) ||
    stringValue(coaching.shadowingInstruction) ||
    (target ? `Repeat the reference once: ${nativeVersion}` : `Repeat once: ${nativeVersion}`);
  const errorTags = normalizeErrorTags(coaching.error_tags ?? coaching.errorTags);
  const nextDrill =
    stringValue(coaching.next_drill) ||
    stringValue(coaching.nextDrill) ||
    nextDrillFromState(state, errorTags);
  const drillExamples = normalizeDrillExamples(coaching.drill_examples ?? coaching.drillExamples)
    .concat(drillExamplesFromState(state, nativeVersion))
    .filter(uniqueDrillExample())
    .filter((example) => normalizeComparableText(example.text) !== normalizeComparableText(transcript))
    .slice(0, 6);
  const scores = ((coaching.scores as JsonObject | undefined) ?? {}) as JsonObject;
  progress?.("coach", "done");

  progress?.("tts", "active");
  const ttsProvider = config<string>("ttsProvider") || "gemini";
  const outputAudio = path.join(sessionDir, speechOutputFileName(ttsProvider));
  let audioFile: string | undefined;
  if (nativeVersion.trim()) {
    audioFile = (await synthesizeWithConfiguredTts(context, nativeVersion, outputAudio, ttsProvider))
      .filePath;
  }
  let followUpAudioFile: string | undefined;
  if (followUpQuestion.trim()) {
    const followUpPath = path.join(
      sessionDir,
      `follow-up.${speechOutputExtension(ttsProvider)}`,
    );
    try {
      followUpAudioFile = (
        await synthesizeWithConfiguredTts(context, followUpQuestion, followUpPath, ttsProvider)
      ).filePath;
    } catch (error) {
      appendOutput(`Follow-up TTS failed: ${errorMessage(error)}`);
    }
  }
  progress?.("tts", "done");

  progress?.("save", "active");
  const result: PracticeResult = {
    transcript,
    nativeVersion,
    mode: target ? "shadow" : "free",
    referenceText: target?.referenceText,
    referenceLabel: target?.referenceLabel,
    problems,
    quickFix,
    followUpQuestion,
    shadowingInstruction,
    errorTags,
    nextDrill,
    drillExamples,
    scores,
    audioFile,
    followUpAudioFile,
    sessionDir,
    packageDate,
  };
  writeJson(path.join(sessionDir, "coach.json"), coaching);
  writeJson(path.join(sessionDir, "session.json"), {
    createdAt: new Date().toISOString(),
    packageDate,
    input: inputPath,
    result,
    settings: state.settings,
    drill: state.drill,
    sourceDiagnostics: state.sourceDiagnostics,
    learnerProfile: {
      loaded: state.learnerProfile.loaded,
      source: state.learnerProfile.source,
      summary: state.learnerProfile.summary,
    },
    priorTurn: priorTurn ?? null,
    practiceTarget: target ?? null,
  });
  writeSessionMarkdown(path.join(sessionDir, "session.md"), state, result);
  appendSessionLog(state, inputPath, result, coaching);
  progress?.("save", "done");
  return result;
}

export function appendSessionLog(
  state: TrainingState,
  inputPath: string,
  result: PracticeResult,
  coaching: JsonObject,
): void {
  const entry = {
    schema_version: "vscode-session-log-v1",
    session_id: path.basename(result.sessionDir),
    created_at: new Date().toISOString(),
    date: state.today,
    package_date: result.packageDate,
    engine_type: "voice-5min",
    training_type: stringValue(state.training.training_type),
    scene: inferScene(state.training),
    primary_tags: arrayOfStrings(state.training.primary_tags),
    drill_types_used: drillTypesUsed(state),
    providers: {
      speech_in: state.settings.audioUnderstandingProvider,
      coach: state.settings.coachProvider,
      speech_out: state.settings.ttsProvider,
    },
    input_audio: inputPath,
    transcript: result.transcript,
    native_version: result.nativeVersion,
    problems: result.problems,
    error_tags: result.errorTags,
    scores: result.scores,
    quick_fix: result.quickFix,
    follow_up_question: result.followUpQuestion,
    shadowing_instruction: result.shadowingInstruction,
    next_drill: result.nextDrill,
    drill_examples: result.drillExamples ?? [],
    mode: result.mode,
    reference_text: result.referenceText,
    reference_label: result.referenceLabel,
    audio_file: result.audioFile,
    session_dir: result.sessionDir,
    raw_coaching: coaching,
  };
  const logPath = sessionLogPath(state.root);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  writeJson(path.join(state.root, "runtime", "vscode-sessions", "session-log-latest.json"), entry);
}

function normalizePracticeTarget(target: PracticeTarget | undefined): PracticeTarget | undefined {
  const referenceText = stringValue(target?.referenceText).trim();
  if (!referenceText) {
    return undefined;
  }
  return {
    mode: "shadow",
    referenceText,
    referenceLabel: stringValue(target?.referenceLabel).trim() || "Reference",
    followUpQuestion: stringValue(target?.followUpQuestion).trim(),
  };
}

function shadowCheckCoaching(
  state: TrainingState,
  transcript: string,
  target: PracticeTarget,
): JsonObject {
  const matched = normalizeComparableText(transcript) === normalizeComparableText(target.referenceText);
  return {
    native_version: target.referenceText,
    problems: shadowProblems(transcript, target.referenceText, matched),
    error_tags: matched ? [] : ["[PROS]"],
    scores: {
      recognition_match: matched ? 1 : 0,
    },
    quick_fix: matched
      ? "识别文本和目标句基本一致。这一轮先算通过；下一轮重点放在重音、停顿和语调。"
      : "系统没有稳定识别出目标句。先不要复杂评分，直接重读差异词，尤其是被漏掉、替换或误识别的单词。",
    shadowing_instruction: `Repeat the reference once: ${target.referenceText}`,
    follow_up_question: target.followUpQuestion,
    next_drill: nextDrillFromState(state, matched ? [] : ["[PROS]"]),
    drill_examples: drillExamplesFromState(state, target.referenceText),
  };
}

function shadowProblems(transcript: string, reference: string, matched: boolean): string[] {
  if (matched) {
    return ["识别文本和目标句基本一致，说明这句的单词清晰度已经够用。"];
  }
  return [
    `目标句：${reference}`,
    `系统识别：${transcript || "（空）"}`,
    "这轮先按 STT 匹配处理：识别不出来或识别错的词，就是下一次要重读的发音重点。",
  ];
}

function normalizeProblems(
  transcript: string,
  nativeVersion: string,
  target: PracticeTarget | undefined,
  coaching: JsonObject,
): string[] {
  const coached = arrayOfStrings(coaching.problems).slice(0, 3);
  if (!target) {
    return coached;
  }
  if (normalizeComparableText(transcript) === normalizeComparableText(nativeVersion)) {
    return ["跟读文本与目标句基本一致。下一轮可以把重音和连读做得更自然。"];
  }
  return coached.length ? coached : shadowProblems(transcript, nativeVersion, false);
}

function normalizeComparableText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9']+/gi, " ").trim();
}

export function readRecentSessionLog(root: string, limit: number): JsonObject[] {
  const logPath = sessionLogPath(root);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  const recent: JsonObject[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      recent.push(JSON.parse(line) as JsonObject);
    } catch {
      continue;
    }
  }
  return recent;
}

export function sessionLogPath(root: string): string {
  return path.join(root, "runtime", "vscode-sessions", "session-log.jsonl");
}

export function inferScene(training: JsonObject): string {
  const scenario = `${stringValue(training.scenario)} ${stringValue(training.goal)}`.toLowerCase();
  if (
    scenario.includes("conference") ||
    scenario.includes("workshop") ||
    scenario.includes("seminar") ||
    scenario.includes("q&a")
  ) {
    return "S1";
  }
  if (scenario.includes("coffee") || scenario.includes("professor") || scenario.includes("network")) {
    return "S2";
  }
  return "S3";
}

export function drillTypesUsed(state: TrainingState): string[] {
  const method = stringValue(state.drill.method).toLowerCase();
  const used = new Set<string>();
  if (method.includes("substitution")) used.add("Substitution");
  if (method.includes("shadow")) used.add("Shadowing");
  const type = stringValue(state.training.training_type);
  if (type) used.add(type);
  if (used.size === 0) used.add("Voice-mode Free Chat");
  return Array.from(used);
}

export function normalizeErrorTags(value: unknown): string[] {
  const allowed = new Set(["[TA]", "[ART]", "[COUNT]", "[REF]", "[ORG]", "[LINK]", "[PRAG]", "[PROS]"]);
  return arrayOfStrings(value)
    .map((tag) => tag.trim().toUpperCase())
    .filter((tag) => allowed.has(tag))
    .slice(0, 3);
}

export function nextDrillFromState(state: TrainingState, errorTags: string[]): string {
  const frames = Array.isArray(state.training.frames)
    ? state.training.frames.map((item) => stringValue((item as JsonObject).text)).filter(Boolean)
    : [];
  const frame =
    frames[0] ||
    splitPracticeText(stringValue(state.training.clean_tts_text) || stringValue(state.training.audio_text))[0] ||
    "";
  const tagText = errorTags.length ? ` targeting ${errorTags.join(", ")}` : "";
  return frame
    ? `Do one FSI substitution loop${tagText}: repeat "${frame}", then replace one key phrase and say the full sentence again.`
    : `Do one FSI substitution loop${tagText}: keep the sentence frame stable and replace one slot quickly.`;
}

export function normalizeDrillExamples(value: unknown): DrillExample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index): DrillExample | undefined => {
      if (typeof item === "string") {
        const text = item.replace(/\s+/g, " ").trim();
        return text ? { label: `Example ${index + 1}`, text, source: "coach" } : undefined;
      }
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const obj = item as JsonObject;
      const text = stringValue(obj.text).replace(/\s+/g, " ").trim();
      if (!text) {
        return undefined;
      }
      return {
        label: stringValue(obj.label || obj.cue || obj.id).trim() || `Example ${index + 1}`,
        text,
        reason: stringValue(obj.reason || obj.note).trim(),
        source: stringValue(obj.source).trim() || "coach",
      };
    })
    .filter((item): item is DrillExample => Boolean(item));
}

export function drillExamplesFromState(state: TrainingState, currentText = ""): DrillExample[] {
  const examples: DrillExample[] = [];
  const current = normalizeComparableText(currentText);
  const rounds = Array.isArray(state.drill.rounds) ? state.drill.rounds : [];
  for (const round of rounds) {
    if (!round || typeof round !== "object") {
      continue;
    }
    const roundObj = round as JsonObject;
    const roundLabel = stringValue(roundObj.label || roundObj.id).trim() || "FSI drill";
    const roundExamples = Array.isArray(roundObj.examples) ? roundObj.examples : [];
    for (const item of roundExamples) {
      const itemObj = (item && typeof item === "object" ? item : {}) as JsonObject;
      const text = (typeof item === "string" ? item : stringValue(itemObj.text)).replace(/\s+/g, " ").trim();
      if (!text || normalizeComparableText(text) === current) {
        continue;
      }
      const cue = stringValue(itemObj.cue || itemObj.label).trim();
      examples.push({
        label: cue ? `${roundLabel}: ${cue}` : roundLabel,
        text,
        source: "prebuilt",
      });
    }
  }

  const chunks = (state.drill.shadowing_loop as JsonObject | undefined)?.chunks;
  if (Array.isArray(chunks)) {
    for (const [index, chunk] of chunks.entries()) {
      const text = stringValue(chunk).replace(/\s+/g, " ").trim();
      if (!text || normalizeComparableText(text) === current) {
        continue;
      }
      examples.push({
        label: `Shadowing chunk ${index + 1}`,
        text,
        source: "prebuilt",
      });
    }
  }

  return examples.filter(uniqueDrillExample());
}

function uniqueDrillExample(): (example: DrillExample) => boolean {
  const seen = new Set<string>();
  return (example) => {
    const key = normalizeComparableText(example.text);
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };
}

export function splitPracticeText(text: string): string[] {
  return text
    .replace(/<#\d+(?:\.\d+)?#>/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createSessionDir(root: string, packageDate: string): string {
  const dir = path.join(root, "runtime", "vscode-sessions", packageDate, stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeSessionMarkdown(
  filePath: string,
  state: TrainingState,
  result: PracticeResult,
): void {
  const lines = [
    `# VS Code Practice Session`,
    ``,
    `- Date: ${state.today}`,
    `- Package: ${result.packageDate}`,
    `- Session: ${result.sessionDir}`,
    `- Source: ${state.sourceDiagnostics.currentJson || state.sourceLabel}`,
    `- Learner profile: ${state.learnerProfile.loaded ? state.learnerProfile.source : "missing"}`,
    ``,
    `## Task`,
    ``,
    stringValue(state.training.goal) || stringValue(state.next.goal),
    ``,
    `## Transcript`,
    ``,
    result.transcript,
    ``,
    `## Native Version`,
    ``,
    result.nativeVersion,
    ``,
    `## Problems`,
    ``,
    ...result.problems.map((item) => `- ${item}`),
    ``,
    `## Tags`,
    ``,
    ...(result.errorTags.length ? result.errorTags.map((item) => `- ${item}`) : ["- none"]),
    ``,
    `## Quick Fix`,
    ``,
    result.quickFix,
    ``,
    `## Next Drill`,
    ``,
    result.nextDrill,
    ``,
    `## Drill Examples`,
    ``,
    ...((result.drillExamples ?? []).length
      ? (result.drillExamples ?? []).map((item) => `- ${item.label}: ${item.text}`)
      : ["- none"]),
    ``,
    `## Follow-up`,
    ``,
    result.followUpQuestion,
    ``,
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
