    const vscode = acquireVsCodeApi();
    let mediaRecorder = null;
    let stream = null;
    let recorderMode = null;
    let nativeStartRequestSeq = 0;
    let activeNativeStartRequestId = 0;
    let practiceRequestSeq = 0;
    let activePracticeRequestId = 0;
    // True from posting startNativeRecording until the extension confirms
    // ffmpeg is actually up (nativeRecordingStarted) or fails (error). A stop
    // tap in this ~1s window would otherwise tear down a recorder that has
    // not started, yielding "did not produce a usable audio file" + "exited
    // before it could start" double errors and a lost take.
    let nativeStarting = false;
    // Bounds the startNativeRecording -> (nativeRecordingStarted | error)
    // window. macLocal is the DEFAULT recorder, so if the host never replies
    // (swallowed rejection, host crash/disconnect, ffmpeg spawn that neither
    // confirms nor errors) the user is otherwise trapped forever: timer
    // running, record button locked, stop tap inert (stopRecording bails
    // while nativeStarting). This self-heals that into a clear, retryable
    // state. Cleared the moment the start resolves either way.
    let nativeStartWatchdog = null;
    let state = null;
    let audioCtx = null;
    let analyser = null;
    let analyserSource = null;
    let vuBuffer = null;
    let vuRaf = null;
    let timerHandle = null;
    let recordingStartedAt = 0;
    let stageHideTimer = null;
    let pendingPracticeTarget = null;
    let activeRecordingTarget = null;
    let currentExampleText = "";
    let currentDrillSuggestions = [];
    let drillLibrary = [];
    let drillGeneratedLines = [];
    let drillAttempts = {};
    let drillGenerating = false;
    let drillLineRequestSeq = 0;
    let activeDrillLineRequest = null;
    let drillLineWatchdog = null;
    let pendingSlowReadHost = null;
    let todayTtsRequestSeq = 0;
    let activeTodayTtsRequest = null;
    let slowReadRequestSeq = 0;
    let activeSlowReadRequest = null;
    let sidebarCommandRequestSeq = 0;
    let activeSidebarCommandRequest = null;
    let refreshInFlight = false;
    let refreshWatchdog = null;
    let localAudioObjectUrl = null;
    const turnAudioObjectUrls = new Set();
    let turnResetArmTimer = null;
    // Start pessimistic: the scaffold ships the record button disabled with a
    // neutral "Checking setup…" status, and applySetupGate flips this the
    // first time real state arrives. This closes the pre-first-state window
    // where the button looked pressable and falsely said "Ready to record".
    let recordingBlockedBySetup = true;
    let currentLessonKey = null;
    const STAGES = ["transcribe", "coach", "tts", "save"];
    const AUDIO_REQUEST_STILL_WORKING_MS = 20000;
    const AUDIO_REQUEST_HARD_TIMEOUT_MS = 100000;
    const MAX_TURN_HISTORY = 12;

    function clearLocalAudioSource() {
      if (localAudioObjectUrl) {
        URL.revokeObjectURL(localAudioObjectUrl);
        localAudioObjectUrl = null;
      }
      const el = $("localAudio");
      if (!el) return;
      try { el.pause(); } catch (_) {}
      el.removeAttribute("src");
      try { el.load(); } catch (_) {}
      el.hidden = true;
    }

    function retainLocalAudioForTurnHistory(src) {
      if (src && src === localAudioObjectUrl) {
        turnAudioObjectUrls.add(src);
        localAudioObjectUrl = null;
      }
    }

    function clearTurnAudioObjectUrls() {
      turnAudioObjectUrls.forEach((url) => URL.revokeObjectURL(url));
      turnAudioObjectUrls.clear();
    }

    // Each webview-recorder turn mints an object URL for the live preview.
    // Revoke unsubmitted previews here; submitted turn-history blobs are
    // retained until conversation/lesson reset so previous "You said" audio
    // remains playable while the learner keeps practicing.
    function setLocalAudioSource(src, ownsBlobUrl) {
      clearLocalAudioSource();
      const el = $("localAudio");
      if (!el) return;
      el.src = src;
      el.hidden = false;
      if (ownsBlobUrl) localAudioObjectUrl = src;
    }
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const objectValue = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
    const textField = (obj, key) => obj && typeof obj[key] === "string" ? obj[key].trim() : "";
    const scalarText = (value) => {
      if (typeof value === "string") return value.trim();
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return "";
    };
    const compactScalarText = (value) => scalarText(value).replace(/\s+/g, " ").trim();
    const positiveInteger = (value) => {
      const parsed = typeof value === "number"
        ? value
        : (typeof value === "string" && value.trim() ? Number(value) : undefined);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    };
    const normalizedTtsSpeed = (value, fallback = 0.9) => {
      const parsed = typeof value === "number"
        ? value
        : (typeof value === "string" && value.trim() ? Number(value) : fallback);
      const speed = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      return Math.max(0.5, Math.min(1.5, Number(speed.toFixed(2))));
    };
    const scalarField = (obj, key) => obj ? scalarText(obj[key]) : "";
    const compactScalarField = (obj, key) => compactScalarText(obj && obj[key]);
    const datasetText = (element, key) => element && element.dataset ? scalarText(element.dataset[key]) : "";
    const textList = (value) => Array.isArray(value)
      ? value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)
      : [];

    function addElementListener(id, eventName, handler) {
      const element = $(id);
      if (!element) return null;
      element.addEventListener(eventName, handler);
      return element;
    }
    const firstTextField = (obj, ...keys) => {
      for (const key of keys) {
        const text = textField(obj, key);
        if (text) return text;
      }
      return "";
    };
    const firstScalarField = (obj, ...keys) => {
      for (const key of keys) {
        const text = scalarField(obj, key);
        if (text) return text;
      }
      return "";
    };
    const firstTextList = (obj, ...keys) => {
      for (const key of keys) {
        const items = textList(obj && obj[key]);
        if (items.length) return items;
      }
      return [];
    };

    function normalizePracticeDrillExamples(value) {
      if (!Array.isArray(value)) return [];
      return value.map((item, index) => {
        if (typeof item === "string") {
          const text = item.trim();
          return text ? { label: "Coach drill " + (index + 1), text, source: "coach" } : null;
        }
        const source = objectValue(item);
        if (!source) return null;
        const text = scalarField(source, "text");
        if (!text) return null;
        return {
          label: scalarField(source, "label") || scalarField(source, "cue") || scalarField(source, "id") || "Coach drill " + (index + 1),
          text,
          reason: scalarField(source, "reason") || scalarField(source, "note"),
          source: scalarField(source, "source") || "coach",
        };
      }).filter(Boolean);
    }

    function normalizePracticeResult(value) {
      const result = objectValue(value);
      if (!result) return null;
      const mode = textField(result, "mode");
      return {
        ...result,
        transcript: firstTextField(result, "transcript"),
        nativeVersion: firstTextField(result, "nativeVersion", "native_version"),
        mode: mode === "shadow" ? "shadow" : "free",
        referenceText: firstTextField(result, "referenceText", "reference_text"),
        referenceLabel: firstTextField(result, "referenceLabel", "reference_label"),
        problems: firstTextList(result, "problems"),
        quickFix: firstTextField(result, "quickFix", "quick_fix"),
        followUpQuestion: firstTextField(result, "followUpQuestion", "follow_up_question"),
        shadowingInstruction: firstTextField(result, "shadowingInstruction", "shadowing_instruction"),
        errorTags: firstTextList(result, "errorTags", "error_tags"),
        nextDrill: firstTextField(result, "nextDrill", "next_drill"),
        drillExamples: normalizePracticeDrillExamples(result.drillExamples || result.drill_examples),
        scores: objectValue(result.scores) || {},
        audioUri: firstTextField(result, "audioUri", "audio_uri"),
        followUpAudioUri: firstTextField(result, "followUpAudioUri", "follow_up_audio_uri"),
        localAudioUri: firstTextField(result, "localAudioUri", "local_audio_uri"),
        ttsStyle: firstTextField(result, "ttsStyle", "tts_style"),
        sessionDir: firstTextField(result, "sessionDir", "session_dir"),
        packageDate: firstTextField(result, "packageDate", "package_date"),
        priorTurn: objectValue(result.priorTurn),
      };
    }

    function clearTurnResetArmTimer() {
      if (turnResetArmTimer) {
        clearTimeout(turnResetArmTimer);
        turnResetArmTimer = null;
      }
    }

    function removeSlowReadAudioPlayer() {
      const player = $("slowReadAudio");
      if (!player) return;
      try { player.pause(); } catch (_) {}
      player.removeAttribute("src");
      try { player.load(); } catch (_) {}
      player.remove();
    }

    function isRecording() {
      return recorderMode === "native" || (mediaRecorder && mediaRecorder.state === "recording");
    }

    function startVuMeter(mediaStream) {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          audioCtx = new Ctx();
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        analyserSource = audioCtx.createMediaStreamSource(mediaStream);
        analyserSource.connect(analyser);
        vuBuffer = new Uint8Array(analyser.frequencyBinCount);
        drawVu();
      } catch (error) {
        // Silent: VU is best-effort.
      }
    }

    function drawVu() {
      const canvas = $("vu");
      if (!canvas || !analyser || !vuBuffer) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteFrequencyData(vuBuffer);
      ctx.clearRect(0, 0, w, h);
      const bars = 18;
      const gap = 1;
      const barWidth = Math.max(1, (w - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i += 1) {
        const idx = Math.min(vuBuffer.length - 1, Math.floor((i / bars) * vuBuffer.length));
        const value = vuBuffer[idx] / 255;
        const barHeight = Math.max(1.5, value * h);
        const alpha = 0.3 + value * 0.6;
        ctx.fillStyle = "rgba(229, 20, 0, " + alpha.toFixed(2) + ")";
        ctx.fillRect(i * (barWidth + gap), h - barHeight, barWidth, barHeight);
      }
      vuRaf = requestAnimationFrame(drawVu);
    }

    function stopVuMeter() {
      if (vuRaf) cancelAnimationFrame(vuRaf);
      vuRaf = null;
      if (analyserSource) {
        try { analyserSource.disconnect(); } catch (_) {}
      }
      if (analyser) {
        try { analyser.disconnect(); } catch (_) {}
      }
      analyserSource = null;
      analyser = null;
      vuBuffer = null;
      const canvas = $("vu");
      if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    function startTimer() {
      // Idempotent: the webview-recorder fallback can reach startTimer twice
      // (success path at mediaRecorder.start, then again via the catch ->
      // startNativeRecording) without a stopTimer between. Without this the
      // first interval is orphaned and repaints #timer at 4 Hz forever.
      if (timerHandle) clearInterval(timerHandle);
      recordingStartedAt = Date.now();
      setTimerText("00:00");
      timerHandle = setInterval(() => {
        const sec = Math.floor((Date.now() - recordingStartedAt) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        setTimerText(m + ":" + s);
      }, 250);
    }

    function setTimerText(text) {
      const timer = $("timer");
      if (timer) timer.textContent = text;
    }

    function stopTimer() {
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = null;
    }

    function resetStages() {
      document.querySelectorAll(".stages li").forEach((li) => li.classList.remove("active", "done"));
    }

    function clearStageHideTimer() {
      if (stageHideTimer) {
        clearTimeout(stageHideTimer);
        stageHideTimer = null;
      }
    }

    function showStages(visible, resetVisible = true) {
      clearStageHideTimer();
      const stages = $("stages");
      if (!stages) return;
      stages.hidden = !visible;
      if (!visible) {
        resetStages();
        return;
      }
      if (visible && resetVisible) resetStages();
    }

    function scheduleStageHide(delayMs) {
      clearStageHideTimer();
      stageHideTimer = setTimeout(() => {
        stageHideTimer = null;
        showStages(false);
      }, delayMs);
    }

    function stageName(value) {
      const name = scalarText(value);
      return STAGES.includes(name) ? name : "";
    }

    function stageStatus(value, fallback = "active") {
      const text = scalarText(value);
      return text === "active" || text === "done" ? text : fallback;
    }

    function setStage(stage, status) {
      const name = stageName(stage);
      if (!name) return;
      const nextStatus = stageStatus(status);
      const el = document.querySelector('.stages li[data-stage="' + name + '"]');
      if (!el) return;
      if (nextStatus === "active") {
        el.classList.remove("done");
        el.classList.add("active");
      } else if (nextStatus === "done") {
        el.classList.remove("active");
        el.classList.add("done");
      }
    }

    function markAllStagesDone() {
      STAGES.forEach((stage) => setStage(stage, "done"));
    }

    function practiceTarget(referenceText, referenceLabel, followUpQuestion) {
      const text = compactScalarText(referenceText);
      if (!text) return null;
      return {
        mode: "shadow",
        referenceText: text,
        referenceLabel: scalarText(referenceLabel) || "Reference",
        followUpQuestion: compactScalarText(followUpQuestion),
      };
    }

    function consumePracticeTarget() {
      const target = pendingPracticeTarget;
      pendingPracticeTarget = null;
      return target;
    }

    function clearPendingPracticeContexts(notifyHost) {
      pendingReplyContext = null;
      pendingPracticeTarget = null;
      activeRecordingTarget = null;
      activePracticeRequestId = 0;
      if (notifyHost) {
        vscode.postMessage({ type: "clearReplyContext" });
      }
    }

    const ROUTE_KEY_SETTINGS = ["coachProvider", "audioUnderstandingProvider", "ttsProvider"];

    function normalizeProviderForSetting(setting, raw) {
      const provider = scalarText(raw).toLowerCase();
      if (setting === "coachProvider") {
        return provider === "gemini" || provider === "mimo" || provider === "qwen" ? provider : "qwen";
      }
      if (setting === "audioUnderstandingProvider") {
        return provider === "gemini" || provider === "qwen" || provider === "mimo" ? provider : "qwen";
      }
      return provider === "qwen" || provider === "gemini" || provider === "mimo" ? provider : "qwen";
    }

    function activeRouteProviders(settings) {
      const safeSettings = objectValue(settings) || {};
      const seen = new Set();
      const providers = [];
      const defaults = {
        coachProvider: "qwen",
        audioUnderstandingProvider: "qwen",
        ttsProvider: "qwen",
      };
      ROUTE_KEY_SETTINGS.forEach((setting) => {
        const raw = scalarField(safeSettings, setting) || defaults[setting];
        const value = normalizeProviderForSetting(setting, raw);
        if (value && !seen.has(value)) {
          seen.add(value);
          providers.push(value);
        }
      });
      return providers;
    }

    function routeKeyStatus(currentState) {
      const safeState = objectValue(currentState) || {};
      const keys = objectValue(safeState.keys) || {};
      const providers = activeRouteProviders(safeState.settings);
      const missing = providers.filter((provider) => !providerKeySaved(keys, provider));
      const label = providers.map(providerLabel).join(" + ") || "Provider";
      const missingLabel = missing.map(providerLabel).join(" + ") || label;
      return {
        coreKeysReady: missing.length === 0,
        providers,
        missing,
        label,
        missingLabel,
      };
    }

    // First-run guard. The red button looks pressable from the very first
    // render, but a recording made before the active route's API keys + a
    // lesson both exist is wasted work — the pipeline only fails afterwards
    // with a raw "Missing API key" error. Gate the button on the same
    // readiness signal the onboarding panel uses, and only touch
    // status/button on the not-ready boundary so a normal "Ready ✓"/result/
    // error status produced during a real turn is never clobbered by a
    // coincidental re-render.
    function setupReady(currentState) {
      const progress = objectValue(currentState && currentState.progress) || {};
      const routeKeys = routeKeyStatus(currentState);
      const hasLessons = positiveInteger(progress.total) > 0;
      return {
        ready: routeKeys.coreKeysReady && hasLessons,
        coreKeysReady: routeKeys.coreKeysReady,
        hasLessons,
        routeKeys,
      };
    }

    function setupBlockMessage(currentState) {
      const diag = objectValue(currentState && currentState.sourceDiagnostics) || {};
      const packageJsonError = scalarField(diag, "packageJsonError");
      if (packageJsonError) {
        return "Today's lesson file (prebuilt/" + (scalarField(diag, "currentPackageDate") || "?")
          + "/english-training.json) has a JSON syntax error: " + packageJsonError
          + " — fix the JSON and press ↻.";
      }
      const gate = setupReady(currentState);
      if (gate.ready) return "";
      return !gate.coreKeysReady
        ? "Add " + gate.routeKeys.missingLabel + " API key" + (gate.routeKeys.missing.length === 1 ? "" : "s") + " in Quick setup above to start recording."
        : "Create your first lesson in Quick setup above to start recording.";
    }

    function isPracticeSetupReady(currentState) {
      return !setupBlockMessage(currentState);
    }

    function ttsActionBlockMessage(currentState, text, actionLabel) {
      if (!compactScalarText(text)) {
        return "No text is available for " + actionLabel + ".";
      }
      const diag = objectValue(currentState && currentState.sourceDiagnostics) || {};
      if (scalarField(diag, "packageJsonError")) {
        return setupBlockMessage(currentState);
      }
      const settings = objectValue(currentState && currentState.settings) || {};
      const keys = objectValue(currentState && currentState.keys) || {};
      const provider = normalizeProviderForSetting("ttsProvider", scalarField(settings, "ttsProvider") || "qwen");
      if (!providerKeySaved(keys, provider)) {
        return "Add " + providerLabel(provider) + " API key in Quick setup above to " + actionLabel + ".";
      }
      return "";
    }

    function todayTtsBlockMessage(currentState, line) {
      const message = ttsActionBlockMessage(currentState, line, "generate example audio");
      return message === "No text is available for generate example audio."
        ? "No example text is available for today's package."
        : message;
    }

    function applySetupGate(currentState) {
      // A re-render can land mid-recording (an unrelated refreshAll). Never
      // disable the button or clobber "Listening…" while a take is live —
      // the user still needs to press stop, and a half-finished recording
      // would otherwise be silently abandoned.
      if (isRecording()) return;
      const btn = $("record");
      // A corrupt current-package JSON otherwise reads as an enabled record
      // button over a totally empty lesson with no hint why. The lesson
      // directory still counts toward setupReady's lesson tally, so this
      // must be gated explicitly and ahead of the generic readiness check.
      const diag = objectValue(currentState && currentState.sourceDiagnostics) || {};
      if (scalarField(diag, "packageJsonError")) {
        recordingBlockedBySetup = true;
        if (btn) btn.disabled = true;
        setStatus(setupBlockMessage(currentState), "error");
        return;
      }
      if (!setupReady(currentState).ready) {
        recordingBlockedBySetup = true;
        if (btn) btn.disabled = true;
        // Keep a real, actionable error visible if one is already showing;
        // otherwise replace the misleading hardcoded "Ready to record".
        const statusEl = $("status");
        if (!(statusEl && statusEl.classList.contains("error"))) {
          setStatus(setupBlockMessage(currentState));
        }
        return;
      }
      if (recordingBlockedBySetup) {
        recordingBlockedBySetup = false;
        // setBusy() owns the button while a turn is processing; only the
        // setup gate could have disabled it on this path, so it is safe to
        // release here unless a pipeline is mid-flight.
        if (btn && !btn.classList.contains("busy")) btn.disabled = false;
        setStatus("Ready to record");
      }
    }

    // After "Complete" advances or the current package is regenerated in
    // place, the previous lesson's conversation, generated drills and attempt
    // counts are stale: the loop buttons would otherwise record against old
    // material and the drill workbench would mix old AI lines into the new set.
    // Reset that session state when the lesson identity changes. The first
    // render just adopts the key — a fresh webview already starts clean, and an
    // in-lesson refresh (e.g. after a turn) keeps the same key so the history
    // the user just built is preserved.
    function lessonIdentity(nextInfo, trainingInfo, line) {
      const diag = objectValue(state && state.sourceDiagnostics) || {};
      const frames = frameTextList(trainingInfo && trainingInfo.frames).slice(0, 6);
      return JSON.stringify({
        json: scalarField(diag, "currentJson"),
        date: scalarField(nextInfo, "package_date"),
        type: firstScalarField(trainingInfo, "training_type") || firstScalarField(nextInfo, "training_type"),
        goal: firstScalarField(trainingInfo, "goal") || firstScalarField(nextInfo, "goal"),
        scenario: firstScalarField(trainingInfo, "scenario") || firstScalarField(nextInfo, "scenario"),
        line: scalarText(line),
        frames,
      });
    }

    function stageLessonResetForRender(nextInfo, trainingInfo, line) {
      const key = lessonIdentity(nextInfo, trainingInfo, line);
      if (currentLessonKey === null) {
        currentLessonKey = key;
        return false;
      }
      if (key === currentLessonKey) return false;
      currentLessonKey = key;
      turnHistory = [];
      lastTurn = null;
      pendingReplyContext = null;
      pendingPracticeTarget = null;
      activeRecordingTarget = null;
      clearTransientAudioRequests();
      drillGeneratedLines = [];
      drillAttempts = {};
      drillGenerating = false;
      activeDrillLineRequest = null;
      return true;
    }

    function commitLessonResetAfterRender(didReset) {
      if (!didReset) return;
      clearTurnAudioObjectUrls();
      clearPendingPracticeContexts(true);
      clearTodayGeneratedAudio();
      clearLocalAudioSource();
      removeSlowReadAudioPlayer();
      clearDrillLineWatchdog();
      showStages(false);
      const resultPanel = $("result");
      if (resultPanel) resultPanel.hidden = true;
      renderTurnHistory();
    }

    function renderState(nextState) {
      const previousState = state;
      const previousRenderContext = {
        activeRecordingTarget,
        activeDrillLineRequest,
        activeSlowReadRequest,
        activeTodayTtsRequest,
        currentDrillSuggestions,
        currentExampleText,
        currentLessonKey,
        drillAttempts: { ...drillAttempts },
        drillGeneratedLines,
        drillGenerating,
        drillLibrary,
        lastTurn,
        pendingPracticeTarget,
        pendingReplyContext,
        pendingSlowReadHost,
        recordingBlockedBySetup,
        turnHistory,
      };
      const webviewState = objectValue(nextState);
      if (!webviewState) throw new Error("State payload was not an object.");
      state = webviewState;
      try {
        const next = objectValue(state.next) || {};
        const training = objectValue(state.training) || {};
        const drill = objectValue(state.drill) || {};
        const settings = objectValue(state.settings) || {};
        const assets = objectValue(next.assets) || {};
        const todayAudioText = firstScalarField(training, "tts_example_text", "clean_tts_text", "audio_text", "demo_line");
        currentExampleText = todayAudioText;
        renderOnboarding(state);
        applySetupGate(state);
        const lessonDidReset = stageLessonResetForRender(next, training, todayAudioText);
        renderDayStrip({ progress: state.progress, next });
        renderProgress(state.progress);
        renderSourceDiagnostics(state.sourceDiagnostics);
        renderLearnerProfile(state.learnerProfile);
        const progress = objectValue(state.progress) || {};
        const weekIndex = positiveInteger(progress.weekIndex);
        const dayInWeek = positiveInteger(progress.dayInWeek);
        const weekTotalDays = positiveInteger(progress.weekTotalDays) || 7;
        const weekTag = weekIndex
          ? "Week " + weekIndex + " · Day " + dayInWeek + "/" + weekTotalDays
          : "";
        renderTodayHero({ next, training, settings, assets, todayAudioText, weekTag });
        renderReadingCard(training, assets);
        renderDrillPanel();
        $("sessionLog").innerHTML = `
          <h3>Session Log</h3>
          ${recentSessions(state.recentSessions || [])}
        `;
        $("source").innerHTML = `
          <span class="chip">${esc(scalarField(state, "source") || "local")}</span>
          ${scalarField(state, "sourceLabel") ? '<span class="chip">' + esc(shortSourceLabel(scalarField(state, "sourceLabel"))) + '</span>' : ''}
        `;
        renderProviderPanel(settings, state.keys || {});
        renderQwenVoicePicker(settings);
        renderSpeedChips(settings);
        applyTransientAudioBusyState();
        applySidebarCommandBusyState();
        commitLessonResetAfterRender(lessonDidReset);
      } catch (error) {
        state = previousState;
        activeRecordingTarget = previousRenderContext.activeRecordingTarget;
        activeDrillLineRequest = previousRenderContext.activeDrillLineRequest;
        activeSlowReadRequest = previousRenderContext.activeSlowReadRequest;
        activeTodayTtsRequest = previousRenderContext.activeTodayTtsRequest;
        currentDrillSuggestions = previousRenderContext.currentDrillSuggestions;
        currentExampleText = previousRenderContext.currentExampleText;
        currentLessonKey = previousRenderContext.currentLessonKey;
        drillAttempts = previousRenderContext.drillAttempts;
        drillGeneratedLines = previousRenderContext.drillGeneratedLines;
        drillGenerating = previousRenderContext.drillGenerating;
        drillLibrary = previousRenderContext.drillLibrary;
        lastTurn = previousRenderContext.lastTurn;
        pendingPracticeTarget = previousRenderContext.pendingPracticeTarget;
        pendingReplyContext = previousRenderContext.pendingReplyContext;
        pendingSlowReadHost = previousRenderContext.pendingSlowReadHost;
        recordingBlockedBySetup = previousRenderContext.recordingBlockedBySetup;
        turnHistory = previousRenderContext.turnHistory;
        throw error;
      }
    }

    function handleStateMessage(nextState) {
      try {
        renderState(nextState);
        resetRefreshBusyState();
      } catch (error) {
        resetRefreshBusyState();
        setStatus("Could not render updated lesson state: " + ((error && error.message) || String(error)), "error");
      }
    }

    const SPEED_OPTIONS = [0.6, 0.8, 0.9, 1.0, 1.2];

    function renderSpeedChips(settings) {
      const chips = $("speedChips");
      if (!chips) return;
      const current = normalizedTtsSpeed(settings && settings.ttsSpeed);
      const hasPresetMatch = SPEED_OPTIONS.some((speed) => Math.abs(speed - current) < 0.01);
      // None of the active providers (Qwen-TTS, Gemini-TTS, MiMo TTS) expose
      // a true `speed` request parameter today. Qwen3-TTS-Instruct-Flash can
      // be nudged via `instructions` text, but plain Qwen3-TTS-Flash cannot.
      // Speed selections still persist so the value is ready when a future
      // provider gains speed support — and Slow Re-read goes through a
      // different path that does adjust phrasing.
      const ttsProvider = scalarField(settings, "ttsProvider") || "qwen";
      const inactiveTitle =
        ' title="Speed presets are saved but the current ' + esc(providerLabel(ttsProvider)) + " TTS does not accept a request-time speed parameter. Use 🐢 Slow for word-by-word shadowing instead.\"";
      const fragments = SPEED_OPTIONS.map((speed) => {
        const pressed = !hasPresetMatch ? false : Math.abs(speed - current) < 0.01;
        const label = (speed.toFixed(1) + "×").replace(".0", "");
        return '<button type="button" class="speed-chip" data-speed="' + speed + '" aria-pressed="' + (pressed ? "true" : "false") + '"' + inactiveTitle + '>' + esc(label) + '</button>';
      });
      if (!hasPresetMatch && Number.isFinite(current) && current > 0) {
        const labelText = Number.isInteger(current)
          ? String(current)
          : current.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
        const label = labelText + "×";
        const customTitle = ' title="Custom speed from settings.json — saved but ignored by the current ' + esc(providerLabel(ttsProvider)) + ' TTS."';
        fragments.push('<button type="button" class="speed-chip" data-speed="' + current + '" aria-pressed="true"' + customTitle + '>' + esc(label) + '</button>');
      }
      chips.innerHTML = fragments.join("");
      chips.querySelectorAll("button[data-speed]").forEach((button) => {
        button.addEventListener("click", () => {
          if (blockSetupChangeDuringPractice()) return;
          const value = Number(datasetText(button, "speed"));
          if (Number.isFinite(value) && value > 0) {
            postSetupAction({ type: "setTtsSpeed", value }, "Setting TTS speed", button);
          }
        });
      });
    }

    const QWEN_VOICE_OPTIONS = [
      { group: "Recommended", id: "Cherry", label: "Cherry", favorite: true },
      { group: "Recommended", id: "Serena", label: "Serena", favorite: true },
      { group: "Recommended", id: "Ethan", label: "Ethan", favorite: true },
      { group: "Character", id: "Chelsie", label: "Chelsie" },
      { group: "Character", id: "Momo", label: "Momo" },
      { group: "Character", id: "Vivian", label: "Vivian" },
      { group: "Narration", id: "Moon", label: "Moon", favorite: true },
      { group: "Narration", id: "Maia", label: "Maia", favorite: true },
    ];

    let voicePickerExpanded = false;

    const PROVIDER_LABELS = {
      qwen: "Qwen",
      mimo: "MiMo",
      gemini: "Gemini"
    };

    const PROVIDER_ROUTES = {
      coachProvider: [
        { value: "qwen", label: "Qwen", note: "DashScope Chat Completions", modelSetting: "qwenCoachModel", extraSetting: "qwenCompatibleBaseUrl", extraLabel: "Endpoint" },
        { value: "mimo", label: "MiMo", note: "Xiaomi Token Plan", modelSetting: "mimoCoachModel" },
        { value: "gemini", label: "Gemini", note: "alternate coach", modelSetting: "geminiCoachModel" },
      ],
      audioUnderstandingProvider: [
        { value: "qwen", label: "Qwen-ASR", note: "DashScope short-recording ASR", modelSetting: "qwenAudioUnderstandingModel", extraSetting: "qwenCompatibleBaseUrl", extraLabel: "Endpoint" },
        { value: "mimo", label: "MiMo", note: "Xiaomi audio understanding", modelSetting: "mimoAudioUnderstandingModel" },
        { value: "gemini", label: "Gemini", note: "alternate STT", modelSetting: "geminiAudioUnderstandingModel" },
      ],
      ttsProvider: [
        {
          value: "qwen",
          label: "Qwen-TTS",
          note: "DashScope speech synthesis",
          modelSetting: "qwenTtsModel",
          extraSettings: [
            { setting: "qwenTtsVoice", label: "Voice" },
            { setting: "qwenTtsLanguageType", label: "Language" },
            { setting: "qwenTtsInstructions", label: "Style" },
            { setting: "qwenTtsEndpoint", label: "Endpoint" },
          ],
        },
        { value: "mimo", label: "MiMo", note: "Xiaomi voices", modelSetting: "mimoTtsModel", extraSetting: "mimoTtsVoice", extraLabel: "Voice" },
        { value: "gemini", label: "Gemini", note: "alternate TTS", modelSetting: "geminiTtsModel", extraSetting: "geminiTtsVoice", extraLabel: "Voice" },
      ],
    };

    function providerLabel(name) {
      return PROVIDER_LABELS[name] || name;
    }

    function providerModelSetting(setting, option, settings) {
      void setting;
      void settings;
      return option.modelSetting || "";
    }

    function providerModelButtonLabel(setting, option, settings) {
      void setting;
      void settings;
      return option.modelLabel || "Model";
    }

    function providerNote(setting, option, settings) {
      void setting;
      void settings;
      return option.note || "";
    }

    function providerExtraSettings(option) {
      if (Array.isArray(option && option.extraSettings)) {
        return option.extraSettings
          .map((item) => objectValue(item))
          .filter((item) => item && scalarField(item, "setting"))
          .map((item) => ({
            setting: scalarField(item, "setting"),
            label: scalarField(item, "label") || "Option",
          }));
      }
      return option && option.extraSetting
        ? [{ setting: option.extraSetting, label: option.extraLabel || "Locale" }]
        : [];
    }

    function providerKeySaved(keys, provider) {
      const safeKeys = objectValue(keys) || {};
      return safeKeys[provider] === true;
    }

    function providerModelSummary(setting, option, settings) {
      if (!settings) return "";
      const modelSetting = providerModelSetting(setting, option, settings);
      if (!modelSetting) return "";
      const model = scalarField(settings, modelSetting);
      const extras = providerExtraSettings(option)
        .map((item) => scalarField(settings, item.setting))
        .filter(Boolean);
      return [model, ...extras].map(esc).join(" · ");
    }

    function providerCardHtml(setting, option, settings, keys) {
      const active = normalizeProviderForSetting(setting, scalarField(settings, setting)) === option.value;
      const hasKey = providerKeySaved(keys, option.value);
      const modelText = providerModelSummary(setting, option, settings);
      const modelSetting = providerModelSetting(setting, option, settings);
      const extraButtons = providerExtraSettings(option)
        .map((item) => '<button class="secondary" data-config-setting="' + esc(item.setting) + '">' + esc(item.label) + '</button>')
        .join("");
      const keyBadgeClass = hasKey ? "provider-badge" : "provider-badge missing";
      const routeBadge = active
        ? '<span class="provider-badge active">active</span>'
        : '<span class="' + keyBadgeClass + '">' + (hasKey ? "key" : "missing") + '</span>';
      const useButton = active
        ? '<button class="secondary" disabled>Active</button>'
        : '<button class="secondary" data-provider-setting="' + esc(setting) + '" data-provider-value="' + esc(option.value) + '">Use</button>';
      const modelButton = modelSetting
        ? '<button class="secondary" data-config-setting="' + esc(modelSetting) + '">' + esc(providerModelButtonLabel(setting, option, settings)) + '</button>'
        : '';
      return [
        '<div class="provider-card ' + (active ? "active" : "") + '">',
          '<div class="provider-card-top">',
            '<div><div class="provider-name">' + esc(option.label) + '</div><div class="provider-note">' + esc(providerNote(setting, option, settings)) + '</div></div>',
            routeBadge,
          '</div>',
          modelText ? '<div class="provider-model">' + modelText + '</div>' : '',
          '<div class="provider-card-actions">',
            useButton,
            '<button class="secondary" data-key="' + esc(option.value) + '">' + (hasKey ? "Key saved" : "Add key") + '</button>',
            modelButton,
            extraButtons,
          '</div>',
        '</div>',
      ].join("");
    }

    function providerRoleHtml(title, setting, settings, keys) {
      const options = PROVIDER_ROUTES[setting] || [];
      const activeValue = normalizeProviderForSetting(setting, scalarField(settings, setting));
      const activeOption = options.find((option) => option.value === activeValue);
      const current = activeOption ? activeOption.label : providerLabel(activeValue || "");
      return [
        '<div class="provider-role">',
          '<div class="provider-role-head"><span class="label">' + esc(title) + '</span><span class="provider-role-current">' + esc(current) + '</span></div>',
          '<div class="provider-grid">',
            options.map((option) => providerCardHtml(setting, option, settings, keys)).join(""),
          '</div>',
        '</div>',
      ].join("");
    }

    function routeSummaryHtml(label, setting, settings) {
      const value = normalizeProviderForSetting(setting, scalarField(settings, setting));
      const options = PROVIDER_ROUTES[setting] || [];
      const activeOption = options.find((option) => option.value === value);
      const name = activeOption ? activeOption.label : providerLabel(value || "");
      return '<div class="route-summary-item"><span>' + esc(label) + '</span><strong>' + esc(name) + '</strong></div>';
    }

    function recorderSettingsHtml(settings) {
      const backend = scalarField(settings, "recorderBackend") || "macLocal";
      const mic = scalarField(settings, "preferredMicrophoneName") || "Auto (prefer Mac built-in)";
      return [
        '<div class="provider-role recorder-role">',
          '<div class="provider-role-head"><span class="label">Recorder</span><span class="provider-role-current">' + esc(backend) + '</span></div>',
          '<div class="provider-card active">',
            '<div class="provider-card-top">',
              '<div><div class="provider-name">Recording input</div><div class="provider-note">Backend and microphone used by the red record button</div></div>',
              '<span class="provider-badge active">' + esc(backend) + '</span>',
            '</div>',
            '<div class="provider-model">' + esc(mic) + '</div>',
            '<div class="provider-card-actions">',
              '<button class="secondary" data-config-setting="recorderBackend">Backend</button>',
              '<button class="secondary" data-sidebar-command="selectMicrophone">Microphone</button>',
            '</div>',
          '</div>',
        '</div>',
      ].join("");
    }

    function keyStripHtml(keys) {
      const safeKeys = objectValue(keys) || {};
      return '<div class="key-strip">' + ["gemini", "qwen", "mimo"].map((name) => {
        const saved = providerKeySaved(safeKeys, name);
        return '<button class="key-pill ' + (saved ? "saved" : "") + '" data-key="' + esc(name) + '">' + esc(providerLabel(name)) + ': ' + (saved ? "saved" : "missing") + '</button>';
      }).join("") + '</div>';
    }

    function renderProviderPanel(settings, keys) {
      const panel = $("providersPanel");
      if (!panel) return;
      const safeSettings = objectValue(settings) || {};
      const safeKeys = objectValue(keys) || {};
      panel.innerHTML = [
        '<h3>Routes & Models</h3>',
        '<div class="route-summary">',
          routeSummaryHtml("Coach", "coachProvider", safeSettings),
          routeSummaryHtml("Speech in", "audioUnderstandingProvider", safeSettings),
          routeSummaryHtml("Speech out", "ttsProvider", safeSettings),
        '</div>',
        '<div class="provider-presets">',
          '<button class="secondary" id="useQwenStack" title="Set coach, speech input, and speech output all to Qwen/DashScope">Use Qwen stack</button>',
          '<button class="secondary" id="useGeminiOnly" title="Set coach, speech input, and speech output all to Gemini">Reset to all-Gemini route</button>',
        '</div>',
        providerRoleHtml("Coach", "coachProvider", safeSettings, safeKeys),
        providerRoleHtml("Speech in", "audioUnderstandingProvider", safeSettings, safeKeys),
        providerRoleHtml("Speech out", "ttsProvider", safeSettings, safeKeys),
        recorderSettingsHtml(safeSettings),
        '<div class="field" id="qwenVoiceField" hidden><span class="label">Qwen-TTS voice</span><div class="row" id="qwenVoicePicker"></div></div>',
        keyStripHtml(safeKeys),
      ].join("");
    }

    function voiceChipHtml(opt, current) {
      const active = opt.id === current ? " active" : "";
      const cloned = opt.cloned ? ' data-voice-cloned="1"' : "";
      const tag = opt.cloned ? '<span class="voice-tag" title="Cloned voice — pinned to Turbo">clone</span>' : '';
      return '<button class="secondary' + active + '" data-voice-id="' + esc(opt.id) + '"' + cloned + ' title="' + esc(opt.id) + '">' + esc(opt.label) + tag + '</button>';
    }

    function renderQwenVoicePicker(settings) {
      const field = $("qwenVoiceField");
      const picker = $("qwenVoicePicker");
      if (!field || !picker) return;
      const safeSettings = objectValue(settings) || {};
      const ttsProvider = scalarField(safeSettings, "ttsProvider");
      if (ttsProvider !== "qwen") {
        field.hidden = true;
        picker.innerHTML = "";
        return;
      }
      field.hidden = false;
      const current = scalarField(safeSettings, "qwenTtsVoice");
      const fragments = [];

      if (voicePickerExpanded) {
        const groups = new Map();
        for (const option of QWEN_VOICE_OPTIONS) {
          if (!groups.has(option.group)) groups.set(option.group, []);
          groups.get(option.group).push(option);
        }
        for (const [group, options] of groups) {
          fragments.push('<span class="voice-group-label">' + esc(group) + '</span>');
          for (const opt of options) {
            fragments.push(voiceChipHtml(opt, current));
          }
        }
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="collapse" title="Show favorites only">Hide ⌃</button>');
      } else {
        const favorites = QWEN_VOICE_OPTIONS.filter((opt) => opt.favorite);
        const currentIsFavorite = favorites.some((opt) => opt.id === current);
        for (const opt of favorites) {
          fragments.push(voiceChipHtml(opt, current));
        }
        if (current && !currentIsFavorite) {
          const activeOpt = QWEN_VOICE_OPTIONS.find((opt) => opt.id === current);
          if (activeOpt) {
            fragments.push('<span class="voice-group-label">Active</span>');
            fragments.push(voiceChipHtml(activeOpt, current));
          }
        }
        const hiddenCount = QWEN_VOICE_OPTIONS.length - favorites.length;
        fragments.push('<button type="button" class="voice-toggle" data-voice-toggle="expand" title="Show all voices">All voices ⌄ <span class="voice-toggle-count">' + hiddenCount + '</span></button>');
      }

      picker.innerHTML = fragments.join("");
      picker.querySelectorAll("button[data-voice-id]").forEach((button) => {
        button.addEventListener("click", () => {
          if (blockSetupChangeDuringPractice()) return;
          const voiceId = datasetText(button, "voiceId");
          if (!voiceId) return;
          postSetupAction({ type: "setQwenVoice", voiceId }, "Setting Qwen-TTS voice", button);
        });
      });
      picker.querySelectorAll("button[data-voice-toggle]").forEach((button) => {
        button.addEventListener("click", () => {
          voicePickerExpanded = datasetText(button, "voiceToggle") === "expand";
          renderQwenVoicePicker(objectValue(state && state.settings) || safeSettings);
          applySidebarCommandBusyState();
        });
      });
    }

    function renderOnboarding(currentState) {
      const panel = $("onboarding");
      if (!panel) return;
      const routeKeys = routeKeyStatus(currentState);
      const coreKeysReady = routeKeys.coreKeysReady;
      const source = scalarField(currentState, "source");
      const sourceLabel = scalarField(currentState, "sourceLabel");
      const sourceConfigured = Boolean(sourceLabel) || source === "local";
      const progress = objectValue(currentState && currentState.progress) || {};
      const lessonCount = positiveInteger(progress.total);
      const hasLessons = lessonCount > 0;
      const allDone = coreKeysReady && sourceConfigured && hasLessons;
      if (allDone) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      const sourceStep = sourceConfigured
        ? { state: "done", title: "Source connected", hint: "Local prebuilt folder", action: "" }
        : { state: "active", title: "Pick local folder", hint: "Choose a folder containing prebuilt/", action: '<button class="primary" data-onboard="source">Choose folder</button>' };
      const lessonStep = hasLessons
        ? { state: "done", title: "Lesson library ready", hint: lessonCount + " lesson" + (lessonCount === 1 ? "" : "s") + " in prebuilt/", action: "" }
        : { state: "active", title: "Create your first lesson", hint: "Writes a starter prebuilt/<today>/english-training.json", action: '<button class="primary" data-onboard="create-sample">Create sample</button>' };
      const keyStep = coreKeysReady
        ? { state: "done", title: routeKeys.label + " ready", hint: "Active route keys are saved", action: "" }
        : { state: "active", title: "Connect " + routeKeys.missingLabel, hint: routeKeys.label + " powers the active practice route", action: '<button class="primary" data-onboard="provider-key">Set up</button>' };
      const steps = [sourceStep, lessonStep, keyStep].filter(Boolean);
      const renderedSteps = steps.map((step, idx) => {
        const mark = step.state === "done" ? "✓" : String(idx + 1);
        return `
          <li class="onboarding-step ${step.state}">
            <span class="step-mark">${mark}</span>
            <span class="step-body"><strong>${esc(step.title)}</strong><span>${esc(step.hint)}</span></span>
            ${step.action || '<span></span>'}
          </li>
        `;
      }).join("");
      panel.hidden = false;
      panel.innerHTML = `
        <p class="onboarding-title">Quick setup</p>
        <p class="onboarding-sub">Two minutes to your first practice loop.</p>
        <ol class="onboarding-steps">${renderedSteps}</ol>
      `;
    }

    function renderMissingSourceSetup(message) {
      const panel = $("onboarding");
      if (!panel) return;
      panel.hidden = false;
      panel.innerHTML = `
        <p class="onboarding-title">Quick setup</p>
        <p class="onboarding-sub">Choose a local materials folder to start.</p>
        <ol class="onboarding-steps">
          <li class="onboarding-step active">
            <span class="step-mark">1</span>
            <span class="step-body">
              <strong>Pick local folder</strong>
              <span>${esc(message || "No prebuilt/ folder was found in this workspace.")}</span>
            </span>
            <button class="primary" data-onboard="source">Choose folder</button>
          </li>
        </ol>
      `;
      const task = $("task");
      if (task) {
        task.innerHTML = `
          <div class="today-head">
            <span class="today-eyebrow">SETUP</span>
          </div>
          <h2 class="today-goal">Connect your English Training materials</h2>
          <p class="today-scenario">Pick a folder that contains <code>prebuilt/</code>, or choose an empty folder and create the starter lesson there.</p>
        `;
      }
    }

    function renderSourceDiagnostics(diagnostics) {
      const panel = $("diagnostics");
      if (!panel) return;
      const value = objectValue(diagnostics) || {};
      const lessonCount = positiveInteger(value.lessonCount);
      const dateRange = scalarField(value, "dateRange");
      const lessonText = lessonCount + " lesson" + (lessonCount === 1 ? "" : "s")
        + (dateRange ? " · " + dateRange : "");
      const rows = [
        ["Mode", scalarField(value, "mode") || "unknown"],
        ["Materials root", scalarField(value, "root")],
        ["Configured source", scalarField(value, "configuredRoot")],
        ["Lessons", lessonText],
        ["Current package", scalarField(value, "currentPackageDate")],
        ["Current JSON", scalarField(value, "currentJson")],
        ["Follow-up drill", scalarField(value, "followupDrillJson")],
        ["Manifest", scalarField(value, "manifestJson")],
        ["Progress JSON", scalarField(value, "progressJson")],
        ["Package folder", scalarField(value, "packageDir")],
      ].filter((row) => row[1]);
      const diagnosticErrorBanner = (text) =>
        `<div role="alert" style="margin:6px 0;padding:8px 10px;border-radius:4px;`
            + `background:var(--vscode-inputValidation-errorBackground,rgba(229,20,0,0.15));`
            + `border:1px solid var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground,#e51400));`
            + `color:var(--vscode-errorForeground,#e51400);font-size:12px;line-height:1.5;">`
            + text
            + `</div>`;
      const errorBanner = [
        scalarField(value, "packageJsonError")
          ? diagnosticErrorBanner(
              `⚠ This package's <code>english-training.json</code> failed to parse, so the lesson is empty. `
                + `Fix the JSON syntax and press ↻ to reload.<br><strong>${esc(scalarField(value, "packageJsonError"))}</strong>`,
            )
          : "",
        scalarField(value, "drillJsonError")
          ? diagnosticErrorBanner(
              `⚠ This package's <code>followup-drill.json</code> failed to parse, so the drill workbench is using fallback lines. `
                + `Fix the JSON syntax and press ↻ to reload.<br><strong>${esc(scalarField(value, "drillJsonError"))}</strong>`,
            )
          : "",
        scalarField(value, "manifestJsonError")
          ? diagnosticErrorBanner(
              `⚠ This package's <code>manifest.json</code> failed to parse, so reading-card asset paths are using default package filenames. `
                + `Fix the JSON syntax and press ↻ to reload.<br><strong>${esc(scalarField(value, "manifestJsonError"))}</strong>`,
            )
          : "",
        scalarField(value, "progressJsonError")
          ? diagnosticErrorBanner(
              `⚠ Your <code>progress/english-speaking-training-progress.json</code> failed to parse, so progress may look incomplete. `
                + `Fix the JSON syntax and press ↻ to reload.<br><strong>${esc(scalarField(value, "progressJsonError"))}</strong>`,
            )
          : "",
      ].join("");
      panel.innerHTML = `
        <h3>Source Diagnostics</h3>
        ${errorBanner}
        <div class="chips">
          <span class="chip">${esc(scalarField(value, "mode") || "unknown")} source</span>
          <span class="chip">${esc(lessonText)}</span>
        </div>
        <div class="kv-list">
          ${rows.map(([label, text]) => diagnosticRow(label, text)).join("")}
        </div>
        <div class="materials-actions">
          <button class="secondary" data-onboard="generate-next">＋ Generate next package</button>
          <button class="secondary" data-onboard="materials-guide">Materials guide</button>
        </div>
      `;
    }

    function renderLearnerProfile(profile) {
      const panel = $("learnerProfile");
      if (!panel) return;
      const value = objectValue(profile) || {};
      const loaded = Boolean(value.loaded);
      panel.innerHTML = `
        <h3>Learner Profile</h3>
        <div class="chips">
          <span class="chip">${loaded ? "Profile loaded" : "Profile missing"}</span>
          <span class="chip">${esc(scalarField(value, "format") || "missing")}</span>
        </div>
        <div class="kv-list">
          ${diagnosticRow("Source", scalarField(value, "source") || "profile/learner-profile.md")}
          ${scalarField(value, "summary") ? diagnosticRow(loaded ? "Summary" : "Next step", scalarField(value, "summary")) : ""}
        </div>
      `;
    }

    function diagnosticRow(label, value) {
      return `
        <div class="kv-row">
          <span class="label">${esc(label)}</span>
          <code title="${esc(value)}">${esc(value)}</code>
        </div>
      `;
    }

    function renderProgress(progress) {
      const panel = $("progress");
      if (!panel) return;
      const value = objectValue(progress) || {};
      const cells = Array.isArray(value.cells) ? value.cells.map((cell) => objectValue(cell)).filter(Boolean) : [];
      if (!cells.length) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const total = positiveInteger(value.total) || cells.length;
      const currentIndex = positiveInteger(value.currentIndex);
      const completedCount = positiveInteger(value.completedCount);
      const weekIndex = positiveInteger(value.weekIndex);
      const weekCompletedDays = positiveInteger(value.weekCompletedDays);
      const weekTotalDays = positiveInteger(value.weekTotalDays) || 7;
      const streak = positiveInteger(value.streak);
      const dayLabel = currentIndex
        ? "Day " + currentIndex + " / " + total
        : completedCount + " / " + total + " completed";
      const weekLabel = weekIndex
        ? "Week " + weekIndex + " · " + weekCompletedDays + "/" + weekTotalDays
        : "";
      const streakLabel = streak
        ? "🔥 " + streak + "-day streak"
        : "";
      const cellHtml = cells.map((cell) => {
        const status = progressCellStatus(cell);
        const date = scalarField(cell, "date");
        return '<div class="heatmap-cell ' + esc(status) + '" title="' + esc(date) + ' · ' + esc(status) + '"></div>';
      }).join("");
      panel.innerHTML = `
        <div class="progress-meta">
          <span class="progress-chip primary">${esc(dayLabel)}</span>
          ${weekLabel ? '<span class="progress-chip">' + esc(weekLabel) + '</span>' : ''}
          ${streakLabel ? '<span class="progress-chip streak">' + esc(streakLabel) + '</span>' : ''}
        </div>
        <div class="heatmap" role="img" aria-label="${esc(dayLabel)}">${cellHtml}</div>
        <div class="heatmap-legend" aria-hidden="true">
          <span><i class="lg-completed"></i>done</span>
          <span><i class="lg-current"></i>today</span>
          <span><i class="lg-missed"></i>missed</span>
          <span><i class="lg-pending"></i>upcoming</span>
        </div>
      `;
    }

    function progressCellStatus(cell) {
      const status = scalarField(cell, "status").toLowerCase();
      return ["completed", "current", "missed", "pending"].includes(status) ? status : "pending";
    }

    function renderDayStrip(ctx) {
      const strip = $("dayStrip");
      if (!strip) return;
      const progress = objectValue(ctx && ctx.progress) || {};
      const next = objectValue(ctx && ctx.next) || {};
      const cells = Array.isArray(progress.cells) ? progress.cells.map((cell) => objectValue(cell)).filter(Boolean) : [];
      if (!cells.length) {
        strip.hidden = true;
        strip.innerHTML = "";
        return;
      }
      const total = positiveInteger(progress.total) || cells.length;
      const currentIndex = positiveInteger(progress.currentIndex);
      const completedCount = positiveInteger(progress.completedCount);
      const weekIndex = positiveInteger(progress.weekIndex);
      const weekCompletedDays = positiveInteger(progress.weekCompletedDays);
      const weekTotalDays = positiveInteger(progress.weekTotalDays) || 7;
      const streak = positiveInteger(progress.streak);
      const dayLabel = currentIndex
        ? "Day " + currentIndex + " / " + total
        : completedCount + " / " + total + " done";
      const weekLabel = weekIndex
        ? "Week " + weekIndex + " · " + weekCompletedDays + "/" + weekTotalDays
        : "";
      const streakLabel = streak ? "🔥 " + streak : "";
      const packageDate = scalarField(next, "package_date");
      const chips = [
        packageDate ? '<span class="ds-chip ds-date">' + esc(packageDate) + "</span>" : "",
        '<span class="ds-chip ds-primary">' + esc(dayLabel) + "</span>",
        weekLabel ? '<span class="ds-chip">' + esc(weekLabel) + "</span>" : "",
        streakLabel ? '<span class="ds-chip ds-streak">' + esc(streakLabel) + "</span>" : "",
      ].filter(Boolean).join("");
      strip.hidden = false;
      strip.innerHTML = '<div class="ds-row">' + chips + "</div>";
    }

    function renderTodayHero(ctx) {
      const host = $("task");
      if (!host) return;
      const next = objectValue(ctx && ctx.next) || {};
      const training = objectValue(ctx && ctx.training) || {};
      const settings = objectValue(ctx && ctx.settings) || {};
      const assets = objectValue(ctx && ctx.assets) || {};
      const line = scalarText(ctx && ctx.todayAudioText);
      const weekTag = scalarText(ctx && ctx.weekTag);
      const packageDate = scalarField(next, "package_date");
      const trainingType = firstScalarField(next, "training_type") || "practice";
      const goal = firstScalarField(training, "goal") || firstScalarField(next, "goal", "completion_label") || "Today's practice";
      const scenario = firstScalarField(training, "scenario") || firstScalarField(next, "scenario");
      const setup = firstScalarField(training, "chinese_setup") || firstScalarField(next, "chinese_setup");
      const ttsProvider = scalarField(settings, "ttsProvider") || "qwen";
      const practiceBlocked = !line || !isPracticeSetupReady(state);
      const todayTtsBlocked = todayTtsBlockMessage(state, line);
      host.innerHTML = `
        <div class="today-head">
          <span class="today-eyebrow">🎯 TODAY${packageDate ? " · " + esc(packageDate) : ""}${weekTag ? " · " + esc(weekTag) : ""}</span>
          <span class="chip">${esc(trainingType)}</span>
        </div>
        <h2 class="today-goal">${esc(goal)}</h2>
        ${scenario ? '<p class="today-scenario">' + esc(scenario) + '</p>' : ''}
        ${setup ? '<p class="today-setup muted">' + esc(setup) + '</p>' : ''}
        ${prosodyLineBlockHtml(training, line)}
        <div class="today-actions">
          <button data-hero-practice="1" ${practiceBlocked ? "disabled" : ""}>🎙 Practice this line</button>
          <button class="secondary" data-action="today-tts" ${todayTtsBlocked ? "disabled" : ""}>🔊 Generate audio</button>
          <span class="muted" id="todayTtsStatus">${todayTtsBlocked ? esc(todayTtsBlocked) : "Reads example only, with " + esc(ttsProvider)}</span>
        </div>
        <div class="today-audio">
          ${prebuiltDemoAudio(assets)}
          <audio id="todayAudio" controls hidden></audio>
        </div>
        <details class="result-details today-frames">
          <summary>Frames &amp; plain text</summary>
          <div class="field"><span class="label">Frames</span>${frames(training.frames)}</div>
          <div class="field"><span class="label">Example text</span><p class="text">${esc(line)}</p></div>
        </details>
      `;
    }

    function normProsodyWord(value) {
      return scalarText(value).toLowerCase().replace(/[^a-z0-9']+/g, "");
    }

    // A well-formed package splits a multi-sentence line into one thought group
    // per idea (card-schema: "Split the sentence into thought groups"). A few
    // early packages instead crammed several sentences into ONE group with a
    // single terminal contour, so the pitch card showed just one arrow at the
    // very end and looked broken. When we receive exactly that shape — one
    // group whose text is several sentences — split it at sentence boundaries
    // for display: non-final sentences take the level "→" continuation tone,
    // the final sentence keeps the group's real nucleus + contour + pause.
    // This reproduces the →…→…↘ convention every well-formed package already
    // uses; it asserts no pitch the data didn't imply (non-final sentences are
    // continuation by default) and is a no-op for correct multi-group packages.
    function expandDegenerateProsodyGroups(groups) {
      if (!Array.isArray(groups) || groups.length !== 1) return groups;
      const only = objectValue(groups[0]) || {};
      const parts = scalarField(only, "text").match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];
      const sentences = parts.map((s) => s.trim()).filter(Boolean);
      if (sentences.length < 2) return groups;
      const baseId = scalarField(only, "id") || 1;
      return sentences.map((sentence, i) => {
        const isLast = i === sentences.length - 1;
        return {
          id: baseId, // keep the words[] → group lookup intact
          text: sentence,
          nucleus: isLast ? scalarField(only, "nucleus") : "",
          contour: isLast ? (scalarField(only, "contour") || "→") : "→",
          pause_after: isLast ? (scalarField(only, "pause_after") || "final") : "short",
        };
      });
    }

    function contourClass(arrow) {
      const a = scalarText(arrow);
      if (a.indexOf("↗") >= 0 || /ris/i.test(a)) return "rise";
      if (a.indexOf("↘") >= 0 || /fall/i.test(a)) return "fall";
      if (a.indexOf("↑") >= 0) return "rise";
      if (a.indexOf("↓") >= 0) return "fall";
      return "level";
    }

    function contourGlyph(arrow) {
      const cls = contourClass(arrow);
      if (cls === "rise") return "↗";
      if (cls === "fall") return "↘";
      return "→";
    }

    function pauseGlyph(pause) {
      const p = scalarText(pause).toLowerCase();
      if (p.indexOf("final") >= 0) return "‖";
      if (p.indexOf("long") >= 0) return "‖";
      if (!p || p === "none") return "";
      return "·";
    }

    // "ac·COUNT·a·bil·i·ty" -> [{seg:"ac",stress:false}, {seg:"COUNT",stress:true}, ...]
    // Returns null when there is no usable multi-syllable split so the caller
    // falls back to the original whole-word rendering (old cards, monosyllables).
    function splitSyllableSpec(spec) {
      const parts = scalarText(spec).split("·").filter((s) => s.length);
      if (parts.length < 2) return null;
      return parts.map((seg) => {
        const letters = seg.replace(/[^A-Za-z]/g, "");
        const stress = letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
        return { seg, stress };
      });
    }

    function prosodyWordSpan(token, info, isNucleus, toneArrow) {
      const cls = isNucleus
        ? "nucleus"
        : (info ? prosodyStressClass(scalarField(info, "stress").toLowerCase()) : "neutral");
      const arrow = isNucleus ? scalarText(toneArrow) : scalarField(info, "arrow");
      const arrowHtml = arrow ? '<sup class="pw-arrow ' + contourClass(arrow) + '">' + esc(contourGlyph(arrow)) + '</sup>' : '';
      const title = info
        ? [
          scalarField(info, "stress") ? "Stress: " + scalarField(info, "stress") : "",
          scalarField(info, "pitch_role") ? "Pitch: " + scalarField(info, "pitch_role") : "",
          arrow ? "Tone: " + arrow : "",
        ].filter(Boolean).join(" | ")
        : (isNucleus ? "Nucleus" : "");
      const titleAttr = title ? ' title="' + esc(title) + '"' : '';
      const syllables = info && splitSyllableSpec(info.syllables);
      if (syllables) {
        // Mark the stressed syllable with the word's prominence (so the legend
        // still holds), dim the rest. aria-label keeps the plain word for SR.
        const inner = syllables.map((s, i) => {
          const sepHtml = i > 0 ? '<span class="pw-syl-sep" aria-hidden="true">·</span>' : '';
          const sylCls = s.stress ? "pw-syl pw-" + cls : "pw-syl pw-syl-weak";
          return sepHtml + '<span class="' + sylCls + '">' + esc(s.seg) + '</span>';
        }).join("");
        return '<span class="pw pw-syllabified" aria-label="' + esc(token) + '"' + titleAttr + '>' +
          '<span aria-hidden="true">' + inner + '</span>' + arrowHtml + '</span>';
      }
      return '<span class="pw pw-' + cls + '"' + titleAttr + '>' + esc(token) + arrowHtml + '</span>';
    }

    function prosodyGroupLineHtml(groups, words) {
      const wordsByGroup = new Map();
      (Array.isArray(words) ? words : []).forEach((word) => {
        const key = scalarField(word, "group") || "all";
        if (!wordsByGroup.has(key)) wordsByGroup.set(key, new Map());
        const norm = normProsodyWord(scalarField(word, "text"));
        if (norm) wordsByGroup.get(key).set(norm, word);
      });
      const segments = groups.map((group, index) => {
        const id = scalarField(group, "id") || String(index + 1);
        const lookup = wordsByGroup.get(id) || wordsByGroup.get("all") || new Map();
        const contour = scalarField(group, "contour");
        const pauseAfter = scalarField(group, "pause_after");
        const nucleusNorm = normProsodyWord(scalarField(group, "nucleus"));
        const tokens = scalarField(group, "text").split(/\s+/).filter(Boolean);
        const wordHtml = tokens.map((token) => {
          const norm = normProsodyWord(token);
          const isNucleus = Boolean(norm) && norm === nucleusNorm;
          return prosodyWordSpan(token, lookup.get(norm), isNucleus, contour);
        }).join(" ");
        const pause = pauseGlyph(pauseAfter);
        const breakHtml = '<span class="pg-break">' +
          '<b class="pg-tone ' + contourClass(contour) + '">' + esc(contourGlyph(contour)) + '</b>' +
          (pause ? '<span class="pg-pause" title="Pause: ' + esc(pauseAfter) + '">' + esc(pause) + '</span>' : '') +
          '</span>';
        return '<span class="pg">' + wordHtml + '</span>' + (index < groups.length - 1 || pause ? breakHtml : '');
      }).join(" ");
      return '<p class="prosody-line">' + segments + '</p>';
    }

    function prosodyContourRailHtml(groups) {
      if (!groups.length) return "";
      const tiles = groups.map((group, index) => {
        const contour = scalarField(group, "contour");
        const cls = contourClass(contour);
        const nucleus = scalarField(group, "nucleus").replace(/[.,;:!?]+$/, "");
        return '<div class="contour-tile">' +
          '<span class="ct-arrow ct-' + cls + '">' + esc(contourGlyph(contour)) + '</span>' +
          '<span class="ct-nucleus">' + esc(nucleus || ("Grp " + (index + 1))) + '</span>' +
          '</div>';
      }).join("");
      return '<div class="contour-rail" aria-label="Sentence melody">' + tiles + '</div>';
    }

    function prosodyGuideFallbackHtml(training, line) {
      const stressGuide = scalarField(training, "stress_guide");
      const intonationGuide = scalarField(training, "intonation_guide");
      const lineText = scalarText(line);
      if (!stressGuide && !intonationGuide && !lineText) return "";
      let lineHtml = "";
      if (stressGuide) {
        const tokens = stressGuide.split(/\s+/).filter(Boolean);
        lineHtml = '<p class="prosody-line">' + tokens.map((raw) => {
          const stressed = raw.indexOf("ˈ") >= 0 || /[A-Z]{2,}/.test(raw.replace(/[^A-Za-z]/g, ""));
          const clean = raw.replace(/ˈ/g, "");
          return '<span class="pw pw-' + (stressed ? "support" : "neutral") + '">' + esc(clean) + '</span>';
        }).join(" ") + '</p>';
      } else if (lineText) {
        lineHtml = '<p class="prosody-line">' + esc(lineText) + '</p>';
      }
      let rail = "";
      if (intonationGuide) {
        const segs = intonationGuide.split("|").map((seg) => seg.trim()).filter(Boolean);
        rail = '<div class="contour-rail" aria-label="Sentence melody">' + segs.map((seg) => {
          const cls = contourClass(seg);
          const label = seg.replace(/[→↘↗↑↓]/g, "").trim().split(/\s+/).slice(-1)[0] || "";
          return '<div class="contour-tile"><span class="ct-arrow ct-' + cls + '">' + esc(contourGlyph(seg)) + '</span><span class="ct-nucleus">' + esc(label) + '</span></div>';
        }).join("") + '</div>';
      }
      return lineHtml + rail;
    }

    function prosodyLegendHtml() {
      return '<div class="prosody-legend" aria-hidden="true">' +
        '<span><i class="lg-nucleus"></i>nucleus</span>' +
        '<span><i class="lg-support"></i>stress</span>' +
        '<span><i class="lg-weak"></i>weak</span>' +
        '<span class="lg-arrow rise">↗ rise</span>' +
        '<span class="lg-arrow fall">↘ fall</span>' +
        '<span class="lg-arrow level">→ level</span>' +
        '<span>‖ pause</span>' +
        '</div>';
    }

    function prosodyLineBlockHtml(training, line) {
      const wl = (training && training.word_level_prosody) || null;
      const rawGroups = wl && Array.isArray(wl.groups) ? wl.groups : [];
      const groups = expandDegenerateProsodyGroups(rawGroups.map((item) => objectValue(item)).filter(Boolean));
      const words = wl && Array.isArray(wl.words) ? wl.words.map((item) => objectValue(item)).filter(Boolean) : [];
      const lineText = scalarText(line);
      let body = "";
      if (groups.length) {
        body = prosodyGroupLineHtml(groups, words) + prosodyContourRailHtml(groups) + prosodyLegendHtml();
      } else {
        const fallback = prosodyGuideFallbackHtml(training, lineText);
        if (fallback) {
          body = fallback + (scalarField(training, "stress_guide") || scalarField(training, "intonation_guide") ? prosodyLegendHtml() : "");
        } else if (lineText) {
          body = '<p class="prosody-line">' + esc(lineText) + '</p>';
        }
      }
      if (!body) return "";
      return '<div class="prosody-card"><span class="label">Today\'s line · stress · pitch · pauses</span>' + body + '</div>';
    }

    function prebuiltDemoAudio(assets) {
      const uri = scalarField(assets, "demo_audio_uri");
      if (!uri) return "";
      return '<audio id="prebuiltDemoAudio" controls preload="metadata" src="' + esc(uri) + '"></audio>';
    }

    function renderReadingCard(training, assets) {
      const panel = $("readingCard");
      if (!panel) return;
      const mediaHtml = readingCardMediaHtml(assets || {});
      const guidesHtml = prosodyGuidesHtml(training || {});
      const groupsHtml = prosodyGroupsHtml((training && training.word_level_prosody) || null);
      const wordsHtml = prosodyWordsHtml((training && training.word_level_prosody) || null);
      if (!mediaHtml && !guidesHtml && !groupsHtml && !wordsHtml) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      panel.innerHTML = [
        '<h3>Reading Card</h3>',
        mediaHtml,
        guidesHtml,
        groupsHtml,
        wordsHtml,
      ].filter(Boolean).join("");
    }

    function readingCardMediaHtml(assets) {
      const daily = readingImageDetails("Daily card", assets.daily_card_uri, true);
      const detail = readingImageDetails("Prosody detail", assets.prosody_detail_uri, false);
      if (!daily && !detail) return "";
      return '<div class="reading-media">' + daily + detail + '</div>';
    }

    function readingImageDetails(label, uri, open) {
      if (!uri) return "";
      return '<details ' + (open ? "open" : "") + '><summary>' + esc(label) + '</summary>' +
        '<img class="reading-card-img" loading="lazy" src="' + esc(uri) + '" alt="' + esc(label) + '">' +
        '</details>';
    }

    function prosodyGuidesHtml(training) {
      const stress = prosodyGuideBlock("Stress guide", training.stress_guide);
      const intonation = prosodyGuideBlock("Intonation guide", training.intonation_guide);
      if (!stress && !intonation) return "";
      return '<div class="prosody-guide-grid">' + stress + intonation + '</div>';
    }

    function prosodyGuideBlock(label, value) {
      const text = scalarText(value);
      if (!text) return "";
      return '<div class="prosody-guide"><span class="label">' + esc(label) + '</span><p>' + esc(text) + '</p></div>';
    }

    function prosodyGroupsHtml(wordLevel) {
      const groups = wordLevel && Array.isArray(wordLevel.groups)
        ? wordLevel.groups.map((item) => objectValue(item)).filter(Boolean)
        : [];
      if (!groups.length) return "";
      const items = groups.map((group, index) => {
        const id = scalarField(group, "id") || String(index + 1);
        const fn = scalarField(group, "function");
        const nucleus = scalarField(group, "nucleus");
        const contour = scalarField(group, "contour");
        const pauseAfter = scalarField(group, "pause_after");
        const meta = [
          fn ? "Function: " + fn : "",
          nucleus ? "Nucleus: " + nucleus : "",
          contour ? "Contour: " + contour : "",
          pauseAfter ? "Pause: " + pauseAfter : "",
        ].filter(Boolean).join(" | ");
        return '<div class="prosody-group">' +
          '<span class="prosody-row-label">Group ' + esc(id) + '</span>' +
          '<span class="prosody-group-text">' + esc(scalarField(group, "text")) + '</span>' +
          (meta ? '<span class="prosody-group-meta">' + esc(meta) + '</span>' : '') +
          '</div>';
      }).join("");
      return '<div class="field"><span class="label">Thought groups</span><div class="prosody-groups">' + items + '</div></div>';
    }

    function prosodyWordsHtml(wordLevel) {
      const words = wordLevel && Array.isArray(wordLevel.words)
        ? wordLevel.words.map((item) => objectValue(item)).filter(Boolean)
        : [];
      if (!words.length) return "";
      const groups = wordLevel && Array.isArray(wordLevel.groups)
        ? wordLevel.groups.map((item) => objectValue(item)).filter(Boolean)
        : [];
      const byGroup = new Map();
      const order = [];
      for (const group of groups) {
        const key = scalarField(group, "id");
        if (key && !byGroup.has(key)) {
          byGroup.set(key, []);
          order.push(key);
        }
      }
      for (const word of words) {
        const key = scalarField(word, "group") || "all";
        if (!byGroup.has(key)) {
          byGroup.set(key, []);
          order.push(key);
        }
        byGroup.get(key).push(word);
      }
      const rows = order.map((key) => {
        const group = groups.find((item) => scalarField(item, "id") === key) || {};
        const label = key === "all" ? "Words" : "Group " + key;
        const contour = scalarField(group, "contour");
        const meta = contour ? " | Contour: " + contour : "";
        const chips = (byGroup.get(key) || []).map(prosodyWordChip).join("");
        return '<div class="prosody-word-row">' +
          '<span class="prosody-row-label">' + esc(label + meta) + '</span>' +
          chips +
          '</div>';
      }).join("");
      return '<div class="field"><span class="label">Word-level prosody</span><div class="prosody-word-rows">' + rows + '</div></div>';
    }

    function prosodyWordChip(word) {
      const stress = scalarField(word, "stress").toLowerCase();
      const cls = prosodyStressClass(stress);
      const mark = prosodyWordMark(word, cls);
      const title = [
        scalarField(word, "stress") ? "Stress: " + scalarField(word, "stress") : "",
        scalarField(word, "pitch_role") ? "Pitch: " + scalarField(word, "pitch_role") : "",
        scalarField(word, "arrow") ? "Arrow: " + scalarField(word, "arrow") : "",
      ].filter(Boolean).join(" | ");
      return '<span class="prosody-word ' + cls + '" title="' + esc(title) + '">' +
        '<span>' + esc(scalarField(word, "text")) + '</span>' +
        '<span class="prosody-mark">' + esc(mark) + '</span>' +
        '</span>';
    }

    function prosodyStressClass(stress) {
      if (stress.includes("nucleus")) return "nucleus";
      if (stress.includes("support")) return "support";
      if (stress.includes("weak") || stress.includes("unstress")) return "weak";
      return "neutral";
    }

    function prosodyWordMark(word, cls) {
      const arrow = scalarField(word, "arrow");
      if (cls === "nucleus") return arrow ? "N " + arrow : "N";
      if (cls === "support") return arrow ? "S " + arrow : "S";
      if (cls === "weak") return arrow ? "W " + arrow : "W";
      return arrow || scalarField(word, "stress");
    }

    function frames(value) {
      const items = frameTextList(value);
      if (!items.length) return '<p class="muted">No frames.</p>';
      return '<ol>' + items.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ol>';
    }

    function frameTextList(value) {
      if (!Array.isArray(value)) return [];
      return value.map((item) => {
        const obj = objectValue(item);
        const text = obj ? scalarField(obj, "text") : scalarText(item);
        return text.replace(/\s+/g, " ").trim();
      }).filter(Boolean);
    }

    function simpleList(value) {
      const items = scalarTextList(value);
      if (!items.length) return '<p class="muted">No items.</p>';
      return '<ul>' + items.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }

    function scalarTextList(value) {
      if (!Array.isArray(value)) return [];
      return value.map((item) => compactScalarText(item)).filter(Boolean);
    }

    function drillRounds(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No drill rounds.</p>';
      const html = value.map((round) => {
        const obj = objectValue(round);
        if (!obj) return "";
        const examples = Array.isArray(obj.examples) ? obj.examples : [];
        const roundLabel = scalarField(obj, "label") || scalarField(obj, "id") || "Round";
        const baseFrame = compactScalarField(obj, "base_frame");
        const exampleHtml = examples.map((item) => {
          const example = objectValue(item);
          const text = example ? compactScalarField(example, "text") : compactScalarText(item);
          if (!text) return "";
          const label = example
            ? scalarField(example, "cue") || scalarField(example, "label") || roundLabel
            : roundLabel;
          return drillExampleHtml({ label, text, source: "prebuilt" }, {});
        }).filter(Boolean).join("");
        return `
          <div class="field">
            <strong>${esc(roundLabel)}</strong>
            ${baseFrame ? '<p class="text">' + esc(baseFrame) + '</p>' : ''}
            ${exampleHtml ? '<ol class="drill-example-list">' + exampleHtml + '</ol>' : ''}
          </div>
        `;
      }).filter(Boolean).join("");
      return html || '<p class="muted">No drill rounds.</p>';
    }

    function shadowing(value) {
      const obj = objectValue(value);
      const chunks = obj && Array.isArray(obj.chunks) ? scalarTextList(obj.chunks) : [];
      if (!chunks.length) return '<p class="muted">No shadowing chunks.</p>';
      const instruction = scalarField(obj, "instruction_zh") || "Shadow each chunk twice.";
      return '<p class="muted">' + esc(instruction) + '</p><ol>' + chunks.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ol>';
    }

    function recentSessions(value) {
      const sessions = Array.isArray(value) ? value.map((item) => objectValue(item)).filter(Boolean) : [];
      if (!sessions.length) return '<p class="muted">No VS Code sessions yet.</p>';
      return sessions.map((item) => {
        const label = scalarField(item, "package_date") || scalarField(item, "packageDate") || "session";
        const createdAt = scalarField(item, "created_at") || scalarField(item, "createdAt");
        const tags = scalarTextList(item.error_tags);
        const text =
          scalarField(item, "native_version") ||
          scalarField(item, "nativeVersion") ||
          scalarField(item, "progress_note");
        return `
        <div class="field">
          <strong>${esc(label)}</strong>
          <span class="muted"> · ${esc(createdAt)}</span>
          ${tags.length ? '<div class="chips">' + tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>' : ''}
          <p class="text">${esc(text)}</p>
        </div>
      `;
      }).join("");
    }

    function shortSourceLabel(value) {
      const text = scalarText(value);
      return text.length > 46 ? text.slice(0, 21) + "..." + text.slice(-20) : text;
    }

    function compactStatusText(value, fallback) {
      const text = scalarText(value) || fallback || "";
      return text.length > 260 ? text.slice(0, 257) + "..." : text;
    }

    function messageText(value, fallback = "") {
      const obj = objectValue(value);
      return scalarText(value) || firstScalarField(obj, "message", "error", "detail") || fallback;
    }

    function messageErrorText(value, fallback = "Unknown error") {
      return messageText(value, fallback);
    }

    function setStatus(text, tone) {
      const el = $("status");
      if (!el) return;
      el.textContent = compactStatusText(
        text,
        tone === "busy" ? "Working..." : tone === "error" ? "Error." : "",
      );
      el.classList.remove("busy", "error");
      if (tone === "busy") el.classList.add("busy");
      if (tone === "error") el.classList.add("error");
      // Errors must interrupt the screen reader; routine status stays polite.
      el.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    }

    function playAudioOrPrompt(audio, fallbackStatus) {
      if (!audio || typeof audio.play !== "function") return;
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(() => {
          setStatus(fallbackStatus || "Audio ready — press play.");
        });
      }
    }

    // Streaming PCM player for Qwen-TTS Realtime. Audio arrives as base64
    // PCM 16-bit LE chunks from the host; we decode each chunk into a small
    // AudioBuffer and schedule it back-to-back via AudioBufferSourceNode so
    // the learner hears the native version as soon as the first chunk lands
    // (target ~100-200ms first sound vs ~1.5-3s with the old synchronous
    // HTTP path).
    let ttsStreamPlayer = null;
    function getTtsStreamPlayer() {
      if (ttsStreamPlayer) return ttsStreamPlayer;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ttsStreamPlayer = {
        ctx: null,
        ctor: Ctx,
        sampleRate: 24000,
        channels: 1,
        playheadTime: 0,
        sources: new Set(),
        byteLeftover: null,
        endOfStream: false,
        onDone: null,
        endedTimer: null,
      };
      return ttsStreamPlayer;
    }

    function disposeTtsStreamPlayer() {
      if (!ttsStreamPlayer) return;
      const player = ttsStreamPlayer;
      if (player.endedTimer) {
        clearTimeout(player.endedTimer);
        player.endedTimer = null;
      }
      for (const source of player.sources) {
        try { source.onended = null; source.stop(); } catch (_) {}
      }
      player.sources.clear();
      if (player.ctx) {
        try { player.ctx.close(); } catch (_) {}
      }
      ttsStreamPlayer = null;
    }

    function startTtsStream(meta) {
      const player = getTtsStreamPlayer();
      if (!player) return false;
      const sampleRate = positiveInteger(meta && meta.sampleRate) || 24000;
      const channels = positiveInteger(meta && meta.channels) || 1;
      // VS Code webview: a previous AudioContext can be left in "suspended"
      // by VS Code's tab visibility hooks. Recreating it here from inside the
      // click-handler chain is the cleanest way to guarantee a fresh, running
      // context whose currentTime is sane for back-to-back scheduling.
      if (player.ctx) {
        try { player.ctx.close(); } catch (_) {}
      }
      try {
        player.ctx = new player.ctor({ sampleRate });
      } catch (_) {
        try {
          player.ctx = new player.ctor();
        } catch (_) {
          return false;
        }
      }
      player.sampleRate = sampleRate;
      player.channels = channels;
      player.byteLeftover = null;
      player.endOfStream = false;
      player.playheadTime = player.ctx.currentTime;
      player.sources.clear();
      if (player.endedTimer) {
        clearTimeout(player.endedTimer);
        player.endedTimer = null;
      }
      if (player.ctx.state === "suspended" && typeof player.ctx.resume === "function") {
        player.ctx.resume().catch(() => {});
      }
      return true;
    }

    function base64ToUint8(b64) {
      if (typeof b64 !== "string" || !b64) return new Uint8Array(0);
      const compact = b64.replace(/\s+/g, "");
      let binary;
      try {
        binary = atob(compact);
      } catch (_) {
        return new Uint8Array(0);
      }
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    function feedTtsStreamChunk(base64) {
      const player = ttsStreamPlayer;
      if (!player || !player.ctx) return;
      let bytes = base64ToUint8(base64);
      if (bytes.length === 0) return;
      if (player.byteLeftover && player.byteLeftover.length) {
        const merged = new Uint8Array(player.byteLeftover.length + bytes.length);
        merged.set(player.byteLeftover, 0);
        merged.set(bytes, player.byteLeftover.length);
        bytes = merged;
        player.byteLeftover = null;
      }
      // PCM 16-bit LE: each sample is 2 bytes. If a chunk lands a half-sample
      // mid-frame, stash the odd byte and prepend it to the next chunk so
      // sample alignment doesn't drift into white noise.
      const evenLength = bytes.length - (bytes.length % 2);
      if (evenLength < bytes.length) {
        player.byteLeftover = bytes.slice(evenLength);
        bytes = bytes.slice(0, evenLength);
      }
      if (bytes.length === 0) return;

      const sampleCount = bytes.length / 2;
      const float32 = new Float32Array(sampleCount);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < sampleCount; i += 1) {
        const sample = view.getInt16(i * 2, true);
        float32[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
      }

      let buffer;
      try {
        buffer = player.ctx.createBuffer(player.channels, sampleCount, player.sampleRate);
      } catch (_) {
        return;
      }
      buffer.getChannelData(0).set(float32);

      const source = player.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(player.ctx.destination);
      const startAt = Math.max(player.playheadTime, player.ctx.currentTime);
      try {
        source.start(startAt);
      } catch (_) {
        return;
      }
      player.playheadTime = startAt + buffer.duration;
      player.sources.add(source);
      source.onended = () => {
        player.sources.delete(source);
        if (player.endOfStream && player.sources.size === 0 && typeof player.onDone === "function") {
          const done = player.onDone;
          player.onDone = null;
          try { done(); } catch (_) {}
        }
      };
    }

    function endTtsStream(onDone) {
      const player = ttsStreamPlayer;
      if (!player) {
        if (typeof onDone === "function") {
          try { onDone(); } catch (_) {}
        }
        return;
      }
      player.endOfStream = true;
      player.onDone = typeof onDone === "function" ? onDone : null;
      player.byteLeftover = null;
      // If chunks finished without producing any source nodes (zero audio),
      // fire onDone immediately so the caller doesn't wait forever.
      if (player.sources.size === 0 && player.onDone) {
        const done = player.onDone;
        player.onDone = null;
        try { done(); } catch (_) {}
      }
    }

    function cancelTtsStream() {
      const player = ttsStreamPlayer;
      if (!player) return;
      for (const source of player.sources) {
        try { source.onended = null; source.stop(); } catch (_) {}
      }
      player.sources.clear();
      player.byteLeftover = null;
      player.endOfStream = false;
      player.onDone = null;
      if (player.endedTimer) {
        clearTimeout(player.endedTimer);
        player.endedTimer = null;
      }
      if (player.ctx) {
        player.playheadTime = player.ctx.currentTime;
      }
    }

    function clearTodayGeneratedAudio() {
      const audio = $("todayAudio");
      if (!audio) return;
      try { audio.pause(); } catch (_) {}
      audio.removeAttribute("src");
      try { audio.load(); } catch (_) {}
      audio.hidden = true;
    }

    // Recovery net: a hung coach/provider must never trap the user with a
    // permanently disabled record button. Re-enable + advise after a while,
    // without faking success or hiding a late real result/error.
    let processingWatchdog = null;
    function clearProcessingWatchdog() {
      if (processingWatchdog) {
        clearTimeout(processingWatchdog);
        processingWatchdog = null;
      }
    }
    // A no-PROGRESS watchdog, not a total-duration one. Every stage transition
    // (transcribe/coach/tts/save × active/done) re-arms it, so a healthy
    // multi-leg turn — where the coach LLM leg alone routinely runs 20-40s and
    // each network leg is bounded host-side at HTTP_REQUEST_TIMEOUT_MS (90s) —
    // keeps resetting the clock and never trips it. It fires only if a single
    // stage emits nothing past that per-leg ceiling, i.e. the pipeline is
    // genuinely wedged (host event loop blocked, a dropped message), not merely
    // slow. It deliberately does NOT setBusy(false): the pipeline is still
    // alive and every reachable failure self-recovers with a bounded error that
    // the host turns into an "error" message, whose handler clears busy and
    // tears the recorder down authoritatively. Un-busying here would instead
    // strand a live turn with the record button clickable again mid-pipeline
    // (a second press then starts an overlapping turn), which is exactly the
    // spurious >45s fire that used to happen on normal turns.
    function armProcessingWatchdog() {
      clearProcessingWatchdog();
      processingWatchdog = setTimeout(() => {
        processingWatchdog = null;
        setStatus("Still working — this is taking longer than usual. Keep waiting; avoid refreshing until this turn finishes.", "busy");
      }, 100000);
    }

    function resetTransientActionBusyState(errorText) {
      const todayButton = document.querySelector('[data-action="today-tts"]');
      if (todayButton) {
        todayButton.disabled = Boolean(todayTtsBlockMessage(state, currentExampleText));
        delete todayButton.dataset.busy;
      }
      clearTransientAudioRequests();
      restoreSlowReadButtons();
      const wasGenerating = drillGenerating;
      clearDrillLineWatchdog();
      drillGenerating = false;
      activeDrillLineRequest = null;
      const drillButton = document.querySelector("[data-drill-generate]");
      if (drillButton) {
        drillButton.disabled = !isPracticeSetupReady(state);
      }
      if (wasGenerating) {
        const drillStatus = $("drillGenStatus");
        if (drillStatus) {
          drillStatus.textContent = errorText ? "Generation stopped: " + errorText : "Generation stopped.";
        }
      }
      resetRefreshBusyState();
      resetSidebarCommandBusyState();
    }

    function clearTransientAudioRequests() {
      activeTodayTtsRequest = null;
      activeSlowReadRequest = null;
      pendingSlowReadHost = null;
    }

    function beginTodayTtsRequest(button) {
      if (activeTodayTtsRequest) {
        setStatus("Example audio is still generating — wait for it to finish before starting another one.", "busy");
        return 0;
      }
      if (activeSlowReadRequest) {
        setStatus("Slow-read audio is still generating — wait for it to finish before generating example audio.", "busy");
        return 0;
      }
      const requestId = ++todayTtsRequestSeq;
      activeTodayTtsRequest = requestId;
      button.disabled = true;
      button.dataset.busy = "1";
      applyTransientAudioBusyState();
      return requestId;
    }

    function finishTodayTtsRequest(requestId) {
      const expectedId = positiveInteger(requestId);
      if (expectedId && activeTodayTtsRequest !== expectedId) {
        return false;
      }
      activeTodayTtsRequest = null;
      return true;
    }

    function armTodayTtsWatchdogs(requestId) {
      setTimeout(() => {
        if (activeTodayTtsRequest !== requestId) return;
        const status = $("todayTtsStatus");
        if (status) status.textContent = "Still generating example audio...";
        setStatus("Still generating example audio — keep waiting.", "busy");
      }, AUDIO_REQUEST_STILL_WORKING_MS);
      setTimeout(() => {
        if (activeTodayTtsRequest !== requestId) return;
        finishTodayTtsRequest(requestId);
        restoreSlowReadButtons();
        const btn = document.querySelector('[data-action="today-tts"]');
        if (btn) {
          btn.disabled = Boolean(todayTtsBlockMessage(state, currentExampleText));
          delete btn.dataset.busy;
        }
        const status = $("todayTtsStatus");
        if (status) status.textContent = "Example audio took too long — press the audio button to try again.";
        setStatus("Example audio took too long — press Generate audio to try again.", "error");
      }, AUDIO_REQUEST_HARD_TIMEOUT_MS);
    }

    function beginSlowReadRequest(button, busyLabel, host) {
      if (activeSlowReadRequest) {
        setStatus("Audio is still generating — wait for it to finish before starting another listen.", "busy");
        return 0;
      }
      if (activeTodayTtsRequest) {
        setStatus("Example audio is still generating — wait for it to finish before starting another listen.", "busy");
        return 0;
      }
      const requestId = ++slowReadRequestSeq;
      activeSlowReadRequest = {
        id: requestId,
        host: host || null,
        button: slowReadButtonDescriptor(button),
        busyLabel,
      };
      pendingSlowReadHost = host || null;
      button.disabled = true;
      button.dataset.busy = "1";
      button.textContent = busyLabel;
      applyTransientAudioBusyState();
      return requestId;
    }

    function finishSlowReadRequest(requestId) {
      const expectedId = positiveInteger(requestId);
      if (expectedId && activeSlowReadRequest && activeSlowReadRequest.id !== expectedId) {
        return null;
      }
      if (expectedId && !activeSlowReadRequest) {
        return null;
      }
      const request = activeSlowReadRequest;
      activeSlowReadRequest = null;
      pendingSlowReadHost = null;
      return request;
    }

    function restoreSlowReadButtons() {
      document.querySelectorAll('[data-slow-read]').forEach((btn) => {
        delete btn.dataset.transientDisabled;
        if (btn.dataset.busy === "1") delete btn.dataset.busy;
        btn.textContent = slowReadIdleLabel(btn);
        btn.disabled = Boolean(slowReadButtonBlockMessage(btn));
      });
      document.querySelectorAll('[data-drill-listen]').forEach((btn) => {
        delete btn.dataset.transientDisabled;
        if (btn.dataset.busy === "1") delete btn.dataset.busy;
        btn.textContent = slowReadIdleLabel(btn);
        btn.disabled = Boolean(slowReadButtonBlockMessage(btn));
      });
    }

    function slowReadButtonDescriptor(button) {
      if (!button) return null;
      if (button.hasAttribute("data-drill-listen")) {
        return {
          kind: "drill",
          index: datasetText(button, "drillIndex"),
          text: datasetText(button, "drillText"),
        };
      }
      return {
        kind: "slow",
        target: datasetText(button, "slowRead"),
      };
    }

    function slowReadButtonMatches(button, descriptor) {
      if (!button || !descriptor) return false;
      if (descriptor.kind === "slow") {
        return datasetText(button, "slowRead") === descriptor.target;
      }
      if (descriptor.kind !== "drill" || !button.hasAttribute("data-drill-listen")) return false;
      const index = datasetText(button, "drillIndex");
      const text = datasetText(button, "drillText");
      if (descriptor.text) return text === descriptor.text;
      return Boolean(descriptor.index) && index === descriptor.index;
    }

    function slowReadIdleLabel(button) {
      if (button && button.hasAttribute("data-drill-listen")) return "Listen";
      return datasetText(button, "slowRead") === "followUp" ? "🐢 Slow read" : "🐢 Slow";
    }

    function slowReadButtonBlockMessage(button) {
      if (!button) return "";
      if (button.hasAttribute("data-drill-listen")) {
        const example = drillExampleFromTrigger(button);
        return ttsActionBlockMessage(state, example && example.text, "listen to this line");
      }
      const target = datasetText(button, "slowRead");
      const text = target === "followUp"
        ? (lastTurn && lastTurn.followUpQuestion) || ""
        : (lastTurn && lastTurn.nativeVersion) || "";
      return ttsActionBlockMessage(state, text, target === "followUp" ? "slow-read the follow-up" : "slow-read the native version");
    }

    function applyTransientAudioBusyState() {
      if (activeTodayTtsRequest) {
        const button = document.querySelector('[data-action="today-tts"]');
        if (button) {
          button.disabled = true;
          button.dataset.busy = "1";
        }
        document.querySelectorAll('[data-slow-read], [data-drill-listen]').forEach((btn) => {
          btn.disabled = true;
          btn.dataset.transientDisabled = "1";
        });
        const status = $("todayTtsStatus");
        if (status && !/Still generating|took too long/i.test(status.textContent || "")) {
          status.textContent = "Generating example audio...";
        }
      }
      if (!activeSlowReadRequest) return;
      const request = activeSlowReadRequest;
      document.querySelectorAll('[data-slow-read], [data-drill-listen]').forEach((btn) => {
        btn.disabled = true;
        if (slowReadButtonMatches(btn, request.button)) {
          btn.dataset.busy = "1";
          delete btn.dataset.transientDisabled;
          btn.textContent = request.busyLabel || "Generating...";
        } else {
          btn.dataset.transientDisabled = "1";
        }
      });
    }

    function armSlowReadWatchdogs(requestId, retryLabel) {
      setTimeout(() => {
        if (!activeSlowReadRequest || activeSlowReadRequest.id !== requestId) return;
        setStatus("Still generating slow-read audio — keep waiting.", "busy");
      }, AUDIO_REQUEST_STILL_WORKING_MS);
      setTimeout(() => {
        if (!activeSlowReadRequest || activeSlowReadRequest.id !== requestId) return;
        finishSlowReadRequest(requestId);
        restoreSlowReadButtons();
        setStatus("Slow-read audio took too long — press " + (retryLabel || "Listen") + " to try again.", "error");
      }, AUDIO_REQUEST_HARD_TIMEOUT_MS);
    }

    function beginDrillLineRequest() {
      clearDrillLineWatchdog();
      const requestId = ++drillLineRequestSeq;
      activeDrillLineRequest = requestId;
      drillGenerating = true;
      return requestId;
    }

    function clearDrillLineWatchdog() {
      if (drillLineWatchdog) {
        clearTimeout(drillLineWatchdog);
        drillLineWatchdog = null;
      }
    }

    function armDrillLineWatchdog(requestId) {
      clearDrillLineWatchdog();
      drillLineWatchdog = setTimeout(() => {
        drillLineWatchdog = null;
        if (activeDrillLineRequest !== requestId || !drillGenerating) return;
        finishDrillLineRequest(requestId);
        renderDrillPanel();
        const status = $("drillGenStatus");
        if (status) status.textContent = "Generation took too long — press Generate to try again.";
        setStatus("Drill generation took too long — try again.", "error");
      }, 100000);
    }

    function finishDrillLineRequest(requestId) {
      const expectedId = positiveInteger(requestId);
      if (expectedId && activeDrillLineRequest !== expectedId) {
        return false;
      }
      clearDrillLineWatchdog();
      activeDrillLineRequest = null;
      drillGenerating = false;
      return true;
    }

    function setRecording(active) {
      const btn = $("record");
      if (!btn) return;
      btn.classList.toggle("recording", active);
      btn.setAttribute("aria-label", active ? "Stop recording" : "Start recording");
      btn.setAttribute("title", active ? "Stop recording" : "Start recording");
    }

    function setBusy(active, label) {
      const btn = $("record");
      if (btn) {
        btn.classList.toggle("busy", active);
        // Don't let an unrelated path (e.g. a failed example-audio request)
        // re-enable the record button while setup is still incomplete — that
        // briefly reopens the wasted-recording trap until the next re-render.
        btn.disabled = active || recordingBlockedBySetup;
      }
      if (label) setStatus(label, active ? "busy" : undefined);
    }

    function currentSettings() {
      return objectValue(state && state.settings) || {};
    }

    function recorderBackend() {
      const settings = currentSettings();
      const backend = scalarField(settings, "recorderBackend").toLowerCase();
      if (backend === "maclocal") return "macLocal";
      return backend === "webview" || backend === "auto" ? backend : "macLocal";
    }

    function blockedMicrophonePattern() {
      const settings = currentSettings();
      const pattern = scalarField(settings, "blockedMicrophoneNamePattern") || "iphone|ipad|continuity|karios";
      try {
        return new RegExp(pattern, "i");
      } catch {
        return /iphone|ipad|continuity|karios/i;
      }
    }

    function isBlockedMicrophone(label) {
      return blockedMicrophonePattern().test(String(label || ""));
    }

    function isLocalMicrophone(label) {
      const text = String(label || "").toLowerCase();
      return ["imac", "macbook", "mac mini", "mac studio", "studio display", "built-in", "built in", "internal"].some((name) => text.includes(name));
    }

    const WEBVIEW_RECORDER_AUDIO_BITS_PER_SECOND = 128000;
    const WEBVIEW_RECORDER_TIMESLICE_MS = 1000;

    function webviewAudioConstraints() {
      return {
        // For pronunciation practice we want the least processed voice the
        // browser can provide. Built-in echo/noise/AGC processing can make
        // takes sound phasey or muffled; use soft `ideal: false` hints so
        // older Electron builds can still fall back instead of rejecting mic
        // capture outright.
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 },
        sampleSize: { ideal: 16 },
      };
    }

    function webviewRecorderOptions(mimeType) {
      const options = { audioBitsPerSecond: WEBVIEW_RECORDER_AUDIO_BITS_PER_SECOND };
      if (mimeType) options.mimeType = mimeType;
      return options;
    }

    function webviewMimeTypeSupported(mimeType) {
      return typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(mimeType);
    }

    function createWebviewMediaRecorder(mediaStream) {
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(webviewMimeTypeSupported);
      try {
        return new MediaRecorder(mediaStream, webviewRecorderOptions(mimeType));
      } catch {
        // Older Electron/Chromium builds may reject bitrate hints even when
        // the MIME type is valid. Keep recording available and only drop the
        // optional quality hint in that narrow case.
        if (mimeType) {
          try {
            return new MediaRecorder(mediaStream, { mimeType });
          } catch (_) {
            // Last resort below: some webviews report support but still reject
            // the explicit MIME option at construction time.
          }
        }
        return new MediaRecorder(mediaStream);
      }
    }

    function stopWebviewStreamTracks(mediaStream) {
      if (!mediaStream || typeof mediaStream.getTracks !== "function") return;
      mediaStream.getTracks().forEach((track) => {
        try {
          if (track && typeof track.stop === "function") track.stop();
        } catch (_) {
          // Best effort cleanup: one bad track must not keep the recorder state
          // or the remaining tracks alive.
        }
      });
    }

    async function localAudioConstraints() {
      const base = webviewAudioConstraints();
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return base;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput" && device.label);
      const settings = currentSettings();
      const preferred = scalarField(settings, "preferredMicrophoneName").toLowerCase();
      const byPreferredName = preferred
        ? inputs.find((device) => !isBlockedMicrophone(device.label) && device.label.toLowerCase().includes(preferred))
        : undefined;
      const byLocalName = inputs.find((device) => !isBlockedMicrophone(device.label) && isLocalMicrophone(device.label));
      const byAllowedName = inputs.find((device) => !isBlockedMicrophone(device.label));
      const chosen = byPreferredName || byLocalName || byAllowedName;
      if (chosen) {
        const deviceId = scalarText(chosen.deviceId);
        if (deviceId) return { ...base, deviceId: { exact: deviceId } };
      }
      return base;
    }

    async function startRecording() {
      clearProcessingWatchdog();
      clearLocalAudioSource();
      activeRecordingTarget = consumePracticeTarget();
      const backend = recorderBackend();
      if (backend === "macLocal") {
        startNativeRecording("Using Mac local microphone.");
        return;
      }
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        if (backend === "auto") {
          startNativeRecording("Webview recorder unavailable.");
          return;
        }
        throw new Error("Webview recorder unavailable. Switch recorder backend to Auto or macLocal to use the native recorder.");
      }
      const fallbackToNative = backend === "auto";
      if (fallbackToNative) {
        setStatus("Preparing webview microphone…", "busy");
      } else {
        setStatus("Preparing microphone…", "busy");
      }
      const fallbackToNativeRecording = (error) => {
        if (!fallbackToNative) throw error;
        startNativeRecording((error && error.message) || String(error));
      };
      const resetWebviewCapture = () => {
        if (mediaRecorder) {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
        }
        stopWebviewStreamTracks(stream);
        stream = null;
        mediaRecorder = null;
      };
      // getUserMedia + the permission prompt is an unbounded, browser-owned
      // wait with no other signal; without this the press opens a silent
      // multi-second window (the same opaque-press gap the native path closes
      // with its streamed preparing phases). Mirror that cue here so both
      // recorder backends give immediate, legible feedback on the press.
      const recordingChunks = [];
      try {
        const constraints = await localAudioConstraints();
        if (fallbackToNative && (!constraints || !constraints.deviceId)) {
          startNativeRecording("Webview recorder could not find a local microphone.");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        mediaRecorder = createWebviewMediaRecorder(stream);
      } catch (error) {
        resetWebviewCapture();
        fallbackToNativeRecording(error);
        return;
      }
      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordingChunks.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        try {
          const stoppedRecorder = mediaRecorder;
          const mimeType = (stoppedRecorder && stoppedRecorder.mimeType) || "audio/webm";
          const blob = new Blob(recordingChunks, { type: mimeType });
          if (blob.size < 1000) {
            throw new Error("Recording was empty. Please try again after the microphone indicator appears.");
          }
          setLocalAudioSource(URL.createObjectURL(blob), true);
          setRecording(false);
          setBusy(true, "Sending to coach…");
          showStages(true);
          const base64 = await blobToBase64(blob);
          if (!base64) {
            throw new Error("Recording could not be encoded for processing.");
          }
          const priorTurn = pendingReplyContext;
          const practiceTarget = activeRecordingTarget;
          const requestId = ++practiceRequestSeq;
          activePracticeRequestId = requestId;
          vscode.postMessage({ type: "practiceAudio", mimeType, base64, priorTurn, practiceTarget, requestId });
          armProcessingWatchdog();
        } catch (error) {
          setBusy(false);
          setRecording(false);
          showStages(false);
          clearPendingPracticeContexts(true);
          setStatus((error && error.message) || String(error), "error");
        } finally {
          stopVuMeter();
          stopTimer();
          resetWebviewCapture();
          recorderMode = null;
          activeRecordingTarget = null;
        }
      };
      recorderMode = "webview";
      try {
        mediaRecorder.start(WEBVIEW_RECORDER_TIMESLICE_MS);
      } catch (error) {
        recorderMode = null;
        resetWebviewCapture();
        fallbackToNativeRecording(error);
        return;
      }
      setRecording(true);
      setStatus("Listening… speak now.");
      startVuMeter(stream);
      startTimer();
    }

    function stopRecording() {
      if (recorderMode === "native") {
        if (nativeStarting) {
          // The recorder is still spinning up. Don't tear it down half-born;
          // tell the user it's coming. They can stop once it's listening.
          setStatus("Starting recorder — one moment, then it will listen.");
          return;
        }
        const requestId = activeNativeStartRequestId;
        vscode.postMessage({ type: "stopNativeRecording", requestId });
        setRecording(false);
        stopTimer();
        setBusy(true, "Stopping native recorder…");
        armProcessingWatchdog();
        recorderMode = null;
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    let recordTransition = false;
    function toggleRecording() {
      if (recordTransition) return;
      if (isRecording()) {
        stopRecording();
        return;
      }
      if (blockIfTransientActionInProgress("recording")) return;
      // Block a second tap during the async getUserMedia/permission window so
      // we never open two microphone streams or fire two pipelines at once.
      recordTransition = true;
      startRecording()
        .catch(recoverStartRecordingFailure)
        .finally(() => { recordTransition = false; });
    }

    function practiceTurnInProgress() {
      const recordButton = $("record");
      const pipelineBusy = Boolean(recordButton && recordButton.classList.contains("busy"));
      return Boolean(recordTransition || nativeStarting || processingWatchdog || pipelineBusy || isRecording());
    }

    function blockIfPracticeTurnInProgress(message) {
      if (!practiceTurnInProgress()) return false;
      setStatus(message, "busy");
      return true;
    }

    function blockSetupChangeDuringPractice() {
      if (blockIfPracticeTurnInProgress("Finish or stop the current turn before changing setup.")) return true;
      return blockIfTransientActionInProgress("changing setup");
    }

    function blockPromptChangeDuringPractice() {
      if (blockIfPracticeTurnInProgress("Finish or stop the current turn before choosing another practice prompt.")) return true;
      return blockIfTransientActionInProgress("choosing another practice prompt");
    }

    function transientActionBlockMessage(actionLabel) {
      const suffix = actionLabel ? " before " + actionLabel + "." : ".";
      if (activeTodayTtsRequest) {
        return "Example audio is still generating — wait for it to finish" + suffix;
      }
      if (activeSlowReadRequest) {
        return "Slow-read audio is still generating — wait for it to finish" + suffix;
      }
      if (drillGenerating) {
        return "Drill lines are still generating — wait for them to finish" + suffix;
      }
      if (refreshInFlight) {
        return "Refresh is still loading — wait for it to finish" + suffix;
      }
      if (activeSidebarCommandRequest) {
        return (activeSidebarCommandRequest.label || "A setup action") + " is still running — wait for it to finish" + suffix;
      }
      return "";
    }

    function blockIfTransientActionInProgress(actionLabel) {
      const message = transientActionBlockMessage(actionLabel);
      if (!message) return false;
      setStatus(message, "busy");
      return true;
    }

    function resetSidebarCommandBusyState() {
      activeSidebarCommandRequest = null;
      document.querySelectorAll('[data-command-busy="1"]').forEach((btn) => {
        btn.disabled = false;
        delete btn.dataset.commandBusy;
      });
    }

    function sidebarCommandButtons() {
      return document.querySelectorAll([
        "#completeLocal",
        "#configureMaterials",
        "#openTask",
        "#openFolder",
        "#useQwenStack",
        "#useGeminiOnly",
        "[data-onboard]",
        "[data-key]",
        "[data-provider-setting]",
        "[data-config-setting]",
        "[data-sidebar-command]",
        "[data-speed]",
        "[data-voice-id]",
      ].join(","));
    }

    function markSidebarCommandButton(button) {
      if (!button || button.disabled) return;
      button.disabled = true;
      button.dataset.commandBusy = "1";
    }

    function applySidebarCommandBusyState() {
      if (!activeSidebarCommandRequest) return;
      sidebarCommandButtons().forEach(markSidebarCommandButton);
      setStatus((activeSidebarCommandRequest.label || "Action") + "…", "busy");
    }

    function beginSidebarCommand(button, label) {
      if (activeSidebarCommandRequest) {
        setStatus((activeSidebarCommandRequest.label || "A setup action") + " is still running — wait for it to finish.", "busy");
        return 0;
      }
      const requestId = ++sidebarCommandRequestSeq;
      activeSidebarCommandRequest = { id: requestId, label };
      markSidebarCommandButton(button);
      applySidebarCommandBusyState();
      return requestId;
    }

    function finishSidebarCommand(requestId) {
      const expectedId = positiveInteger(requestId);
      if (expectedId && (!activeSidebarCommandRequest || activeSidebarCommandRequest.id !== expectedId)) {
        return false;
      }
      resetSidebarCommandBusyState();
      return true;
    }

    function postSetupAction(payload, label, button) {
      const requestId = beginSidebarCommand(button, label);
      if (!requestId) return false;
      vscode.postMessage({ ...payload, requestId });
      return true;
    }

    function postSidebarCommand(command, label, button) {
      return postSetupAction({ type: "command", command }, label, button);
    }

    function clearRefreshWatchdog() {
      if (refreshWatchdog) {
        clearTimeout(refreshWatchdog);
        refreshWatchdog = null;
      }
    }

    function resetRefreshBusyState() {
      refreshInFlight = false;
      clearRefreshWatchdog();
      const button = $("refresh");
      if (!button || button.dataset.refreshBusy !== "1") return;
      button.disabled = false;
      delete button.dataset.refreshBusy;
    }

    function beginRefreshRequest(button) {
      if (refreshInFlight) {
        setStatus("Refresh is still loading — wait for it to finish.", "busy");
        return false;
      }
      refreshInFlight = true;
      if (button) {
        button.disabled = true;
        button.dataset.refreshBusy = "1";
      }
      setStatus("Refreshing lesson state…", "busy");
      clearRefreshWatchdog();
      refreshWatchdog = setTimeout(() => {
        if (!refreshInFlight) return;
        resetRefreshBusyState();
        setStatus("Refresh took too long — press ↻ to try again.", "error");
      }, 15000);
      return true;
    }

    function clearNativeStartWatchdog() {
      if (nativeStartWatchdog) {
        clearTimeout(nativeStartWatchdog);
        nativeStartWatchdog = null;
      }
    }

    function isCurrentNativeStartMessage(message) {
      const requestId = positiveInteger(message && message.requestId);
      return requestId > 0 && requestId === activeNativeStartRequestId;
    }

    function activeTurnMessageRequestId(message) {
      const requestId = positiveInteger(message && message.requestId);
      return requestId > 0 && (requestId === activePracticeRequestId || requestId === activeNativeStartRequestId) ? requestId : 0;
    }

    function clearActiveTurnRequestId(requestId) {
      if (requestId === activePracticeRequestId) activePracticeRequestId = 0;
      if (requestId === activeNativeStartRequestId) activeNativeStartRequestId = 0;
    }

    function isCurrentTurnErrorMessage(message) {
      const requestId = positiveInteger(message && message.requestId);
      if (!requestId) return true;
      return requestId === activeNativeStartRequestId || requestId === activePracticeRequestId;
    }

    function isCurrentStageMessage(message) {
      const requestId = positiveInteger(message && message.requestId);
      return !requestId || requestId === activePracticeRequestId || requestId === activeNativeStartRequestId;
    }

    // Tear down a live webview MediaRecorder + mic stream WITHOUT firing its
    // onstop pipeline. Calling mediaRecorder.stop() here would post a second
    // practiceAudio for audio the user never chose to submit, racing a turn
    // on top of whatever error we are handling, and would leave the OS mic
    // indicator lit. Mirrors the onstop finally cleanup minus the post.
    function abortWebviewRecorder() {
      if (mediaRecorder) {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        try {
          if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
        } catch (_) {
          /* already inactive — nothing to do */
        }
      }
      stopWebviewStreamTracks(stream);
      stream = null;
      mediaRecorder = null;
    }

    function recoverStartRecordingFailure(error) {
      clearProcessingWatchdog();
      clearNativeStartWatchdog();
      nativeStarting = false;
      recorderMode = null;
      abortWebviewRecorder();
      setRecording(false);
      stopVuMeter();
      stopTimer();
      setBusy(false);
      clearPendingPracticeContexts(true);
      showStages(false);
      setStatus((error && error.message) || String(error), "error");
    }

    function startNativeRecording(reason) {
      clearProcessingWatchdog();
      const requestId = ++nativeStartRequestSeq;
      activeNativeStartRequestId = requestId;
      recorderMode = "native";
      nativeStarting = true;
      setRecording(true);
      // Acknowledge the press instantly with a moving prep status, but DON'T
      // start the elapsed timer yet: it must count actual speakable recording
      // time, not microphone warm-up. The host streams nativeRecordingPreparing
      // phases; the timer starts when nativeRecordingStarted arrives.
      setStatus((reason ? reason + " " : "") + "Preparing microphone…", "busy");
      setTimerText("00:00");
      const practiceTarget = activeRecordingTarget || consumePracticeTarget();
      activeRecordingTarget = practiceTarget;
      const priorTurn = pendingReplyContext;
      pendingReplyContext = null;
      vscode.postMessage({ type: "startNativeRecording", practiceTarget, priorTurn, requestId });
      // Generous: host-side ffmpeg spawn + a ~900ms readiness probe; a healthy
      // start confirms well within this. If nothing comes back, unwind the
      // stuck state instead of leaving the user trapped.
      clearNativeStartWatchdog();
      nativeStartWatchdog = setTimeout(() => {
        nativeStartWatchdog = null;
        if (activeNativeStartRequestId !== requestId || !nativeStarting) return; // start already resolved or superseded
        nativeStarting = false;
        recorderMode = null;
        setRecording(false);
        stopTimer();
        setBusy(false);
        clearPendingPracticeContexts(true);
        setStatus(
          "The Mac local recorder did not start. Check microphone permission and that ffmpeg is installed, then press record to try again.",
          "error",
        );
      }, 15000);
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function normalizeWord(word) {
      return String(word || "").toLowerCase().replace(/[^a-z0-9']/gi, "");
    }

    function normalizeComparable(text) {
      return String(text || "").toLowerCase().replace(/[^a-z0-9']+/gi, " ").trim();
    }

    function wordDiff(left, right) {
      const a = (String(left || "").match(/\S+/g)) || [];
      const b = (String(right || "").match(/\S+/g)) || [];
      const m = a.length;
      const n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i += 1) {
        dp.push(new Array(n + 1).fill(0));
      }
      for (let i = 0; i < m; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (normalizeWord(a[i]) && normalizeWord(a[i]) === normalizeWord(b[j])) {
            dp[i + 1][j + 1] = dp[i][j] + 1;
          } else {
            dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }
      const leftMarks = new Array(m).fill("removed");
      const rightMarks = new Array(n).fill("added");
      let i = m;
      let j = n;
      while (i > 0 && j > 0) {
        if (normalizeWord(a[i - 1]) && normalizeWord(a[i - 1]) === normalizeWord(b[j - 1])) {
          leftMarks[i - 1] = "common";
          rightMarks[j - 1] = "common";
          i -= 1;
          j -= 1;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
          i -= 1;
        } else {
          j -= 1;
        }
      }
      return {
        left: a.map((word, k) => ({ word, mark: leftMarks[k] })),
        right: b.map((word, k) => ({ word, mark: rightMarks[k] })),
      };
    }

    function renderDiffSide(items) {
      if (!items.length) return '<span class="muted">—</span>';
      return items.map(({ word, mark }) => {
        const safe = esc(word);
        if (mark === "removed") return '<span class="diff-removed">' + safe + '</span>';
        if (mark === "added") return '<span class="diff-added">' + safe + '</span>';
        return safe;
      }).join(" ");
    }

    function pushDrillExample(list, item, fallbackLabel, source) {
      if (!item) return;
      const obj = objectValue(item);
      const cleanText = obj ? compactScalarField(obj, "text") : compactScalarText(item);
      if (!cleanText) return;
      const label = obj
        ? scalarField(obj, "label") || scalarField(obj, "cue") || scalarField(obj, "id") || scalarText(fallbackLabel) || "FSI drill"
        : scalarText(fallbackLabel) || "FSI drill";
      const reason = obj ? scalarField(obj, "reason") || scalarField(obj, "note") : "";
      list.push({ label, text: cleanText, reason, source: scalarText(source) || scalarField(obj, "source") });
    }

    function collectDrillExamples(result) {
      const list = [];
      if (Array.isArray(result && result.drillExamples)) {
        result.drillExamples.forEach((item, idx) => {
          const obj = objectValue(item);
          pushDrillExample(
            list,
            item,
            scalarField(obj, "label") || "Coach drill " + (idx + 1),
            scalarField(obj, "source") || "coach",
          );
        });
      }
      const drill = objectValue(state && state.drill) || {};
      const rounds = Array.isArray(drill.rounds) ? drill.rounds.map((item) => objectValue(item)).filter(Boolean) : [];
      rounds.forEach((round) => {
        const roundLabel = firstScalarField(round, "label", "id") || "FSI drill";
        const examples = Array.isArray(round.examples) ? round.examples : [];
        examples.forEach((item) => pushDrillExample(list, item, roundLabel, "prebuilt"));
      });
      const chunks = drill && drill.shadowing_loop && Array.isArray(drill.shadowing_loop.chunks)
        ? drill.shadowing_loop.chunks
        : [];
      chunks.forEach((item, idx) => pushDrillExample(list, item, "Shadowing chunk " + (idx + 1), "prebuilt"));

      const blocked = new Set([
        normalizeComparable(result && result.nativeVersion),
        normalizeComparable(result && result.referenceText),
        normalizeComparable(result && result.transcript),
      ].filter(Boolean));
      const seen = new Set();
      return list.filter((item) => {
        const key = normalizeComparable(item.text);
        if (!key || seen.has(key) || blocked.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function collectDrillLibrary() {
      const list = [];
      const drill = objectValue(state && state.drill) || {};
      const rounds = Array.isArray(drill.rounds) ? drill.rounds.map((item) => objectValue(item)).filter(Boolean) : [];
      rounds.forEach((round) => {
        const roundLabel = firstScalarField(round, "label", "id") || "FSI drill";
        const examples = Array.isArray(round.examples) ? round.examples : [];
        examples.forEach((item) => pushDrillExample(list, item, roundLabel, "prebuilt"));
      });
      const chunks = drill && drill.shadowing_loop && Array.isArray(drill.shadowing_loop.chunks)
        ? drill.shadowing_loop.chunks
        : [];
      chunks.forEach((item, idx) => pushDrillExample(list, item, "Shadowing chunk " + (idx + 1), "prebuilt"));
      drillGeneratedLines.forEach((item) => pushDrillExample(list, item, item.label || "AI drill", "coach"));

      const seen = new Set();
      return list.filter((item) => {
        const key = normalizeComparable(item.text);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function drillAttemptKey(text) {
      return normalizeComparable(text);
    }

    function drillAttemptCount(text) {
      const key = drillAttemptKey(text);
      return key ? (drillAttempts[key] || 0) : 0;
    }

    function bumpDrillAttempt(text) {
      const key = drillAttemptKey(text);
      if (!key) return 0;
      drillAttempts[key] = (drillAttempts[key] || 0) + 1;
      return drillAttempts[key];
    }

    function updateDrillAttemptBadge(key, count) {
      if (!key) return;
      const safeKey = (window.CSS && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
      const badge = document.querySelector('[data-drill-attempt-badge][data-drill-attempt-key="' + safeKey + '"]');
      if (!badge) return;
      const counter = badge.querySelector('[data-drill-attempt-count]');
      if (counter) counter.textContent = String(count);
      badge.hidden = count <= 0;
    }

    function renderDrillPanel() {
      const host = $("drill");
      if (!host) return;
      const drill = objectValue(state && state.drill) || {};
      // Same gate as the record button: generating lines calls the coach, so
      // before a key + lesson exist the button must not invite a click that
      // only fails after a round trip with a raw "Missing API key" error.
      const setupMessage = setupBlockMessage(state);
      const listenBlockMessage = ttsActionBlockMessage(state, "sample", "listen to this line");
      const generateDisabled = drillGenerating || Boolean(setupMessage);
      const generateHint = setupMessage
        ? setupMessage
        : (drillGenerating ? "Generating new lines…" : "Fresh FSI substitutions from your coach model");
      drillLibrary = collectDrillLibrary();
      const tags = scalarTextList(drill.primary_tags);
      const method = scalarField(drill, "method") || "FSI-style drill";
      const requiredFrames = scalarField(drill, "required_frames");
      const items = drillLibrary.map((example, index) => drillExampleHtml(example, {
        persistent: true,
        attemptKey: drillAttemptKey(example.text),
        attempts: drillAttemptCount(example.text),
        libIndex: index,
        practiceDisabled: Boolean(setupMessage),
        listenDisabled: Boolean(listenBlockMessage),
      })).join("");
      const listHtml = drillLibrary.length
        ? '<ol class="drill-example-list">' + items + '</ol>'
        : '<p class="muted">No drill lines yet. Generate a few below.</p>';
      const planHtml = `
        <details class="result-details drill-plan">
          <summary>Drill plan</summary>
          <div class="field"><span class="label">Routine</span>${simpleList(drill.routine_zh)}</div>
          <div class="field"><span class="label">Shadowing</span>${shadowing(drill.shadowing_loop)}</div>
          <div class="field"><span class="label">Repair focus</span>${simpleList(drill.repair_drills)}</div>
        </details>`;
      host.innerHTML = `
        <div class="drill-head">
          <h3>Drill workbench</h3>
          <span class="muted">${drillLibrary.length} line${drillLibrary.length === 1 ? "" : "s"} · practice as many times as you like</span>
        </div>
        <div class="chips">
          <span class="chip">${esc(method)}</span>
          ${tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("")}
          ${requiredFrames ? '<span class="chip">use ' + esc(requiredFrames) + ' frames</span>' : ''}
        </div>
        ${listHtml}
        <div class="loop-actions drill-generate-row">
          <button class="secondary" data-drill-generate="5" ${generateDisabled ? "disabled" : ""}>＋ Generate 5 more lines</button>
          <span class="muted" id="drillGenStatus">${esc(generateHint)}</span>
        </div>
        ${planHtml}
      `;
    }

    function drillChoiceHtml(examples) {
      if (!Array.isArray(examples) || !examples.length) return "";
      const items = examples.map((example, index) => drillExampleHtml(example, {
        index,
        listenDisabled: Boolean(ttsActionBlockMessage(state, example && example.text, "listen to this line")),
      })).join("");
      return '<div class="fsi-choice-card">' +
        '<div class="fsi-choice-head"><strong>FSI next lines</strong><span>choose practice or skip</span></div>' +
        '<ol class="drill-example-list">' + items + '</ol>' +
        '<div class="loop-actions"><button class="secondary" data-drill-skip="1">Skip drill</button></div>' +
      '</div>';
    }

    function drillExampleHtml(example, options) {
      const opts = options || {};
      const indexAttr = opts.index != null ? ' data-drill-index="' + esc(opts.index) + '"' : '';
      const textAttr = indexAttr ? '' : ' data-drill-text="' + esc(example.text || "") + '" data-drill-label="' + esc(example.label || "FSI drill") + '"';
      const persistent = Boolean(opts.persistent);
      const attempts = Number(opts.attempts) || 0;
      const keyAttr = opts.attemptKey ? ' data-drill-attempt-key="' + esc(opts.attemptKey) + '"' : '';
      const practiceDisabled = opts.practiceDisabled ? " disabled" : "";
      const listenDisabled = opts.listenDisabled ? " disabled" : "";
      const badge = persistent
        ? '<span class="drill-attempt-badge" data-drill-attempt-badge="1"' + keyAttr + (attempts ? '' : ' hidden') + '>⟳ <span data-drill-attempt-count="1">' + esc(attempts) + '</span></span>'
        : '';
      const practiceLabel = persistent ? (attempts ? "Practice again" : "Practice") : "Practice";
      const sourceTag = persistent && example.source === "coach"
        ? '<span class="drill-example-source">AI</span>'
        : '';
      return '<li class="drill-example"' + keyAttr + '>' +
        '<span class="drill-example-label">' + esc(example.label || "FSI drill") + sourceTag + badge + '</span>' +
        '<p class="drill-example-text">' + esc(example.text || "") + '</p>' +
        (example.reason ? '<p class="drill-example-reason">' + esc(example.reason) + '</p>' : '') +
        '<div class="drill-example-actions">' +
          '<button class="secondary" data-drill-listen="1"' + indexAttr + textAttr + listenDisabled + '>Listen</button>' +
          '<button data-drill-practice="1"' + indexAttr + textAttr + keyAttr + practiceDisabled + '>' + practiceLabel + '</button>' +
        '</div>' +
      '</li>';
    }

    function drillExampleFromTrigger(trigger) {
      const idx = Number(datasetText(trigger, "drillIndex"));
      if (Number.isFinite(idx) && idx >= 0 && currentDrillSuggestions[idx]) {
        return currentDrillSuggestions[idx];
      }
      const text = compactScalarText(datasetText(trigger, "drillText"));
      if (!text) return null;
      return {
        label: datasetText(trigger, "drillLabel") || "FSI drill",
        text,
      };
    }

    // Bring the record button into view and tell the user to start when ready.
    // Auto-starting recording from "Practice"/"Imitate"/"Reply" clipped the
    // opening words of every rep (the user is still reading the line). Recording
    // now always begins on an explicit tap of the red button, which consumes
    // the pendingPracticeTarget / reply context set just before this call.
    function cueRecording(label) {
      const cta = $("record");
      if (cta) {
        if (typeof cta.scrollIntoView === "function") {
          cta.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        if (typeof cta.focus === "function") {
          cta.focus({ preventScroll: true });
        }
      }
      setStatus(label
        ? "Ready — press the red button when you want to record: " + label
        : "Ready — press the red button to record.");
    }

    function ensurePracticeSetupReady() {
      const message = setupBlockMessage(state);
      if (!message) return true;
      setStatus(message, "error");
      return false;
    }

    function ensureTtsActionReady(text, actionLabel) {
      const message = ttsActionBlockMessage(state, text, actionLabel);
      if (!message) return true;
      setStatus(message, "error");
      return false;
    }

    function startDrillPractice(example) {
      const text = compactScalarText(example && example.text);
      if (!text) return false;
      if (blockPromptChangeDuringPractice()) return false;
      if (!ensurePracticeSetupReady()) return false;
      const label = scalarField(example, "label") || "FSI drill";
      pendingReplyContext = null;
      pendingPracticeTarget = practiceTarget(text, label, "");
      vscode.postMessage({ type: "clearReplyContext" });
      cueRecording(label);
      return true;
    }

    function followUpCardHtml(result, followUpAudioSrc) {
      if (!result || !result.followUpQuestion) return "";
      const audioTag = followUpAudioSrc
        ? '<audio id="followUpAudio" controls preload="auto" src="' + esc(followUpAudioSrc) + '"></audio>'
        : '';
      const slowDisabled = ttsActionBlockMessage(state, result.followUpQuestion, "slow-read the follow-up") ? " disabled" : "";
      return '<div class="follow-up-card">' +
        '<span class="follow-up-label">Coach asks</span>' +
        '<p class="follow-up-text">' + esc(result.followUpQuestion) + '</p>' +
        audioTag +
        '<div class="loop-actions">' +
          '<button type="button" class="slow-read-btn" data-slow-read="followUp" title="Re-read at 0.7×"' + slowDisabled + '>🐢 Slow read</button>' +
          '<button type="button" id="answerFollowUpBtn" data-loop-action="reply">Answer follow-up →</button>' +
        '</div>' +
      '</div>';
    }

    let lastTurn = null;
    let pendingReplyContext = null;
    let turnHistory = [];

    function pruneTurnHistory() {
      while (turnHistory.length > MAX_TURN_HISTORY) {
        const dropped = turnHistory.shift();
        const audioUrl = dropped && dropped.userAudioUri;
        if (audioUrl && turnAudioObjectUrls.has(audioUrl)) {
          URL.revokeObjectURL(audioUrl);
          turnAudioObjectUrls.delete(audioUrl);
        }
      }
      turnHistory.forEach((turn, index) => {
        turn.turnIndex = index + 1;
      });
    }

    function turnBreadcrumbHtml() {
      const total = turnHistory.length;
      if (total === 0) return "";
      const items = turnHistory.map((turn, idx) => {
        const isCurrent = idx === total - 1;
        const cls = "turn-chip " + (isCurrent ? "current" : "done");
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : "";
        const check = isCurrent ? "" : " ✓";
        return '<span class="' + cls + '" data-turn-index="' + (idx + 1) + '" role="button" tabindex="0">Turn ' + (idx + 1) + check + replyTag + '</span>';
      });
      return '<div class="turn-breadcrumb" aria-label="Conversation turns">' + items.join('<span class="turn-arrow" aria-hidden="true">→</span>') + '</div>';
    }

    function renderTurnHistory() {
      const panel = $("turnHistory");
      if (!panel) return;
      clearTurnResetArmTimer();
      if (turnHistory.length <= 1) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const earlier = turnHistory.slice(0, -1);
	      const items = earlier.map((turn) => {
	        const audio = turn.userAudioUri ? '<audio controls src="' + esc(turn.userAudioUri) + '"></audio>' : '';
	        const nativeAudio = turn.nativeAudioUri ? '<audio controls src="' + esc(turn.nativeAudioUri) + '"></audio>' : '';
	        const nativeLabel = turn.mode === "shadow" ? (turn.referenceLabel || "Reference") : "Native";
	        const followUpBlock = turn.followUpQuestion
          ? '<div class="turn-followup"><span class="muted">→ Coach asked:</span> ' + esc(turn.followUpQuestion) + '</div>'
          : '';
        const replyTag = turn.priorTurn ? '<span class="turn-chip-tag">reply</span>' : '';
        return '<li class="turn-item" data-turn-item="' + esc(String(turn.turnIndex)) + '">' +
          '<div class="turn-head"><span class="turn-num">Turn ' + esc(String(turn.turnIndex)) + '</span>' + replyTag + '</div>' +
          '<div class="turn-cols">' +
            '<div class="turn-col"><span class="muted">You said</span><p>' + esc(turn.transcript) + '</p>' + audio + '</div>' +
	            '<div class="turn-col"><span class="muted">' + esc(nativeLabel) + '</span><p>' + esc(turn.nativeVersion) + '</p>' + nativeAudio + '</div>' +
          '</div>' +
          followUpBlock +
        '</li>';
      }).join("");
      panel.innerHTML =
        '<div class="turn-history-head">' +
          '<h3>Conversation so far</h3>' +
          '<button class="ghost" id="resetTurns" title="Start a new conversation">Reset</button>' +
        '</div>' +
        '<ol class="turn-history">' + items + '</ol>';
      const reset = $("resetTurns");
      if (reset) {
        let resetArmed = false;
        reset.addEventListener("click", () => {
          if (
            blockIfPracticeTurnInProgress("Finish or stop the current turn before resetting the conversation.") ||
            blockIfTransientActionInProgress("resetting the conversation")
          ) {
            clearTurnResetArmTimer();
            resetArmed = false;
            reset.textContent = "Reset";
            reset.setAttribute("title", "Start a new conversation");
            return;
          }
          // A multi-turn conversation is real practice work; one stray click on
          // a ghost button must not wipe it silently. Require a confirm click,
          // auto-disarming after a few seconds.
          if (!resetArmed) {
            resetArmed = true;
            reset.textContent = "Reset? click again";
            reset.setAttribute("title", "Click again to clear this conversation");
            turnResetArmTimer = setTimeout(() => {
              turnResetArmTimer = null;
              if (!reset.isConnected) return;
              resetArmed = false;
              reset.textContent = "Reset";
              reset.setAttribute("title", "Start a new conversation");
            }, 4000);
            return;
          }
          clearTurnResetArmTimer();
          clearTurnAudioObjectUrls();
          turnHistory = [];
          lastTurn = null;
          clearPendingPracticeContexts(true);
          resetTransientActionBusyState("");
          clearLocalAudioSource();
          removeSlowReadAudioPlayer();
          renderTurnHistory();
          $("result").hidden = true;
          setStatus("New conversation. Tap to speak.");
        });
      }
    }

	    function renderResult(result) {
      removeSlowReadAudioPlayer();
		      const diff = wordDiff(result.transcript, result.nativeVersion);
	      const userAudioSrc = (result && result.localAudioUri) || ($("localAudio").src || "");
	      const nativeAudioSrc = (result && result.audioUri) || "";
	      const followUpAudioSrc = (result && result.followUpAudioUri) || "";
	      const isShadow = result && result.mode === "shadow";
	      const nativeLabel = isShadow ? (result.referenceLabel || "Reference") : "Native says";
	      const heading = isShadow ? "Shadowing check" : "Coaching";
	      const nativeSlowDisabled = ttsActionBlockMessage(state, result && result.nativeVersion, "slow-read the native version")
	        ? " disabled"
	        : "";
      currentDrillSuggestions = collectDrillExamples(result || {});
      const tagsHtml = Array.isArray(result.errorTags) && result.errorTags.length
        ? '<div class="chips">' + result.errorTags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>'
        : '<p class="muted">No tags.</p>';
      const problemsHtml = Array.isArray(result.problems) && result.problems.length
        ? '<ul>' + result.problems.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>'
        : '<p class="muted">No specific problems.</p>';

      $("result").hidden = false;
      $("result").innerHTML = `
	        <h3>${heading} · Turn ${turnHistory.length || 1}</h3>
        ${turnBreadcrumbHtml()}
        <div class="diff-card">
          <div class="diff-side diff-you">
            <div class="diff-label">You said</div>
            <p class="diff-text">${renderDiffSide(diff.left)}</p>
          </div>
          <div class="diff-side diff-native">
	            <div class="diff-label">${esc(nativeLabel)}</div>
            <p class="diff-text">${renderDiffSide(diff.right)}</p>
          </div>
        </div>
        <div class="ab-audio">
          <div class="ab-side">
            <span class="ab-label muted">Your audio</span>
            ${userAudioSrc ? '<audio controls src="' + esc(userAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
          <div class="ab-side">
            <span class="ab-label muted">Native audio
              ${result.nativeVersion ? '<button type="button" class="slow-read-btn" data-slow-read="native" title="Re-read at 0.7×"' + nativeSlowDisabled + '>🐢 Slow</button>' : ''}
            </span>
            ${nativeAudioSrc ? '<audio id="nativeAudio" controls src="' + esc(nativeAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
        </div>
        ${result.quickFix ? '<div class="quick-fix-card"><span class="label">Quick fix</span><p>' + esc(result.quickFix) + '</p></div>' : ''}
        ${followUpCardHtml(result, followUpAudioSrc)}
        <div class="loop-actions">
          <button class="secondary" data-loop-action="imitate">${isShadow ? "Practice " + esc(nativeLabel) + " again" : "Imitate native"}</button>
        </div>
        ${drillChoiceHtml(currentDrillSuggestions)}
        <details class="result-details">
          <summary>More details</summary>
          <div class="field"><span class="label">Problems</span>${problemsHtml}</div>
          <div class="field"><span class="label">Tags</span>${tagsHtml}</div>
          ${result.shadowingInstruction ? '<div class="field"><span class="label">Repeat</span><p class="text">' + esc(result.shadowingInstruction) + '</p></div>' : ''}
          ${result.nextDrill ? '<div class="field"><span class="label">Next drill</span><p class="text">' + esc(result.nextDrill) + '</p></div>' : ''}
          <div class="field"><span class="label">Session folder</span><code>${esc(result.sessionDir)}</code></div>
        </details>
      `;
      const followUpAudioEl = $("followUpAudio");
      const answerBtn = $("answerFollowUpBtn");
      if (followUpAudioEl && answerBtn) {
        followUpAudioEl.addEventListener("ended", () => {
          if (typeof answerBtn.focus === "function") {
            answerBtn.focus({ preventScroll: false });
          }
        }, { once: true });
      }
    }

    addElementListener("record", "click", toggleRecording);
    addElementListener("refresh", "click", (event) => {
      if (blockIfPracticeTurnInProgress("Current turn is still running — wait for it to finish before refreshing.")) return;
      if (blockIfTransientActionInProgress("refreshing")) return;
      if (!beginRefreshRequest(event.currentTarget || $("refresh"))) return;
      vscode.postMessage({ type: "refresh" });
    });
    function focusTurnChip(trigger) {
      const idx = positiveInteger(datasetText(trigger, "turnIndex"));
      if (!idx) return false;
      const targetItem = document.querySelector('[data-turn-item="' + idx + '"]');
      if (targetItem && typeof targetItem.scrollIntoView === "function") {
        targetItem.scrollIntoView({ behavior: "smooth", block: "center" });
        return true;
      }
      if (idx === turnHistory.length) {
        const result = $("result");
        if (result && typeof result.scrollIntoView === "function") {
          result.scrollIntoView({ behavior: "smooth", block: "start" });
          return true;
        }
      }
      return false;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const trigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (!trigger) return;
      event.preventDefault();
      focusTurnChip(trigger);
    });
    document.addEventListener("click", (event) => {
      const breadcrumbTrigger = event.target.closest && event.target.closest("[data-turn-index]");
      if (breadcrumbTrigger) {
        if (focusTurnChip(breadcrumbTrigger)) return;
      }
      const drillListenTrigger = event.target.closest && event.target.closest("[data-drill-listen]");
      if (drillListenTrigger) {
        if (blockIfPracticeTurnInProgress("Finish or stop the current turn before listening to another line.")) return;
        if (blockIfTransientActionInProgress("listening to another line")) return;
        const example = drillExampleFromTrigger(drillListenTrigger);
        const exampleText = compactScalarText(example && example.text);
        if (!exampleText) return;
        if (!ensureTtsActionReady(exampleText, "listen to this line")) return;
        const requestId = beginSlowReadRequest(drillListenTrigger, "Listening…", drillListenTrigger.closest(".drill-example"));
        if (!requestId) return;
        vscode.postMessage({ type: "slowRead", text: exampleText, target: "drill", speed: 0.85, requestId });
        armSlowReadWatchdogs(requestId, "Listen");
        return;
      }
      const heroPracticeTrigger = event.target.closest && event.target.closest("[data-hero-practice]");
      if (heroPracticeTrigger) {
        const text = compactScalarText(currentExampleText);
        if (!text) {
          setStatus("No example line to practice yet.", "error");
          return;
        }
        startDrillPractice({ text, label: "Today's line" });
        return;
      }
      const drillPracticeTrigger = event.target.closest && event.target.closest("[data-drill-practice]");
      if (drillPracticeTrigger) {
        const example = drillExampleFromTrigger(drillPracticeTrigger);
        if (!startDrillPractice(example)) return;
        const attemptKey = datasetText(drillPracticeTrigger, "drillAttemptKey");
        if (attemptKey && example && example.text) {
          const count = bumpDrillAttempt(example.text);
          updateDrillAttemptBadge(attemptKey, count);
          drillPracticeTrigger.textContent = "Practice again";
        }
        return;
      }
      const drillGenerateTrigger = event.target.closest && event.target.closest("[data-drill-generate]");
      if (drillGenerateTrigger) {
        if (blockIfPracticeTurnInProgress("Finish or stop the current turn before generating new drill lines.")) return;
        if (blockIfTransientActionInProgress("generating new drill lines")) return;
        // Defense in depth: the button is rendered disabled before setup, but
        // never let a stray click run the coach into a guaranteed key error.
        if (!ensurePracticeSetupReady()) return;
        const count = positiveInteger(datasetText(drillGenerateTrigger, "drillGenerate")) || 5;
        const requestId = beginDrillLineRequest();
        drillGenerateTrigger.disabled = true;
        const status = $("drillGenStatus");
        if (status) status.textContent = "Generating new lines…";
        setStatus("Generating new drill lines…", "busy");
        const existing = drillLibrary.map((item) => item.text);
        vscode.postMessage({ type: "generateDrillLines", count, existing, requestId });
        armDrillLineWatchdog(requestId);
        return;
      }
      const drillSkipTrigger = event.target.closest && event.target.closest("[data-drill-skip]");
      if (drillSkipTrigger) {
        const card = drillSkipTrigger.closest(".fsi-choice-card");
        if (card) card.hidden = true;
        currentDrillSuggestions = [];
        setStatus("FSI drill skipped. Ready for free practice.");
        return;
      }
      const slowTrigger = event.target.closest && event.target.closest("[data-slow-read]");
      if (slowTrigger) {
        if (blockIfPracticeTurnInProgress("Finish or stop the current turn before generating slow-read audio.")) return;
        if (blockIfTransientActionInProgress("generating slow-read audio")) return;
        const target = datasetText(slowTrigger, "slowRead");
        const text = target === "followUp"
          ? compactScalarText(lastTurn && lastTurn.followUpQuestion)
          : compactScalarText(lastTurn && lastTurn.nativeVersion);
        if (!text) return;
        if (!ensureTtsActionReady(text, target === "followUp" ? "slow-read the follow-up" : "slow-read the native version")) return;
        const requestId = beginSlowReadRequest(slowTrigger, "🐢 …", null);
        if (!requestId) return;
        vscode.postMessage({ type: "slowRead", text, target, speed: 0.7, requestId });
        armSlowReadWatchdogs(requestId, "Slow");
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-loop-action]");
      if (!trigger) return;
      const action = datasetText(trigger, "loopAction");
      if (action !== "imitate" && action !== "reply") return;
      if (blockPromptChangeDuringPractice()) return;
      if (!ensurePracticeSetupReady()) return;
      const lastNativeVersion = compactScalarText(lastTurn && lastTurn.nativeVersion);
      const lastFollowUpQuestion = compactScalarText(lastTurn && lastTurn.followUpQuestion);
      const lastTranscript = compactScalarText(lastTurn && lastTurn.transcript);
      const lastMode = scalarField(lastTurn, "mode");
      const lastReferenceLabel = scalarField(lastTurn, "referenceLabel");
      const imitateLabel = lastMode === "shadow"
        ? (lastReferenceLabel || "the reference line")
        : "the native version";
      if (action === "reply" && lastFollowUpQuestion) {
        pendingReplyContext = {
          nativeVersion: lastNativeVersion,
          followUpQuestion: lastFollowUpQuestion,
          userTranscript: lastTranscript,
        };
        pendingPracticeTarget = null;
        vscode.postMessage({ type: "setReplyContext", priorTurn: pendingReplyContext });
      } else if (action === "imitate" && lastNativeVersion) {
        pendingReplyContext = null;
        pendingPracticeTarget = practiceTarget(
          lastNativeVersion,
          lastMode === "shadow" ? (lastReferenceLabel || "Reference") : "Native version",
          lastFollowUpQuestion,
        );
        vscode.postMessage({ type: "clearReplyContext" });
      } else {
        pendingReplyContext = null;
        pendingPracticeTarget = null;
        vscode.postMessage({ type: "clearReplyContext" });
      }
      cueRecording(action === "imitate" ? imitateLabel : "your reply to the follow-up");
    });
    document.addEventListener("click", (event) => {
      const actionTrigger = event.target.closest && event.target.closest("[data-action]");
      if (actionTrigger && datasetText(actionTrigger, "action") === "today-tts") {
        if (blockIfPracticeTurnInProgress("Finish or stop the current turn before generating example audio.")) return;
        if (blockIfTransientActionInProgress("generating example audio")) return;
        const status = $("todayTtsStatus");
        const blockMessage = todayTtsBlockMessage(state, currentExampleText);
        if (blockMessage) {
          if (status) status.textContent = blockMessage;
          setStatus(blockMessage, "error");
          return;
        }
        if (status) status.textContent = "Generating example…";
        const requestId = beginTodayTtsRequest(actionTrigger);
        if (!requestId) return;
        clearTodayGeneratedAudio();
        setStatus("Generating example audio…", "busy");
        vscode.postMessage({ type: "todayTts", requestId });
        armTodayTtsWatchdogs(requestId);
        return;
      }
      const geminiTrigger = event.target.closest && event.target.closest("#useGeminiOnly");
      if (geminiTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        postSetupAction({ type: "useGeminiOnly" }, "Switching to Gemini route", geminiTrigger);
        return;
      }
      const qwenStackTrigger = event.target.closest && event.target.closest("#useQwenStack");
      if (qwenStackTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        postSetupAction({ type: "useQwenStack" }, "Switching to Qwen stack", qwenStackTrigger);
        return;
      }
      const keyTrigger = event.target.closest && event.target.closest("[data-key]");
      if (keyTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        const provider = datasetText(keyTrigger, "key");
        if (!provider) return;
        postSetupAction({ type: "configureKey", provider }, "Configuring API key", keyTrigger);
        return;
      }
      const providerTrigger = event.target.closest && event.target.closest("[data-provider-setting]");
      if (providerTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        const setting = datasetText(providerTrigger, "providerSetting");
        const value = datasetText(providerTrigger, "providerValue");
        if (!setting || !value) return;
        postSetupAction({
          type: "setProvider",
          setting,
          value,
        }, "Switching provider", providerTrigger);
        return;
      }
      const configTrigger = event.target.closest && event.target.closest("[data-config-setting]");
      if (configTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        const setting = datasetText(configTrigger, "configSetting");
        if (!setting) return;
        postSetupAction({ type: "configureSetting", setting }, "Configuring setting", configTrigger);
        return;
      }
      const sidebarCommandTrigger = event.target.closest && event.target.closest("[data-sidebar-command]");
      if (sidebarCommandTrigger) {
        if (blockSetupChangeDuringPractice()) return;
        const command = datasetText(sidebarCommandTrigger, "sidebarCommand");
        if (!command) return;
        const label = command === "selectMicrophone" ? "Choosing microphone" : "Running action";
        postSidebarCommand(command, label, sidebarCommandTrigger);
        return;
      }
      const trigger = event.target.closest && event.target.closest("[data-onboard]");
      if (!trigger) return;
      const action = datasetText(trigger, "onboard");
      if (action === "source") {
        if (blockSetupChangeDuringPractice()) return;
        postSidebarCommand("configureMaterials", "Choosing materials folder", trigger);
      } else if (action === "provider-key") {
        if (blockSetupChangeDuringPractice()) return;
        postSidebarCommand("setupProviderKey", "Configuring provider keys", trigger);
      } else if (action === "create-sample") {
        if (blockSetupChangeDuringPractice()) return;
        postSidebarCommand("createSamplePackage", "Creating sample package", trigger);
      } else if (action === "generate-next") {
        if (blockSetupChangeDuringPractice()) return;
        postSidebarCommand("generateNextPackage", "Generating next package", trigger);
      } else if (action === "compose-material") {
        if (blockSetupChangeDuringPractice()) return;
        postSidebarCommand("composeMaterialPrompt", "Composing material prompt", trigger);
      } else if (action === "materials-guide") {
        if (blockIfPracticeTurnInProgress("Finish or stop the current turn before opening the materials guide.")) return;
        if (blockIfTransientActionInProgress("opening the materials guide")) return;
        postSidebarCommand("openMaterialsGuide", "Opening materials guide", trigger);
      }
    });
    addElementListener("completeLocal", "click", (event) => {
      if (blockIfPracticeTurnInProgress("Finish or stop the current turn before completing this lesson.")) return;
      if (blockIfTransientActionInProgress("completing this lesson")) return;
      const requestId = beginSidebarCommand(event.currentTarget || $("completeLocal"), "Completing lesson");
      if (!requestId) return;
      vscode.postMessage({ type: "completeLocal", requestId });
    });
    addElementListener("configureMaterials", "click", (event) => {
      if (blockSetupChangeDuringPractice()) return;
      postSidebarCommand("configureMaterials", "Choosing materials folder", event.currentTarget || $("configureMaterials"));
    });
    addElementListener("openTask", "click", (event) => {
      if (blockIfPracticeTurnInProgress("Finish or stop the current turn before opening the task card.")) return;
      if (blockIfTransientActionInProgress("opening the task card")) return;
      postSidebarCommand("openTask", "Opening task card", event.currentTarget || $("openTask"));
    });
    addElementListener("openFolder", "click", (event) => {
      if (blockIfPracticeTurnInProgress("Finish or stop the current turn before opening the session folder.")) return;
      if (blockIfTransientActionInProgress("opening the session folder")) return;
      postSidebarCommand("openSessionFolder", "Opening session folder", event.currentTarget || $("openFolder"));
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") {
        handleStateMessage(message.state);
      }
      if (message.type === "busy") setStatus(messageText(message.message, "Working…"), "busy");
      if (message.type === "commandResult") {
        const requestId = positiveInteger(message.requestId);
        if (requestId && !finishSidebarCommand(requestId)) return;
        if (!requestId) resetSidebarCommandBusyState();
        if (message.error) {
          setStatus("Action failed: " + messageErrorText(message.error, "Unknown action error"), "error");
        } else {
          setStatus(messageText(message.message, "Action finished."));
        }
      }
      if (message.type === "nativeRecordingPreparing") {
        if (!isCurrentNativeStartMessage(message)) return;
        // Live, moving feedback for the otherwise-opaque warm-up gap.
        const prepLabels = {
          reclaim: "Resetting the previous recorder…",
          mic: "Preparing microphone…",
          arming: "Starting recorder…",
        };
        if (nativeStarting) {
          setStatus(prepLabels[message.phase] || "Preparing microphone…", "busy");
        }
      }
      if (message.type === "nativeRecordingStarted") {
        if (!isCurrentNativeStartMessage(message)) return;
        clearNativeStartWatchdog();
        const wasAwaitingStart = nativeStarting && recorderMode === "native";
        nativeStarting = false;
        // If the 15s start watchdog already released the UI, a late
        // nativeRecordingStarted still means ffmpeg is now holding the mic.
        // Put the button back into stop mode so the user can finish/stop that
        // take instead of being left with a running recorder and no stop path.
        if (!wasAwaitingStart) {
          recorderMode = "native";
          setRecording(true);
          setBusy(false);
        }
        // Now actually capturing — start the elapsed timer here so it
        // reflects real recording time, not microphone warm-up.
        startTimer();
        setStatus(wasAwaitingStart
          ? "Listening… speak now."
          : "Recorder started after a delay — press stop when you finish this take.");
      }
      if (message.type === "stage") {
        if (!isCurrentStageMessage(message)) return;
        const name = stageName(message.stage);
        const status = stageStatus(message.status);
        if (message.show && name) {
          const isFreshPipelineStart = name === "transcribe" && status === "active";
          showStages(true, isFreshPipelineStart);
        }
        if (name) setStage(name, status);
        // Real pipeline progress: re-arm the no-progress watchdog so a long but
        // healthy multi-leg turn is never mistaken for a wedged one.
        if (name) armProcessingWatchdog();
      }
      if (message.type === "practiceResult") {
        const requestId = activeTurnMessageRequestId(message);
        if (message.requestId && !requestId) return;
        if (requestId) clearActiveTurnRequestId(requestId);
        clearProcessingWatchdog();
        nativeStarting = false;
        const r = normalizePracticeResult(message.result);
        if (!r) {
          recorderMode = null;
          setRecording(false);
          setBusy(false);
          clearPendingPracticeContexts(true);
          showStages(false);
          setStatus("Practice result was malformed. Try again.", "error");
          return;
        }
        markAllStagesDone();
        setBusy(false);
        setStatus("Ready ✓");
        recorderMode = null;
        clearPendingPracticeContexts(false);
        if (r.localAudioUri) {
          setLocalAudioSource(r.localAudioUri, false);
        }
        const nativeVersion = compactScalarText(r.nativeVersion);
        const followUpQuestion = compactScalarText(r.followUpQuestion);
        const transcript = compactScalarText(r.transcript);
        const mode = scalarField(r, "mode") || "free";
        const referenceLabel = scalarField(r, "referenceLabel");
        const quickFix = compactScalarText(r.quickFix);
        lastTurn = {
          nativeVersion,
          followUpQuestion,
          transcript,
          mode,
          referenceLabel,
        };
        const localAudio = $("localAudio");
        const localAudioFallback = r.localAudioUri || (localAudio ? localAudio.src : "");
        retainLocalAudioForTurnHistory(localAudioFallback);
        turnHistory.push({
          turnIndex: turnHistory.length + 1,
          transcript,
          nativeVersion,
          mode,
          referenceLabel,
          followUpQuestion,
          quickFix,
          userAudioUri: localAudioFallback,
          nativeAudioUri: r.audioUri || "",
          followUpAudioUri: r.followUpAudioUri || "",
          priorTurn: r.priorTurn || null,
          timestamp: Date.now(),
        });
        pruneTurnHistory();
        renderResult(r);
        renderTurnHistory();
        const resultPanel = $("result");
        if (resultPanel && typeof resultPanel.scrollIntoView === "function") {
          resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        // Land keyboard/screen-reader users on the fresh coaching result
        // instead of leaving focus on the (re-rendered) record button.
        if (resultPanel && typeof resultPanel.focus === "function") {
          resultPanel.focus({ preventScroll: true });
        }
        scheduleStageHide(1500);
      }
      if (message.type === "todayTtsStatus") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || activeTodayTtsRequest !== requestId) return;
        const statusText = messageText(message.message, "Generating example audio…");
        const status = $("todayTtsStatus");
        if (status) status.textContent = statusText;
        setStatus(statusText, "busy");
      }
      if (message.type === "slowReadStatus") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || !activeSlowReadRequest || activeSlowReadRequest.id !== requestId) return;
        setStatus(messageText(message.message, "Generating slow-read audio…"), "busy");
      }
      if (message.type === "slowReadStream") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || !activeSlowReadRequest || activeSlowReadRequest.id !== requestId) return;
        const phase = scalarText(message.phase);
        if (phase === "start") {
          if (!startTtsStream({
            sampleRate: positiveInteger(message.sampleRate) || 24000,
            channels: positiveInteger(message.channels) || 1,
          })) {
            setStatus("Slow-read streaming audio unavailable; will play once it finishes generating.", "busy");
          } else {
            setStatus("Slow-read audio playing…", "busy");
          }
        } else if (phase === "chunk") {
          feedTtsStreamChunk(scalarText(message.base64));
        } else if (phase === "done") {
          endTtsStream();
        } else if (phase === "error") {
          cancelTtsStream();
        }
        return;
      }
      if (message.type === "todayTtsStream") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || activeTodayTtsRequest !== requestId) return;
        const phase = scalarText(message.phase);
        if (phase === "start") {
          if (!startTtsStream({
            sampleRate: positiveInteger(message.sampleRate) || 24000,
            channels: positiveInteger(message.channels) || 1,
          })) {
            setStatus("Example audio streaming unavailable; will play once it finishes generating.", "busy");
          } else {
            setStatus("Example audio playing…", "busy");
          }
        } else if (phase === "chunk") {
          feedTtsStreamChunk(scalarText(message.base64));
        } else if (phase === "done") {
          endTtsStream();
        } else if (phase === "error") {
          cancelTtsStream();
        }
        return;
      }
      if (message.type === "practiceTtsStream") {
        // Stream of the pipeline's native-version audio: the user has just
        // finished recording and is waiting at "what did the coach say?"
        // — playing the chunks as they land cuts the perceived wait so the
        // shadowing main loop feels continuous instead of stop-and-go.
        const phase = scalarText(message.phase);
        if (phase === "start") {
          if (!startTtsStream({
            sampleRate: positiveInteger(message.sampleRate) || 24000,
            channels: positiveInteger(message.channels) || 1,
          })) {
            // AudioContext unavailable: fall back to the audio element the
            // turn result will render — no error message needed because the
            // turn still finishes normally.
          }
        } else if (phase === "chunk") {
          feedTtsStreamChunk(scalarText(message.base64));
        } else if (phase === "done") {
          endTtsStream();
        } else if (phase === "error") {
          cancelTtsStream();
        }
        return;
      }
      if (message.type === "slowReadResult") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId) return;
        const request = finishSlowReadRequest(requestId);
        if (!request) return;
        restoreSlowReadButtons();
        if (message.error) {
          // Clear the drill host too, or a later non-drill slow read would
          // append its player into this stale, now-irrelevant drill card.
          pendingSlowReadHost = null;
          setStatus("Slow read failed: " + messageErrorText(message.error, "Unknown slow-read error"), "error");
          return;
        }
        const result = objectValue(message.result);
        const audioDataUri = textField(result, "audioDataUri");
        if (audioDataUri) {
          let player = document.getElementById("slowReadAudio");
          if (!player) {
            player = document.createElement("audio");
            player.id = "slowReadAudio";
            player.controls = true;
            player.style.width = "100%";
            player.style.marginTop = "6px";
            document.body.appendChild(player);
          }
          const followUpCard = document.querySelector(".follow-up-card");
          const nativeSide = document.querySelector('.ab-side audio#nativeAudio');
          const requestHost = request && request.host && request.host.isConnected ? request.host : null;
          const host = message.target === "drill"
            ? (requestHost || $("drill") || document.body)
            : message.target === "followUp" && followUpCard
            ? followUpCard
            : (nativeSide ? nativeSide.parentNode : null);
          if (host && player.parentNode !== host) {
            host.appendChild(player);
          }
          player.src = audioDataUri;
          player.hidden = false;
          if (message.streamed) {
            setStatus("Slow-read audio ready — press play to repeat.");
          } else {
            setStatus("Slow-read audio ready.");
            playAudioOrPrompt(player, "Slow-read audio ready — press play.");
          }
          if (message.target === "drill") {
            pendingSlowReadHost = null;
          }
        } else {
          pendingSlowReadHost = null;
          setStatus("Slow read returned no audio. Try again.", "error");
        }
      }
      if (message.type === "todayTtsResult") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || !finishTodayTtsRequest(requestId)) return;
        restoreSlowReadButtons();
        const audio = $("todayAudio");
        const status = $("todayTtsStatus");
        const button = document.querySelector('[data-action="today-tts"]');
        if (button) {
          button.disabled = Boolean(todayTtsBlockMessage(state, currentExampleText));
          delete button.dataset.busy;
        }
        if (message.error) {
          const text = "Example audio failed: " + messageErrorText(message.error, "Unknown audio error");
          if (status) status.textContent = text;
          setStatus(text, "error");
          return;
        }
        const result = objectValue(message.result);
        const audioDataUri = textField(result, "audioDataUri");
        if (!audioDataUri) {
          const text = "Example audio returned no audio. Try again.";
          if (status) status.textContent = text;
          setStatus(text, "error");
          return;
        }
        if (audio) {
          audio.src = audioDataUri;
          audio.hidden = false;
          if (!message.streamed) {
            playAudioOrPrompt(audio, "Example audio ready — press play. Your next recording will shadow this text.");
          }
        }
        let armedShadow = false;
        const resultText = textField(result, "text");
        if (resultText) {
          pendingPracticeTarget = practiceTarget(resultText, "Example text", "");
          armedShadow = true;
        } else if (currentExampleText) {
          pendingPracticeTarget = practiceTarget(currentExampleText, "Example text", "");
          armedShadow = true;
        }
        if (status) {
          const provider = textField(result, "provider");
          status.textContent = provider
            ? "Example generated with " + provider + " · next recording shadows this text"
            : "Example generated";
        }
        // #todayTtsStatus lives inside #task and is wiped by the next
        // renderTodayHero, but the shadow target stays armed — so without a
        // cue on the persistent #status the user silently records in shadow
        // mode after any refresh. setStatus writes to #status, which no
        // re-render regenerates, so this survives until the next action.
        if (armedShadow) {
          setStatus("Example ready — your next recording will shadow it. Press the red button when you're ready.");
        }
      }
      if (message.type === "drillLinesStatus") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || activeDrillLineRequest !== requestId) return;
        const statusText = messageText(message.message, "Generating new drill lines…");
        const status = $("drillGenStatus");
        if (status) status.textContent = statusText;
        setStatus(statusText, "busy");
      }
      if (message.type === "drillLinesResult") {
        const requestId = positiveInteger(message.requestId);
        if (!requestId || !finishDrillLineRequest(requestId)) return;
        if (message.error) {
          const errorText = messageErrorText(message.error, "Drill generation failed.");
          const status = $("drillGenStatus");
          if (status) status.textContent = "Generation failed: " + errorText;
          const button = document.querySelector("[data-drill-generate]");
          if (button) button.disabled = false;
          setStatus("Drill generation failed: " + errorText, "error");
          return;
        }
        const incoming = Array.isArray(message.lines) ? message.lines : [];
        const known = new Set(drillLibrary.map((item) => normalizeComparable(item.text)));
        let added = 0;
        incoming.forEach((item) => {
          const obj = objectValue(item);
          const text = obj ? compactScalarField(obj, "text") : compactScalarText(item);
          const key = normalizeComparable(text);
          if (!text || !key || known.has(key)) return;
          known.add(key);
          added += 1;
          drillGeneratedLines.push({
            label: obj ? firstScalarField(obj, "label", "cue", "id") || "AI drill" : "AI drill",
            text,
            reason: obj ? firstScalarField(obj, "reason", "note") : "",
            source: "coach",
          });
        });
        renderDrillPanel();
        const status = $("drillGenStatus");
        if (status) {
          status.textContent = added
            ? "Added " + added + " new line" + (added === 1 ? "" : "s") + " · practice them above"
            : "No new lines this time — try again";
        }
        setStatus(added ? "Added " + added + " fresh FSI line" + (added === 1 ? "" : "s") : "No new drill lines generated");
      }
      if (message.type === "error") {
        if (!isCurrentTurnErrorMessage(message)) return;
        clearActiveTurnRequestId(activeTurnMessageRequestId(message));
        const errorText = messageErrorText(message.message, "Error.");
        clearProcessingWatchdog();
        clearNativeStartWatchdog();
        nativeStarting = false;
        // Reset the recorder regardless of mode: a webview recorder must be
        // torn down here too (hot mic + zombie recorder otherwise), and a
        // native one cleared. abortWebviewRecorder is a no-op when idle.
        abortWebviewRecorder();
        recorderMode = null;
        setRecording(false);
        stopVuMeter();
        stopTimer();
        setBusy(false);
        resetTransientActionBusyState(errorText);
        clearPendingPracticeContexts(true);
        showStages(false);
        if (!state && /prebuilt|EnglishSpeakingTraining root|Could not find/i.test(errorText)) {
          renderMissingSourceSetup(errorText);
        }
        setStatus(errorText, "error");
      }
    });

    vscode.postMessage({ type: "ready" });
