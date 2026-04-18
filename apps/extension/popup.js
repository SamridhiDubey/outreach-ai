const STORAGE_KEY_RESUME  = "outreach_resume_text";
const STORAGE_KEY_FNAME   = "outreach_resume_name";
const STORAGE_KEY_TONE    = "outreach_tone";
const STORAGE_KEY_USER_ID = "outreach_user_id";
const STORAGE_KEY_GEN_COUNT = "outreach_gen_count";
const PDF_SIZE_WARN_BYTES = 1_500_000; // warn if PDF > ~1.5 MB base64
const LI_DM_CHAR_LIMIT    = 300;       // LinkedIn DM soft limit shown in counter

// ── DOM refs ──────────────────────────────────────────────────────────────────

const resumeFile     = document.getElementById("resume-file");
const uploadArea     = document.getElementById("upload-area");
const uploadIcon     = document.getElementById("upload-icon");
const uploadLabel    = document.getElementById("upload-label");
const uploadHint     = document.getElementById("upload-hint");
const clearResumeBtn = document.getElementById("clear-resume-btn");
const resumeWarning  = document.getElementById("resume-warning");

const profileLoading = document.getElementById("profile-loading");
const notLinkedIn    = document.getElementById("not-linkedin");
const generateSection = document.getElementById("generate-section");

const profileAvatar  = document.getElementById("profile-avatar");
const profileName    = document.getElementById("profile-name");
const profileMeta    = document.getElementById("profile-meta");

const tonePills      = document.querySelectorAll(".tone-pill");

const generateBtn    = document.getElementById("generate-btn");
const btnLabel       = document.getElementById("btn-label");
const btnSpinner     = document.getElementById("btn-spinner");

const outputSection  = document.getElementById("output-section");
const messageOutput  = document.getElementById("message-output");
const charCount      = document.getElementById("char-count");
const insertBtn      = document.getElementById("insert-btn");
const insertLabel    = document.getElementById("insert-label");
const copyBtn        = document.getElementById("copy-btn");
const regenBtn       = document.getElementById("regen-btn");

const errorBanner    = document.getElementById("error-banner");
const errorMsg       = document.getElementById("error-msg");

// ── State ─────────────────────────────────────────────────────────────────────

let resumeText  = "";
let profileData = null;
let activeTone  = "friendly";
let userId      = null;
let genCount    = 0;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const [storedResume, storedName, storedTone, storedUserId, storedCount] = await Promise.all([
    chromeGet(STORAGE_KEY_RESUME),
    chromeGet(STORAGE_KEY_FNAME),
    chromeGet(STORAGE_KEY_TONE),
    chromeGet(STORAGE_KEY_USER_ID),
    chromeGet(STORAGE_KEY_GEN_COUNT),
  ]);

  // Ensure we always have a stable anonymous ID
  if (storedUserId) {
    userId = storedUserId;
  } else {
    userId = crypto.randomUUID();
    chromeSet(STORAGE_KEY_USER_ID, userId);
  }

  genCount = storedCount || 0;
  renderGenCount();

  if (storedResume) {
    resumeText = storedResume;
    markResumeUploaded(storedName || "Resume");
  }

  if (storedTone) setTone(storedTone);

  const tab = await getActiveTab();
  const isLinkedIn = tab?.url?.match(/linkedin\.com\/in\//);

  if (!isLinkedIn) {
    notLinkedIn.classList.remove("hidden");
    updateGenerateBtn();
    return;
  }

  // Show skeleton while we wait for profile data
  profileLoading.classList.remove("hidden");
  generateSection.classList.remove("hidden");

  profileData = await loadProfileData(tab.id);

  profileLoading.classList.add("hidden");

  if (profileData?.name) {
    renderProfileCard(profileData);
  } else {
    showError("Could not read profile data. Try scrolling the page then reopening this popup.");
  }

  updateGenerateBtn();
}

// ── Profile data loading ──────────────────────────────────────────────────────

async function loadProfileData(tabId) {
  try {
    return await sendTabMessage(tabId, { type: "GET_PROFILE_DATA" });
  } catch (err) {
    // Content script may not be injected (user opened profile before install)
    if (err.message?.includes("Cannot access") ||
        err.message?.includes("Receiving end does not exist")) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
        // Brief pause for script to register its listener
        await sleep(300);
        return await sendTabMessage(tabId, { type: "GET_PROFILE_DATA" });
      } catch {
        return null;
      }
    }
    return null;
  }
}

function renderProfileCard(data) {
  const initial = (data.name || "?")[0].toUpperCase();
  profileAvatar.textContent = initial;

  profileName.textContent = data.name || "Unknown";

  const metaParts = [data.title, data.company].filter(Boolean);
  profileMeta.textContent = metaParts.join(" · ");
  if (!metaParts.length) profileMeta.textContent = data.location || "";
}

// ── Resume upload ─────────────────────────────────────────────────────────────

uploadArea.addEventListener("click", () => resumeFile.click());

uploadArea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") resumeFile.click();
});

uploadArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadArea.classList.add("drag-over");
});

uploadArea.addEventListener("dragleave", () => {
  uploadArea.classList.remove("drag-over");
});

uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

resumeFile.addEventListener("change", () => {
  if (resumeFile.files[0]) processFile(resumeFile.files[0]);
  resumeFile.value = ""; // reset so same file can be re-uploaded
});

clearResumeBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  resumeText = "";
  await Promise.all([
    chromeRemove(STORAGE_KEY_RESUME),
    chromeRemove(STORAGE_KEY_FNAME),
  ]);
  markResumeCleared();
  updateGenerateBtn();
});

function processFile(file) {
  hideError();
  const ext = file.name.split(".").pop().toLowerCase();

  if (!["pdf", "txt"].includes(ext)) {
    showError("Only PDF and TXT files are supported.");
    return;
  }

  if (ext === "txt") {
    const reader = new FileReader();
    reader.onload = (e) => saveResume(e.target.result, file.name, file.size);
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = arrayBufferToBase64(e.target.result);
      saveResume(`__PDF_BASE64__${base64}`, file.name, file.size);
    };
    reader.readAsArrayBuffer(file);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Process in chunks to avoid stack overflow on large files
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function saveResume(text, filename, fileSize) {
  resumeText = text;
  await Promise.all([
    chromeSet(STORAGE_KEY_RESUME, text),
    chromeSet(STORAGE_KEY_FNAME, filename),
  ]);
  markResumeUploaded(filename);

  if (fileSize > PDF_SIZE_WARN_BYTES) {
    resumeWarning.textContent =
      "Large file — only the first portion may be sent to the API.";
    resumeWarning.classList.remove("hidden");
  } else {
    resumeWarning.classList.add("hidden");
  }

  updateGenerateBtn();
}

function markResumeUploaded(filename) {
  uploadIcon.textContent = "✅";
  uploadLabel.textContent = filename;
  uploadHint.textContent  = "Click to replace";
  uploadArea.classList.add("has-file");
  clearResumeBtn.classList.remove("hidden");
}

function markResumeCleared() {
  uploadIcon.textContent  = "📄";
  uploadLabel.textContent = "Upload Resume";
  uploadHint.textContent  = "PDF or TXT · stored locally";
  uploadArea.classList.remove("has-file");
  clearResumeBtn.classList.add("hidden");
  resumeWarning.classList.add("hidden");
}

// ── Tone selector ─────────────────────────────────────────────────────────────

tonePills.forEach((pill) => {
  pill.addEventListener("click", () => {
    setTone(pill.dataset.tone);
    chromeSet(STORAGE_KEY_TONE, activeTone);
  });
});

function setTone(tone) {
  activeTone = tone;
  tonePills.forEach((p) => p.classList.toggle("active", p.dataset.tone === tone));
}

// ── Generate ──────────────────────────────────────────────────────────────────

generateBtn.addEventListener("click", generate);
regenBtn.addEventListener("click", generate);

async function generate() {
  if (!resumeText || !profileData) return;

  setLoading(true);
  hideError();
  outputSection.classList.add("hidden");

  try {
    const result = await sendBackgroundMessage({
      type: "GENERATE_MESSAGE",
      payload: { profileData, resumeText, tone: activeTone, userId },
    });

    if (result?.error) throw new Error(result.error);
    if (!result?.message) throw new Error("Empty response from server.");

    messageOutput.value = result.message;
    outputSection.classList.remove("hidden");
    updateCharCount();
    messageOutput.focus();

    genCount++;
    chromeSet(STORAGE_KEY_GEN_COUNT, genCount);
    renderGenCount();
  } catch (err) {
    showError(friendlyError(err.message));
  } finally {
    setLoading(false);
  }
}

// ── Insert & Copy ─────────────────────────────────────────────────────────────

insertBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab) return;

  const result = await sendTabMessage(tab.id, {
    type: "INSERT_MESSAGE",
    text: messageOutput.value,
  }).catch(() => ({ success: false }));

  if (result?.success) {
    insertLabel.textContent = "Inserted ✓";
    insertBtn.style.background = "#0c1a14";
    setTimeout(() => {
      insertLabel.textContent = "Insert into Chat";
      insertBtn.style.background = "";
    }, 2500);
  } else {
    showError("Could not find the LinkedIn message box. Open a conversation first, then try again.");
  }
});

copyBtn.addEventListener("click", () => {
  if (!messageOutput.value) return;
  navigator.clipboard.writeText(messageOutput.value).then(() => {
    copyBtn.textContent = "✓";
    setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
  });
});

// ── Character counter ─────────────────────────────────────────────────────────

messageOutput.addEventListener("input", updateCharCount);

function updateCharCount() {
  const len = messageOutput.value.length;
  charCount.textContent = `${len} / ${LI_DM_CHAR_LIMIT}`;
  charCount.classList.toggle("over", len > LI_DM_CHAR_LIMIT);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderGenCount() {
  const el = document.getElementById("gen-count");
  if (el) el.textContent = genCount > 0 ? `${genCount} generated` : "";
}

function updateGenerateBtn() {
  generateBtn.disabled = !(resumeText && profileData);
}

function setLoading(on) {
  generateBtn.disabled = on;
  regenBtn.disabled    = on;
  btnLabel.textContent = on ? "Generating…" : "Generate Message";
  btnSpinner.classList.toggle("hidden", !on);
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
}

function friendlyError(msg = "") {
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError"))
    return "Could not reach the server. Check your internet connection.";
  if (msg.includes("401") || msg.includes("403"))
    return "API key error. Check your backend configuration.";
  if (msg.includes("429"))
    return "Rate limit hit. Wait a moment and try again.";
  if (msg.includes("500"))
    return "Server error. Try again in a few seconds.";
  return msg || "Something went wrong. Please try again.";
}

// ── Chrome API wrappers ───────────────────────────────────────────────────────

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs[0])
    )
  );
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else
        resolve(response);
    });
  });
}

function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError)
        reject(new Error(chrome.runtime.lastError.message));
      else
        resolve(response);
    });
  });
}

function chromeGet(key) {
  return new Promise((resolve) =>
    chrome.storage.local.get([key], (res) => resolve(res[key] ?? null))
  );
}

function chromeSet(key, value) {
  return new Promise((resolve) =>
    chrome.storage.local.set({ [key]: value }, resolve)
  );
}

function chromeRemove(key) {
  return new Promise((resolve) =>
    chrome.storage.local.remove(key, resolve)
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
