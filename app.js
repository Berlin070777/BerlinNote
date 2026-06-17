const $ = (selector) => document.querySelector(selector);

const state = {
  book: null,
  bookId: "",
  restoreProgress: null,
  progressSaveTimer: null,
  chapterIndex: 0,
  paragraphIndex: 0,
  sentenceIndex: 0,
  selectedText: "",
  selectedEl: null,
  selectedWordEl: null,
  longPressTimer: null,
  longPressTriggered: false,
  speakingEl: null,
  currentAudio: null,
  currentAudioUrl: "",
  playToken: 0,
  voices: [],
  systemVoices: [],
  queue: [],
  queueIndex: 0,
  isContinuous: false,
  prefetchToken: 0,
  prefetchCache: new Map(),
  prefetchInFlight: new Map(),
  prefetchWindowSize: 3,
  prefetchMaxConcurrency: 2
};

const els = {
  input: $("#bookInput"),
  shelf: $("#shelfView"),
  openSample: $("#openSample"),
  shelfBooks: $("#shelfBooks"),
  shell: $("#readerShell"),
  scrim: $("#scrim"),
  drawer: $("#drawer"),
  openDrawer: $("#openDrawer"),
  closeDrawer: $("#closeDrawer"),
  backToShelf: $("#backToShelf"),
  prevChapter: $("#prevChapter"),
  nextChapter: $("#nextChapter"),
  tocProgress: $("#tocProgress"),
  bookTitle: $("#bookTitle"),
  chapterList: $("#chapterList"),
  chapterKicker: $("#chapterKicker"),
  chapterTitle: $("#chapterTitle"),
  content: $("#chapterContent"),
  settingsPanel: $("#settingsPanel"),
  openSettings: $("#openSettings"),
  closeSettings: $("#closeSettings"),
  playBook: $("#playBook"),
  stopSpeech: $("#stopSpeech"),
  wordPanel: $("#wordPanel"),
  closeWord: $("#closeWord"),
  wordTitle: $("#wordTitle"),
  wordPhonetic: $("#wordPhonetic"),
  wordMeaning: $("#wordMeaning"),
  speakWord: $("#speakWord"),
  fontSize: $("#fontSizeControl"),
  lineHeight: $("#lineHeightControl"),
  rate: $("#rateControl"),
  voice: $("#voiceSelect"),
  coachNote: $("#coachNote"),
  toast: $("#toast")
};

const commonWords = new Set(
  "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us".split(" ")
);

const localDefinitions = {
  dawn: "n. 黎明；破晓。",
  persistent: "adj. 持续的，坚持不懈的。",
  awning: "n. 遮阳篷，雨篷。",
  narrow: "adj. 狭窄的；有限的。",
  beneath: "prep. 在……下面。",
  certain: "adj. 确信的；某种特定的。",
  shelves: "n. shelf 的复数，架子。",
  ceiling: "n. 天花板。",
  whispered: "v. 低声说；耳语。",
  accent: "n. 口音；重音。",
  question: "n. 问题；疑问。"
};

const audioCache = createAudioCache();
const libraryStore = createLibraryStore();

els.input.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    showToast("正在解析 EPUB...");
    const saved = await importBook(file);
    showToast(saved ? "导入完成，已保存到本机书架。" : "书已打开，但没有保存到本机书架。");
  } catch (error) {
    console.error(error);
    showToast(error.message || "EPUB 解析失败，请换一本标准 EPUB 试试。");
  }
});

els.openDrawer.addEventListener("click", openDrawer);
els.closeDrawer.addEventListener("click", closePanels);
els.openSettings.addEventListener("click", openSettings);
els.closeSettings.addEventListener("click", closePanels);
els.closeWord.addEventListener("click", closeWordPanel);
els.backToShelf.addEventListener("click", showShelf);
els.scrim.addEventListener("click", closePanels);
els.openSample.addEventListener("click", () => loadDemoBook("sample.epub"));
els.prevChapter.addEventListener("click", () => goChapter(state.chapterIndex - 1));
els.nextChapter.addEventListener("click", () => goChapter(state.chapterIndex + 1));
els.playBook.addEventListener("click", playBook);
els.stopSpeech.addEventListener("click", stopSpeech);
els.voice.addEventListener("change", () => updateCoachNote());
els.speakWord.addEventListener("click", () => speakWord(els.wordTitle.textContent));
els.fontSize.addEventListener("input", updateReaderStyle);
els.lineHeight.addEventListener("input", updateReaderStyle);
els.content.addEventListener("scroll", () => scheduleProgressSave());

function openDrawer() {
  els.drawer.classList.add("open");
  els.scrim.classList.remove("hidden");
}

function openSettings() {
  els.settingsPanel.classList.remove("collapsed");
  els.scrim.classList.remove("hidden");
}

function closePanels() {
  els.drawer.classList.remove("open");
  els.settingsPanel.classList.add("collapsed");
  els.wordPanel.classList.add("collapsed");
  els.scrim.classList.add("hidden");
  state.selectedWordEl?.classList.remove("selected-word");
  state.selectedWordEl = null;
}

function closeWordPanel() {
  els.wordPanel.classList.add("collapsed");
  els.scrim.classList.add("hidden");
  state.selectedWordEl?.classList.remove("selected-word");
  state.selectedWordEl = null;
}

function showShelf() {
  stopSpeech();
  closePanels();
  els.shell.classList.add("hidden");
  els.shelf.classList.remove("hidden");
  renderSavedBooks();
}

function showReader() {
  els.shelf.classList.add("hidden");
  els.shell.classList.remove("hidden");
}

function goChapter(index) {
  if (!state.book || index < 0 || index >= state.book.chapters.length) return;
  renderChapter(index, { preserveSpeech: false });
  closePanels();
}

function renderChapterList() {
  els.chapterList.replaceChildren();
  state.book.chapters.forEach((chapter, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === state.chapterIndex ? "active" : "";
    const number = document.createElement("span");
    number.textContent = String(index + 1);
    const title = document.createElement("span");
    title.textContent = chapter.title || `Chapter ${index + 1}`;
    button.append(number, title);
    button.addEventListener("click", () => {
      renderChapter(index, { preserveSpeech: false });
      closePanels();
    });
    els.chapterList.append(button);
  });
  els.tocProgress.textContent = `${state.chapterIndex + 1} / ${state.book.chapters.length}`;
  els.prevChapter.disabled = state.chapterIndex === 0;
  els.nextChapter.disabled = state.chapterIndex === state.book.chapters.length - 1;
}

function renderChapter(index, options = {}) {
  if (!options.preserveSpeech) stopSpeech();
  state.chapterIndex = index;
  state.paragraphIndex = 0;
  state.sentenceIndex = 0;
  state.selectedText = "";
  state.selectedEl = null;
  state.selectedWordEl = null;
  const chapter = state.book.chapters[index];
  els.chapterKicker.textContent = `Chapter ${index + 1} of ${state.book.chapters.length}`;
  els.chapterTitle.textContent = chapter.title || `Chapter ${index + 1}`;
  els.wordPanel.classList.add("collapsed");
  els.content.replaceChildren();

  chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
    const p = document.createElement("p");
    p.dataset.paragraphIndex = String(paragraphIndex);
    splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.paragraphIndex = String(paragraphIndex);
      span.dataset.sentenceIndex = String(sentenceIndex);
      appendSentenceTokens(span, sentence);
      span.addEventListener("click", () => selectSentence(span, sentence, true));
      p.append(span, " ");
    });
    const paragraphButton = document.createElement("button");
    paragraphButton.type = "button";
    paragraphButton.className = "paragraph-play";
    paragraphButton.setAttribute("aria-label", "朗读本段");
    paragraphButton.textContent = "▶";
    paragraphButton.addEventListener("click", (event) => {
      event.stopPropagation();
      playParagraph(paragraphIndex);
    });
    p.append(paragraphButton);
    els.content.append(p);
  });
  els.content.append(createChapterEndNav(index));

  renderChapterList();
  if (state.restoreProgress?.chapterIndex === index) {
    const progress = state.restoreProgress;
    state.restoreProgress = null;
    requestAnimationFrame(() => {
      if (typeof progress.scrollTop === "number") els.content.scrollTop = progress.scrollTop;
      const selector = `.sentence[data-paragraph-index="${progress.paragraphIndex || 0}"][data-sentence-index="${progress.sentenceIndex || 0}"]`;
      const savedEl = els.content.querySelector(selector);
      if (savedEl) selectSentence(savedEl, savedEl.textContent.trim(), false);
    });
  } else {
    scheduleProgressSave();
  }
}

function createChapterEndNav(index) {
  const nav = document.createElement("nav");
  nav.className = "chapter-end-nav";
  nav.setAttribute("aria-label", "章节切换");

  const prev = document.createElement("button");
  prev.type = "button";
  prev.textContent = "上一章";
  prev.disabled = index === 0;
  prev.addEventListener("click", () => goChapter(index - 1));

  const next = document.createElement("button");
  next.type = "button";
  next.className = "primary-next";
  next.textContent = index === state.book.chapters.length - 1 ? "已到最后一章" : "下一章";
  next.disabled = index === state.book.chapters.length - 1;
  next.addEventListener("click", () => goChapter(index + 1));

  nav.append(prev, next);
  return nav;
}

function selectSentence(el, text, autoplay = false) {
  if (state.selectedEl) state.selectedEl.classList.remove("selected");
  els.content.querySelector(".active-paragraph")?.classList.remove("active-paragraph");
  state.selectedEl = el;
  state.selectedText = text.trim();
  state.paragraphIndex = Number(el.dataset.paragraphIndex || 0);
  state.sentenceIndex = Number(el.dataset.sentenceIndex || 0);
  el.classList.add("selected");
  el.closest("p")?.classList.add("active-paragraph");
  updateCoachNote();
  scheduleProgressSave();
  if (autoplay) speakSelected();
}

function updateCoachNote() {
  const option = els.voice.selectedOptions?.[0];
  const label = option?.textContent || els.voice.value;
  els.coachNote.textContent = `当前音色：${label}。同一句文本、同一音色和语速会优先使用缓存音频。`;
}

function speakSelected() {
  if (!state.selectedText) return;
  speakText(state.selectedText, state.selectedEl);
}

function playParagraph(paragraphIndex) {
  const sentenceEls = [...els.content.querySelectorAll(`p[data-paragraph-index="${paragraphIndex}"] .sentence`)];
  playQueue(sentenceEls);
}

function playChapter() {
  playQueue([...els.content.querySelectorAll(".sentence")]);
}

function playBook() {
  if (!state.book) return;
  const items = [];
  state.book.chapters.forEach((chapter, chapterIndex) => {
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      splitSentences(paragraph).forEach((sentence, sentenceIndex) => {
        items.push({ chapterIndex, paragraphIndex, sentenceIndex, text: sentence.trim() });
      });
    });
  });
  if (!items.length) return;
  stopSpeech();
  state.queue = items;
  state.queueIndex = findCurrentBookQueueIndex(items);
  state.isContinuous = true;
  state.prefetchToken += 1;
  prefetchAroundQueue(state.queueIndex + 1);
  speakNextBookItem();
}

function findCurrentBookQueueIndex(items) {
  return Math.max(
    0,
    items.findIndex(
      (item) =>
        item.chapterIndex === state.chapterIndex &&
        item.paragraphIndex === state.paragraphIndex &&
        item.sentenceIndex === state.sentenceIndex
    )
  );
}

function playQueue(sentenceEls) {
  if (!sentenceEls.length) return;
  stopSpeech();
  state.queue = sentenceEls.map((el) => ({ el, text: el.textContent.trim() }));
  state.queueIndex = 0;
  state.isContinuous = true;
  state.prefetchToken += 1;
  prefetchAroundQueue(state.queueIndex + 1);
  speakNextInQueue();
}

function speakNextInQueue() {
  const item = state.queue[state.queueIndex];
  if (!item) {
    state.isContinuous = false;
    clearSpeaking();
    return;
  }
  prefetchAroundQueue(state.queueIndex + 1);
  selectSentence(item.el, item.text, false);
  speakText(item.text, item.el, () => {
    state.queueIndex += 1;
    speakNextInQueue();
  });
}

function speakNextBookItem() {
  const item = state.queue[state.queueIndex];
  if (!item) {
    state.isContinuous = false;
    clearSpeaking();
    return;
  }
  if (item.chapterIndex !== state.chapterIndex) renderChapter(item.chapterIndex, { preserveSpeech: true });
  const el = els.content.querySelector(
    `.sentence[data-paragraph-index="${item.paragraphIndex}"][data-sentence-index="${item.sentenceIndex}"]`
  );
  if (!el) {
    state.queueIndex += 1;
    speakNextBookItem();
    return;
  }
  prefetchAroundQueue(state.queueIndex + 1);
  selectSentence(el, item.text, false);
  speakText(item.text, el, () => {
    state.queueIndex += 1;
    speakNextBookItem();
  });
}

async function speakText(text, el, onEnd) {
  if (!text) return;
  const playToken = ++state.playToken;
  if (!state.isContinuous) {
    stopPlaybackOnly();
  }
  markSpeaking(el);
  try {
    const blob = await getPrefetchedAudio(text) || await getCachedAiAudio(text);
    if (playToken !== state.playToken) return;
    await playAudioBlob(blob, el, onEnd, playToken);
  } catch (error) {
    if (playToken !== state.playToken) return;
    if (!navigator.onLine) showToast("离线且没有这句缓存，改用系统语音。");
    else if (/not configured/i.test(error.message)) showToast("未配置 AI TTS，暂用系统语音。");
    else showToast("AI 音频不可用，暂用系统语音。");
    speakWithSystemVoice(text, el, onEnd, playToken);
  }
}

async function getPrefetchedAudio(text) {
  const request = buildAudioRequest(text);
  const key = await audioCacheKey(request);
  const blob = state.prefetchCache.get(key);
  if (blob) {
    state.prefetchCache.delete(key);
    console.info("BerlinNote audio prefetch hit", key);
    return blob;
  }
  const pending = state.prefetchInFlight.get(key);
  if (!pending) return null;
  try {
    const pendingBlob = await pending;
    if (state.prefetchCache.get(key) === pendingBlob) state.prefetchCache.delete(key);
    console.info("BerlinNote audio prefetch awaited", key);
    return pendingBlob;
  } catch {
    return null;
  }
}

function prefetchAroundQueue(startIndex) {
  if (!state.isContinuous || !state.queue.length) return;
  const token = state.prefetchToken;
  const candidates = [];
  for (let index = startIndex; index < state.queue.length && candidates.length < state.prefetchWindowSize; index += 1) {
    const text = state.queue[index]?.text?.trim();
    if (text) candidates.push(text);
  }
  candidates.forEach((text) => prefetchAudioForText(text, token));
}

async function prefetchAudioForText(text, token) {
  if (!navigator.onLine || token !== state.prefetchToken) return;
  const request = buildAudioRequest(text);
  const key = await audioCacheKey(request);
  if (token !== state.prefetchToken || state.prefetchCache.has(key) || state.prefetchInFlight.has(key)) return;
  if (state.prefetchInFlight.size >= state.prefetchMaxConcurrency) return;

  const pending = getCachedAiAudio(text);
  state.prefetchInFlight.set(key, pending);
  try {
    const blob = await pending;
    if (token === state.prefetchToken && state.isContinuous) {
      state.prefetchCache.set(key, blob);
      trimPrefetchCache();
    }
  } catch (error) {
    console.warn("Audio prefetch failed", error);
  } finally {
    state.prefetchInFlight.delete(key);
    if (token === state.prefetchToken && state.isContinuous) {
      prefetchAroundQueue(state.queueIndex + 1);
    }
  }
}

function clearPrefetch() {
  state.prefetchToken += 1;
  state.prefetchCache.clear();
  state.prefetchInFlight.clear();
}

function trimPrefetchCache() {
  const maxItems = Math.max(state.prefetchWindowSize * 2, 6);
  while (state.prefetchCache.size > maxItems) {
    const oldestKey = state.prefetchCache.keys().next().value;
    state.prefetchCache.delete(oldestKey);
  }
}

async function getCachedAiAudio(text) {
  const request = buildAudioRequest(text);
  const key = await audioCacheKey(request);
  const cached = await withTimeout(audioCache.get(key), 500, "Audio IndexedDB read timeout").catch((error) => {
    console.warn("Audio cache read skipped", error);
    return null;
  });
  if (cached) {
    console.info("BerlinNote audio cache hit", key);
    return cached;
  }
  if (!navigator.onLine) throw new Error("Offline and no cached audio");

  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message);
  }
  const blob = await response.blob();
  await withTimeout(audioCache.set(key, blob, request), 700, "Audio IndexedDB write timeout").catch((error) => {
    console.warn("Audio cache write skipped", error);
  });
  console.info("BerlinNote audio fetched", response.headers.get("X-Audio-Cache") || "network", key);
  return blob;
}

function buildAudioRequest(text) {
  return {
    text: text.replace(/\s+/g, " ").trim(),
    voice: els.voice.value || "zh_female_vv_uranus_bigtts",
    rate: Number(els.rate.value || 0.9).toFixed(2)
  };
}

function playAudioBlob(blob, el, onEnd, playToken) {
  return new Promise((resolvePlay, rejectPlay) => {
    stopPlaybackOnly();
    markSpeaking(el);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.currentAudio = audio;
    state.currentAudioUrl = url;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (state.currentAudio === audio) {
        state.currentAudio = null;
        state.currentAudioUrl = "";
      }
      clearSpeaking();
      if (playToken === state.playToken) onEnd?.();
      resolvePlay();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (state.currentAudio === audio) {
        state.currentAudio = null;
        state.currentAudioUrl = "";
      }
      clearSpeaking();
      rejectPlay(new Error("Audio playback failed"));
    };
    audio.play().catch(rejectPlay);
  });
}

function speakWithSystemVoice(text, el, onEnd, playToken) {
  stopPlaybackOnly();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = state.systemVoices[0];
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang || "en-US";
  utterance.rate = Number(els.rate.value);
  utterance.pitch = 1;
  utterance.onstart = () => {
    markSpeaking(el);
  };
  utterance.onend = () => {
    clearSpeaking();
    if (playToken === state.playToken) onEnd?.();
  };
  utterance.onerror = () => {
    clearSpeaking();
    state.isContinuous = false;
  };
  speechSynthesis.speak(utterance);
}

function stopSpeech() {
  state.isContinuous = false;
  state.queue = [];
  state.queueIndex = 0;
  state.playToken += 1;
  clearPrefetch();
  stopPlaybackOnly();
}

function stopPlaybackOnly() {
  speechSynthesis.cancel();
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio.currentTime = 0;
  }
  if (state.currentAudioUrl) URL.revokeObjectURL(state.currentAudioUrl);
  state.currentAudio = null;
  state.currentAudioUrl = "";
  clearSpeaking();
}

function markSpeaking(el) {
  clearSpeaking();
  state.speakingEl = el;
  state.speakingEl?.classList.add("speaking");
  state.speakingEl?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function clearSpeaking() {
  state.speakingEl?.classList.remove("speaking");
  state.speakingEl = null;
}

function appendSentenceTokens(container, sentence) {
  const tokens = sentence.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*|[^A-Za-z]+/g) || [sentence];
  tokens.forEach((token) => {
    if (/^[A-Za-z]/.test(token)) {
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = token;
      word.addEventListener("click", (event) => {
        event.stopPropagation();
        if (state.longPressTriggered) {
          state.longPressTriggered = false;
          return;
        }
        selectSentence(container, container.textContent.trim(), true);
      });
      word.addEventListener("pointerdown", () => startLongPress(word, token, container));
      word.addEventListener("pointerup", cancelLongPress);
      word.addEventListener("pointerleave", cancelLongPress);
      word.addEventListener("pointercancel", cancelLongPress);
      container.append(word);
    } else {
      container.append(document.createTextNode(token));
    }
  });
}

function startLongPress(wordEl, token, sentenceEl) {
  cancelLongPress();
  state.longPressTriggered = false;
  state.longPressTimer = window.setTimeout(() => {
    state.longPressTriggered = true;
    selectSentence(sentenceEl, sentenceEl.textContent.trim(), false);
    lookupWord(wordEl, token);
  }, 520);
}

function cancelLongPress() {
  window.clearTimeout(state.longPressTimer);
  state.longPressTimer = null;
}

async function lookupWord(el, rawWord) {
  const word = normalizeWord(rawWord);
  if (!word) return;
  stopSpeech();
  if (state.selectedWordEl) state.selectedWordEl.classList.remove("selected-word");
  state.selectedWordEl = el;
  el.classList.add("selected-word");
  els.wordPanel.classList.remove("collapsed");
  els.settingsPanel.classList.add("collapsed");
  els.scrim.classList.remove("hidden");
  els.wordTitle.textContent = word;
  els.wordPhonetic.textContent = "正在查询...";
  els.wordMeaning.textContent = localDefinitions[word] || "正在加载在线词典释义。";

  try {
    const data = await fetchDictionary(word);
    renderDictionaryEntry(word, data);
  } catch (error) {
    els.wordPhonetic.textContent = "";
    els.wordMeaning.textContent = localDefinitions[word] || "暂时没有查到释义。后续可以接入自己的词库或 AI 解释。";
  }
}

async function fetchDictionary(word) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Dictionary lookup failed");
    return response.json();
  } finally {
    window.clearTimeout(timer);
  }
}

function renderDictionaryEntry(word, data) {
  const entry = data?.[0];
  const phonetic = entry?.phonetic || entry?.phonetics?.find((item) => item.text)?.text || "";
  const meanings = entry?.meanings
    ?.slice(0, 3)
    .map((meaning) => {
      const definition = meaning.definitions?.[0]?.definition;
      if (!definition) return "";
      return `<p><strong>${escapeHtml(meaning.partOfSpeech || "word")}.</strong> ${escapeHtml(definition)}</p>`;
    })
    .filter(Boolean)
    .join("");
  els.wordPhonetic.textContent = phonetic;
  els.wordMeaning.innerHTML = meanings || `<p>${escapeHtml(localDefinitions[word] || "没有找到详细释义。")}</p>`;
}

function speakWord(word) {
  const normalized = normalizeWord(word);
  if (!normalized) return;
  state.isContinuous = false;
  speakText(normalized, state.selectedWordEl);
}

function updateReaderStyle() {
  els.content.style.setProperty("--reader-font-size", `${Number(els.fontSize.value)}rem`);
  els.content.style.setProperty("--reader-line-height", String(Number(els.lineHeight.value)));
}

function normalizeWord(word) {
  return word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadVoices() {
  state.systemVoices = speechSynthesis
    .getVoices()
    .filter((voice) => /^en/i.test(voice.lang))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  els.voice.replaceChildren();
  [
    ["zh_female_vv_uranus_bigtts", "豆包 2.0 · VV 女声"]
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    els.voice.append(option);
  });
}

speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
loadVoices();
updateCoachNote();
updateReaderStyle();
registerServiceWorker();
renderSavedBooks();
loadFolderBookFromUrl();
loadDemoBookFromUrl();

async function importBook(file) {
  showToast("正在交给本地服务解析 EPUB...");
  try {
    const result = await uploadEpubToServer(file);
    const id = `folder-${result.book.id}`;
    await loadBook(null, result.book.title || file.name.replace(/\.epub$/i, ""), {
      id,
      parsedBook: result.parsedBook,
      restore: false
    });
    await renderSavedBooks();
    return true;
  } catch (error) {
    console.warn("Server EPUB import failed, falling back to browser parser", error);
  }

  const buffer = await file.arrayBuffer();
  showToast("本地服务解析失败，改用浏览器解析...");
  const book = await parseEpub(buffer);
  const id = `book-${hashString(`${file.name}:${file.size}:${book.title}:${book.chapters.length}`)}`;
  showToast("正在打开阅读界面...");
  await loadBook(buffer, book.title || file.name.replace(/\.epub$/i, ""), { id, parsedBook: book, restore: true });
  return false;
}

async function uploadEpubToServer(file) {
  const response = await fetch(`/api/books/import?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/epub+zip"
    },
    body: file
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "服务端 EPUB 导入失败。");
  }
  if (!data.parsedBook?.chapters?.length) throw new Error("服务端没有解析出章节。");
  return data;
}

async function renderSavedBooks() {
  if (!els.shelfBooks) return;
  els.shelfBooks.replaceChildren(statusLine("正在读取 books 文件夹..."));
  try {
    const [books, folderBooks] = await Promise.all([
      withTimeout(libraryStore.listBooks(), 1800, "IndexedDB 读取超时").catch((error) => {
        console.warn("IndexedDB book list failed", error);
        return [];
      }),
      withTimeout(fetchFolderBooks(), 2500, "books 文件夹接口超时").catch((error) => {
        console.warn("Folder book list failed", error);
        return [];
      })
    ]);
    els.shelfBooks.replaceChildren();
    if (!books.length && !folderBooks.length) {
      els.shelfBooks.append(statusLine("还没有书籍。可以导入 EPUB，或者把 EPUB 放进 books 文件夹。"));
      return;
    }
    folderBooks.forEach((book) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved-book";
      const title = document.createElement("strong");
      title.textContent = book.title || book.fileName || "Untitled";
      const meta = document.createElement("span");
      meta.textContent = `本地 books 文件夹 · ${formatFileSize(book.size)}`;
      button.append(title, meta);
      button.addEventListener("click", () => openFolderBook(book));
      els.shelfBooks.append(button);
    });
    books.forEach((book) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "saved-book";
      const title = document.createElement("strong");
      title.textContent = book.title || book.fileName || "Untitled";
      const meta = document.createElement("span");
      const progress = book.progress?.chapterIndex != null ? `上次读到第 ${book.progress.chapterIndex + 1} 章` : `${book.chapterCount || 0} 章`;
      meta.textContent = `${progress} · ${formatDate(book.updatedAt || book.createdAt)}`;
      button.append(title, meta);
      button.addEventListener("click", () => openSavedBook(book.id));
      els.shelfBooks.append(button);
    });
  } catch (error) {
    console.error("Book shelf render failed", error);
    els.shelfBooks.replaceChildren(statusLine(`书架读取失败：${error.message || error}`));
  }
}

function statusLine(text) {
  const line = document.createElement("div");
  line.className = "empty-bookshelf";
  line.textContent = text;
  return line;
}

async function fetchFolderBooks() {
  try {
    const response = await fetch("/api/books", { cache: "no-store" });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data.books) ? data.books : [];
  } catch {
    return [];
  }
}

async function openFolderBook(book) {
  showToast("正在打开本地书库 EPUB...");
  const response = await fetch(`/api/books/${encodeURIComponent(book.id)}/parsed`, { cache: "no-store" });
  if (!response.ok) {
    showToast("本地书库文件打开失败。");
    return;
  }
  const data = await response.json();
  await loadBook(null, book.title || book.fileName || "Untitled", {
    id: `folder-${book.id}`,
    parsedBook: data.parsedBook,
    restore: false
  });
  showToast("本地书库 EPUB 已打开。");
}

async function loadFolderBookFromUrl() {
  const params = new URLSearchParams(location.search);
  const id = params.get("folderBook");
  if (!id) return;
  showToast("正在打开本地书库 EPUB...");
  const response = await fetch(`/api/books/${encodeURIComponent(id)}/parsed`, { cache: "no-store" });
  if (!response.ok) {
    showToast("本地书库文件打开失败。");
    return;
  }
  const data = await response.json();
  await loadBook(null, "Local Book", {
    id: `folder-${id}`,
    parsedBook: data.parsedBook,
    restore: false
  });
}

async function openSavedBook(id) {
  const record = await libraryStore.getBook(id);
  if (!record?.blob) {
    showToast("没有找到这本书的本地文件。");
    return;
  }
  const buffer = await record.blob.arrayBuffer();
  await loadBook(buffer, record.title || record.fileName || "Untitled", { id, restore: true });
}

function scheduleProgressSave() {
  window.clearTimeout(state.progressSaveTimer);
  state.progressSaveTimer = window.setTimeout(saveCurrentProgress, 350);
}

async function saveCurrentProgress() {
  if (!state.bookId) return;
  await libraryStore.saveProgress(state.bookId, {
    chapterIndex: state.chapterIndex,
    paragraphIndex: state.paragraphIndex,
    sentenceIndex: state.sentenceIndex,
    scrollTop: els.content.scrollTop,
    updatedAt: Date.now()
  });
}

function formatDate(value) {
  if (!value) return "刚刚";
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatFileSize(value) {
  if (!Number.isFinite(value)) return "EPUB";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function createAudioCache() {
  const dbPromise = openBerlinNoteDb();

  return {
    async get(key) {
      try {
        const db = await dbPromise;
        const record = await idbRequest(db.transaction("audio", "readonly").objectStore("audio").get(key));
        return record?.blob || null;
      } catch {
        return null;
      }
    },
    async set(key, blob, meta) {
      try {
        const db = await dbPromise;
        await idbRequest(
          db.transaction("audio", "readwrite").objectStore("audio").put({
            key,
            blob,
            meta,
            createdAt: Date.now()
          })
        );
      } catch (error) {
        console.warn("Audio cache write failed", error);
      }
    }
  };
}

function createLibraryStore() {
  const dbPromise = openBerlinNoteDb();
  return {
    async saveBook(book) {
      const db = await dbPromise;
      const existing = await idbRequest(db.transaction("books", "readonly").objectStore("books").get(book.id));
      await idbRequest(
        db.transaction("books", "readwrite").objectStore("books").put({
          ...existing,
          ...book,
          progress: existing?.progress || book.progress || null,
          updatedAt: Date.now()
        })
      );
    },
    async listBooks() {
      const db = await dbPromise;
      const books = await idbRequest(db.transaction("books", "readonly").objectStore("books").getAll());
      return books.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async getBook(id) {
      const db = await dbPromise;
      return idbRequest(db.transaction("books", "readonly").objectStore("books").get(id));
    },
    async saveProgress(id, progress) {
      const db = await dbPromise;
      const record = await idbRequest(db.transaction("books", "readonly").objectStore("books").get(id));
      if (!record) return;
      record.progress = progress;
      record.updatedAt = progress.updatedAt || Date.now();
      await idbRequest(db.transaction("books", "readwrite").objectStore("books").put(record));
    }
  };
}

function openBerlinNoteDb() {
  return new Promise((resolveDb, rejectDb) => {
    if (!("indexedDB" in window)) {
      rejectDb(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open("berlinnote-offline", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("audio")) {
        const store = db.createObjectStore("audio", { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains("books")) {
        const books = db.createObjectStore("books", { keyPath: "id" });
        books.createIndex("updatedAt", "updatedAt");
      }
    };
    request.onsuccess = () => resolveDb(request.result);
    request.onerror = () => rejectDb(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolveRequest, rejectRequest) => {
    request.onsuccess = () => resolveRequest(request.result);
    request.onerror = () => rejectRequest(request.error);
  });
}

async function audioCacheKey(value) {
  return hashString(JSON.stringify(value));
}

function hashString(value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.getRegistrations?.().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });
}

async function loadBook(buffer, fallbackTitle = "Untitled", options = {}) {
  const book = options.parsedBook || await parseEpub(buffer);
  state.book = book;
  state.bookId = options.id || "";
  state.chapterIndex = 0;
  state.restoreProgress = null;
  showReader();
  els.bookTitle.textContent = book.title || fallbackTitle;
  renderChapterList();
  let startChapter = 0;
  if (options.restore && state.bookId) {
    const record = await libraryStore.getBook(state.bookId);
    if (record?.progress) {
      state.restoreProgress = record.progress;
      startChapter = Math.min(record.progress.chapterIndex || 0, book.chapters.length - 1);
    }
  }
  renderChapter(startChapter);
}

async function loadDemoBookFromUrl() {
  const params = new URLSearchParams(location.search);
  const demoPath = params.get("demo");
  if (!demoPath) return;
  await loadDemoBook(demoPath);
}

async function loadDemoBook(demoPath) {
  try {
    showToast("正在载入样书...");
    const response = await fetch(demoPath);
    if (!response.ok) throw new Error("样书加载失败。");
    await loadBook(await response.arrayBuffer(), "Sample Book");
    showToast("样书已载入，可以点击句子试听。");
  } catch (error) {
    console.error(error);
    showToast(error.message || "样书加载失败。");
  }
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .match(/[^.!?。！？]+[.!?。！？"”’']*|[^.!?。！？]+$/g)
    ?.map((s) => s.trim())
    .filter((s) => s.length > 1) || [];
}

function getHardWords(sentence) {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z'\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length > 6 && !commonWords.has(word));
  return [...new Set(words)].slice(0, 4);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

async function parseEpub(buffer) {
  const zip = await ZipArchive.from(buffer);
  const container = await zip.text("META-INF/container.xml");
  const containerDoc = xml(container);
  const rootfile = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("没有找到 EPUB rootfile。");

  const opfText = await zip.text(rootfile);
  const opfDoc = xml(opfText);
  const base = dirname(rootfile);
  const title = textContent(opfDoc, "title") || textContent(opfDoc, "dc\\:title") || "Untitled";
  const manifest = new Map();
  opfDoc.querySelectorAll("manifest item").forEach((item) => {
    manifest.set(item.getAttribute("id"), {
      href: resolvePath(base, item.getAttribute("href") || ""),
      type: item.getAttribute("media-type") || ""
    });
  });

  const spineItems = [...opfDoc.querySelectorAll("spine itemref")]
    .map((item) => manifest.get(item.getAttribute("idref")))
    .filter(Boolean)
    .filter((item) => /xhtml|html/i.test(item.type) || /\.x?html?$/i.test(item.href));

  if (!spineItems.length) throw new Error("没有找到可阅读章节。");

  const chapters = [];
  for (const item of spineItems) {
    const html = await zip.text(item.href);
    const chapterDoc = new DOMParser().parseFromString(html, "text/html");
    const heading = chapterDoc.querySelector("h1,h2,h3,title")?.textContent?.trim();
    const blocks = [...chapterDoc.body.querySelectorAll("p,blockquote,li")]
      .map((node) => node.textContent.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 20);
    if (blocks.length) {
      chapters.push({
        title: heading || cleanChapterName(item.href),
        paragraphs: blocks
      });
    }
  }

  if (!chapters.length) throw new Error("章节里没有解析到正文。");
  return { title: title.trim(), chapters };
}

function xml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const error = doc.querySelector("parsererror");
  if (error) throw new Error("EPUB XML 解析失败。");
  return doc;
}

function textContent(doc, selector) {
  return doc.querySelector(selector)?.textContent?.trim();
}

function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function resolvePath(base, href) {
  const stack = (base + href).split("/");
  const out = [];
  for (const part of stack) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function cleanChapterName(path) {
  return path.split("/").pop().replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

class ZipArchive {
  constructor(buffer, entries) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.entries = entries;
  }

  static async from(buffer) {
    const view = new DataView(buffer);
    const eocdOffset = findEndOfCentralDirectory(view);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    let offset = view.getUint32(eocdOffset + 16, true);
    const entries = new Map();

    for (let i = 0; i < entryCount; i += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("ZIP 中央目录损坏。");
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decodeBytes(buffer.slice(offset + 46, offset + 46 + nameLength));
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    return new ZipArchive(buffer, entries);
  }

  async text(path) {
    const data = await this.bytes(path);
    return new TextDecoder("utf-8").decode(data);
  }

  async bytes(path) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`EPUB 缺少文件：${path}`);
    const local = entry.localOffset;
    if (this.view.getUint32(local, true) !== 0x04034b50) throw new Error("ZIP 本地文件头损坏。");
    const nameLength = this.view.getUint16(local + 26, true);
    const extraLength = this.view.getUint16(local + 28, true);
    const dataStart = local + 30 + nameLength + extraLength;
    const compressed = this.buffer.slice(dataStart, dataStart + entry.compressedSize);

    if (entry.method === 0) return new Uint8Array(compressed);
    if (entry.method === 8) return inflateRaw(compressed, entry.uncompressedSize);
    throw new Error(`暂不支持这个 EPUB 的 ZIP 压缩方式：${entry.method}`);
  }
}

function findEndOfCentralDirectory(view) {
  const min = Math.max(0, view.byteLength - 0xffff - 22);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("这不是有效的 EPUB/ZIP 文件。");
}

async function inflateRaw(buffer, expectedSize) {
  if (!("DecompressionStream" in window)) {
    throw new Error("当前浏览器不支持解压 EPUB。请用最新版 Safari/Chrome 试试。");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const decompressed = await withTimeout(new Response(stream).arrayBuffer(), 12000, "EPUB 解压超时。请换一本书，或把 EPUB 放进 books 文件夹后刷新书架。");
  const bytes = new Uint8Array(decompressed);
  if (expectedSize && bytes.byteLength !== expectedSize) return bytes;
  return bytes;
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function decodeBytes(buffer) {
  return new TextDecoder("utf-8").decode(buffer);
}
