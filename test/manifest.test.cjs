const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const providerRoutesSource = fs.readFileSync(path.join(root, "src", "commands", "provider-routes.ts"), "utf8");
const ttsSource = fs.readFileSync(path.join(root, "src", "practice", "tts.ts"), "utf8");
const mediaSource = fs.readFileSync(path.join(root, "media", "practice.js"), "utf8");
const optionsSource = extensionSource.slice(
  extensionSource.indexOf("function configSettingOptions"),
  extensionSource.indexOf("function providerSetupHint"),
);

function quotedStrings(text) {
  return Array.from(text.matchAll(/"([^"]+)"/g), (match) => match[1]);
}

function sourceArray(name) {
  const match = extensionSource.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  return match ? quotedStrings(match[1]) : [];
}

function uiOptions(setting) {
  const match = optionsSource.match(new RegExp(`case "${setting}": return ([^;]+);`));
  assert.ok(match, `Missing configSettingOptions case for ${setting}`);
  const expr = match[1].trim();
  if (expr.startsWith("[")) {
    return quotedStrings(expr);
  }
  return sourceArray(expr);
}

function configurationEnum(setting) {
  return packageJson.contributes.configuration.properties[`englishTraining.${setting}`]?.enum ?? [];
}

test("every registered command is contributed exactly once", () => {
  const contributed = packageJson.contributes.commands.map((item) => item.command).sort();
  const registered = Array.from(
    extensionSource.matchAll(/register\("([^"]+)"/g),
    (match) => match[1],
  ).sort();

  assert.deepEqual(registered, contributed);
  assert.equal(new Set(contributed).size, contributed.length, "Duplicate command contribution");
});

test("sidebar model presets stay inside package configuration enums", () => {
  for (const setting of [
    "mimoCoachModel",
    "openaiRealtimeTranscriptionModel",
    "openaiFileTranscriptionModel",
    "openaiCoachModel",
    "openaiTtsModel",
    "openaiTtsVoice",
    "geminiCoachModel",
    "geminiAudioUnderstandingModel",
    "minimaxTtsModel",
    "geminiTtsModel",
  ]) {
    const manifestValues = configurationEnum(setting);
    assert.ok(manifestValues.length > 0, `${setting} should have a manifest enum`);
    assert.deepEqual(uiOptions(setting).sort(), [...manifestValues].sort(), setting);
  }
});

test("OpenAI TTS source fallback matches package default", () => {
  const packageDefault = packageJson.contributes.configuration.properties["englishTraining.openaiTtsVoice"].default;
  assert.match(ttsSource, new RegExp(`config<string>\\("openaiTtsVoice"\\) \\|\\| "${packageDefault}"`));
});

test("speech input manifest no longer exposes Azure", () => {
  const speechInput = packageJson.contributes.configuration.properties["englishTraining.audioUnderstandingProvider"];
  // Default switched from gemini → openai when the OpenAI stack became the
  // primary route in 0.1.38 (gpt-4o-transcribe with domain prompt).
  assert.equal(speechInput.default, "openai");
  assert.deepEqual(speechInput.enum, ["gemini", "openai", "mimo"]);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechRegion"], undefined);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechLocale"], undefined);
  assert.equal(
    packageJson.contributes.commands.some((item) => item.command.includes("Azure")),
    false,
  );
});

test("OpenAI-first UX and packaging metadata stay aligned", () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(
    packageJson.contributes.configuration.properties["englishTraining.openaiTtsLanguage"],
    undefined,
    "OpenAI speech endpoint has no language field; do not expose a dead setting",
  );
  assert.match(mediaSource, /function routeKeyStatus/);
  assert.match(mediaSource, /function normalizeProviderForSetting/);
  assert.match(mediaSource, /function renderMissingSourceSetup/);
  assert.match(mediaSource, /No prebuilt\/ folder was found/);
  assert.match(mediaSource, /setting === "coachProvider"/);
  assert.match(mediaSource, /id="useOpenAIStack"/);
  assert.match(mediaSource, /type: "useOpenAIStack"/);
  assert.match(mediaSource, /openaiRealtimeTranscriptionModel/);
  assert.match(mediaSource, /Realtime model/);
  assert.doesNotMatch(mediaSource, /Connect Gemini/);
  assert.doesNotMatch(mediaSource, /Add a Gemini API key/);
  assert.match(
    extensionSource,
    /englishTraining\.useOpenAIRealtimeAudioUnderstanding"[\s\S]*setOpenAIRealtimeSpeechInput/,
  );
  assert.match(providerRoutesSource, /const providers: ProviderName\[\] = \["openai", "gemini", "minimax", "mimo"\]/);
  assert.match(providerRoutesSource, /API key was empty; nothing was saved/);
});
