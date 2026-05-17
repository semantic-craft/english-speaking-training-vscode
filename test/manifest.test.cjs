const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const ttsSource = fs.readFileSync(path.join(root, "src", "practice", "tts.ts"), "utf8");
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
    "openaiCoachModel",
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
  assert.equal(speechInput.default, "gemini");
  assert.deepEqual(speechInput.enum, ["gemini", "openai", "mimo"]);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechRegion"], undefined);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechLocale"], undefined);
  assert.equal(
    packageJson.contributes.commands.some((item) => item.command.includes("Azure")),
    false,
  );
});
