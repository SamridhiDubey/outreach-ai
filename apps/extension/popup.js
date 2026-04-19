// ── Storage keys ──────────────────────────────────────────────────────────────

const STORAGE_KEY_RESUME    = "outreach_resume_text";
const STORAGE_KEY_FNAME     = "outreach_resume_name";
const STORAGE_KEY_TONE      = "outreach_tone";
const STORAGE_KEY_USER_ID   = "outreach_user_id";
const STORAGE_KEY_GEN_COUNT = "outreach_gen_count";
const STORAGE_KEY_ROLE      = "outreach_role";
const STORAGE_KEY_PURPOSE   = "outreach_purpose";

const PDF_SIZE_WARN_BYTES = 1_500_000;
const LI_DM_CHAR_LIMIT    = 300;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const resumeFile     = document.getElementById("resume-file");
const uploadArea     = document.getElementById("upload-area");
const uploadIcon     = document.getElementById("upload-icon");
const uploadLabel    = document.getElementById("upload-label");
const uploadHint     = document.getElementById("upload-hint");
const clearResumeBtn = document.getElementById("clear-resume-btn");
const resumeWarning  = document.getElementById("resume-warning");

const rolePills      = document.querySelectorAll(".role-pill");
const jobseekerSection = document.getElementById("jobseeker-section");
const recruiterSection = document.getElementById("recruiter-section");

const purposePills   = document.querySelectorAll("[data-purpose]");

const methodPills    = document.querySelectorAll(".method-pill");
const methodUrl      = document.getElementById("method-url");
const methodUpload   = document.getElementById("method-upload");
const methodType     = document.getElementById("method-type");
const jobUrlInput    = document.getElementById("job-url");
const jdUploadArea   = document.getElementById("jd-upload-area");
const jdFile         = document.getElementById("jd-file");
const jdUploadIcon   = document.getElementById("jd-upload-icon");
const jdUploadLabel  = document.getElementById("jd-upload-label");
const jobDetailsText = document.getElementById("job-details-text");
const extraNotesJobseeker  = document.getElementById("extra-notes-jobseeker");
const extraNotesRecruiter  = document.getElementById("extra-notes-recruiter");
const referralJobSection   = document.getElementById("referral-job-section");
const referralJobUrl       = document.getElementById("referral-job-url");

const profileLoading  = document.getElementById("profile-loading");
const notLinkedIn     = document.getElementById("not-linkedin");
const generateSection = document.getElementById("generate-section");

const profileAvatar   = document.getElementById("profile-avatar");
const profileName     = document.getElementById("profile-name");
const profileMeta     = document.getElementById("profile-meta");

const tonePills       = document.querySelectorAll("[data-tone]");

const generateBtn     = document.getElementById("generate-btn");
const btnLabel        = document.getElementById("btn-label");
const btnSpinner      = document.getElementById("btn-spinner");

const outputSection   = document.getElementById("output-section");
const messageOutput   = document.getElementById("message-output");
const charCount       = document.getElementById("char-count");

const copyBtn         = document.getElementById("copy-btn");
const regenBtn        = document.getElementById("regen-btn");

const errorBanner     = document.getElementById("error-banner");
const errorMsg        = document.getElementById("error-msg");

// ── State ─────────────────────────────────────────────────────────────────────

let resumeText   = "";
let jdText       = "";
let profileData  = null;
let activeTone   = "friendly";
let activeRole   = "jobseeker";
let activePurpose = "connect";
let activeMethod  = "url";
let userId       = null;
let genCount     = 0;

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const [storedResume, storedName, storedTone, storedUserId, storedCount, storedRole, storedPurpose] =
    await Promise.all([
      chromeGet(STORAGE_KEY_RESUME),
      chromeGet(STORAGE_KEY_FNAME),
      chromeGet(STORAGE_KEY_TONE),
      chromeGet(STORAGE_KEY_USER_ID),
      chromeGet(STORAGE_KEY_GEN_COUNT),
      chromeGet(STORAGE_KEY_ROLE),
      chromeGet(STORAGE_KEY_PURPOSE),
    ]);

  userId = storedUserId || crypto.randomUUID();
  if (!storedUserId) chromeSet(STORAGE_KEY_USER_ID, userId);

  genCount = storedCount || 0;
  renderGenCount();

  if (storedResume) {
    resumeText = storedResume;
    markResumeUploaded(storedName || "Resume");
  }

  if (storedTone)    setTone(storedTone);
  if (storedRole)    setRole(storedRole, false);
  if (storedPurpose) setPurpose(storedPurpose);

  const tab = await getActiveTab();
  const isLinkedIn = tab?.url?.match(/linkedin\.com\/in\//);

  if (!isLinkedIn) {
    notLinkedIn.classList.remove("hidden");
    updateGenerateBtn();
    return;
  }

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

// ── Profile loading ───────────────────────────────────────────────────────────

async function loadProfileData(tabId) {
  try {
    return await sendTabMessage(tabId, { type: "GET_PROFILE_DATA" });
  } catch (err) {
    if (err.message?.includes("Cannot access") || err.message?.includes("Receiving end does not exist")) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        await sleep(300);
        return await sendTabMessage(tabId, { type: "GET_PROFILE_DATA" });
      } catch { return null; }
    }
    return null;
  }
}

function renderProfileCard(data) {
  profileAvatar.textContent = (data.name || "?")[0].toUpperCase();
  profileName.textContent   = data.name || "Unknown";
  const metaParts = [data.title, data.company].filter(Boolean);
  profileMeta.textContent = metaParts.join(" · ") || data.location || "";
}

// ── Role selector ─────────────────────────────────────────────────────────────

rolePills.forEach((pill) => {
  pill.addEventListener("click", () => {
    setRole(pill.dataset.role, true);
  });
});

function setRole(role, save = true) {
  activeRole = role;
  rolePills.forEach((p) => p.classList.toggle("active", p.dataset.role === role));
  jobseekerSection.classList.toggle("hidden", role !== "jobseeker");
  recruiterSection.classList.toggle("hidden", role !== "recruiter");
  if (save) chromeSet(STORAGE_KEY_ROLE, role);
  updateGenerateBtn();
}

// ── Purpose selector (job seeker) ─────────────────────────────────────────────

purposePills.forEach((pill) => {
  pill.addEventListener("click", () => {
    setPurpose(pill.dataset.purpose);
    chromeSet(STORAGE_KEY_PURPOSE, activePurpose);
  });
});

function setPurpose(purpose) {
  activePurpose = purpose;
  purposePills.forEach((p) => p.classList.toggle("active", p.dataset.purpose === purpose));
  referralJobSection?.classList.toggle("hidden", purpose !== "referral");
}

// ── Input method selector (recruiter) ────────────────────────────────────────

methodPills.forEach((pill) => {
  pill.addEventListener("click", () => setMethod(pill.dataset.method));
});

function setMethod(method) {
  activeMethod = method;
  methodPills.forEach((p) => p.classList.toggle("active", p.dataset.method === method));
  methodUrl.classList.toggle("hidden",    method !== "url");
  methodUpload.classList.toggle("hidden", method !== "upload");
  methodType.classList.toggle("hidden",   method !== "type");
  updateGenerateBtn();
}

// ── Resume upload (job seeker) ────────────────────────────────────────────────

uploadArea.addEventListener("click",  () => resumeFile.click());
uploadArea.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") resumeFile.click(); });
uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("drag-over"); });
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("drag-over"));
uploadArea.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadArea.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) processResumeFile(e.dataTransfer.files[0]);
});
resumeFile.addEventListener("change", () => { if (resumeFile.files[0]) processResumeFile(resumeFile.files[0]); resumeFile.value = ""; });
clearResumeBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  resumeText = "";
  await Promise.all([chromeRemove(STORAGE_KEY_RESUME), chromeRemove(STORAGE_KEY_FNAME)]);
  markResumeCleared();
  updateGenerateBtn();
});

function processResumeFile(file) { processFile(file, "resume"); }

// ── JD upload (recruiter) ─────────────────────────────────────────────────────

jdUploadArea.addEventListener("click",  () => jdFile.click());
jdUploadArea.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") jdFile.click(); });
jdFile.addEventListener("change", () => { if (jdFile.files[0]) processFile(jdFile.files[0], "jd"); jdFile.value = ""; });

jobUrlInput.addEventListener("input",    updateGenerateBtn);
jobDetailsText.addEventListener("input", updateGenerateBtn);

// ── File processing ───────────────────────────────────────────────────────────

function processFile(file, target) {
  hideError();
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["pdf", "txt"].includes(ext)) { showError("Only PDF and TXT files are supported."); return; }

  if (ext === "txt") {
    const reader = new FileReader();
    reader.onload = (e) => saveContext(e.target.result, file.name, file.size, target);
    reader.readAsText(file);
  } else {
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = arrayBufferToBase64(e.target.result);
      saveContext(`__PDF_BASE64__${base64}`, file.name, file.size, target);
    };
    reader.readAsArrayBuffer(file);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function saveContext(text, filename, fileSize, target) {
  if (target === "resume") {
    resumeText = text;
    await Promise.all([chromeSet(STORAGE_KEY_RESUME, text), chromeSet(STORAGE_KEY_FNAME, filename)]);
    markResumeUploaded(filename);
    if (fileSize > PDF_SIZE_WARN_BYTES) {
      resumeWarning.textContent = "Large file — only the first portion will be sent.";
      resumeWarning.classList.remove("hidden");
    } else {
      resumeWarning.classList.add("hidden");
    }
  } else {
    jdText = text;
    jdUploadIcon.textContent  = "✅";
    jdUploadLabel.textContent = filename;
    jdUploadArea.classList.add("has-file");
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
  pill.addEventListener("click", () => { setTone(pill.dataset.tone); chromeSet(STORAGE_KEY_TONE, activeTone); });
});

function setTone(tone) {
  activeTone = tone;
  tonePills.forEach((p) => p.classList.toggle("active", p.dataset.tone === tone));
}

// ── Generate ──────────────────────────────────────────────────────────────────

generateBtn?.addEventListener("click", generate);
regenBtn?.addEventListener("click",   generate);

async function generate() {
  setLoading(true);
  hideError();
  outputSection.classList.add("hidden");

  try {
    const context      = getContext();
    const extraNotes   = (activeRole === "jobseeker" ? extraNotesJobseeker : extraNotesRecruiter)?.value?.trim() || "";
    const referralJob  = activePurpose === "referral" ? (referralJobUrl?.value?.trim() || "") : "";

    const result = await sendBackgroundMessage({
      type: "GENERATE_MESSAGE",
      payload: {
        profileData,
        resumeText: context,
        tone: activeTone,
        role: activeRole,
        purpose: activePurpose,
        extraNotes,
        referralJob,
        userId,
      },
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

function getContext() {
  if (activeRole === "jobseeker") return resumeText;
  if (activeMethod === "url")    return jobUrlInput.value.trim() || "(no job URL provided)";
  if (activeMethod === "upload") return jdText || "(no JD uploaded)";
  if (activeMethod === "type")   return jobDetailsText.value.trim() || "(no job details provided)";
  return "";
}

// ── Validate: enable generate button ─────────────────────────────────────────

function updateGenerateBtn() {
  if (!profileData) { generateBtn.disabled = true; return; }
  if (activeRole === "jobseeker") {
    generateBtn.disabled = !resumeText;
  } else {
    const hasContext =
      (activeMethod === "url"    && jobUrlInput.value.trim()) ||
      (activeMethod === "upload" && jdText) ||
      (activeMethod === "type"   && jobDetailsText.value.trim());
    generateBtn.disabled = !hasContext;
  }
}

// ── Insert & Copy ─────────────────────────────────────────────────────────────


copyBtn?.addEventListener("click", () => {
  if (!messageOutput.value) return;
  navigator.clipboard.writeText(messageOutput.value).then(() => {
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => (copyBtn.textContent = "Copy Message"), 2000);
  });
});

messageOutput?.addEventListener("input", updateCharCount);

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

function setLoading(on) {
  generateBtn.disabled = on;
  regenBtn.disabled    = on;
  btnLabel.textContent = on ? "Generating…" : "Generate Message";
  btnSpinner.classList.toggle("hidden", !on);
}

function showError(msg)  { errorMsg.textContent = msg; errorBanner.classList.remove("hidden"); }
function hideError()     { errorBanner.classList.add("hidden"); }

function friendlyError(msg = "") {
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError"))
    return "Could not reach the server. Check your internet connection.";
  if (msg.includes("401") || msg.includes("403")) return "API key error. Check your backend configuration.";
  if (msg.includes("429")) return "Rate limit hit. Wait a moment and try again.";
  if (msg.includes("500")) return "Server error. Try again in a few seconds.";
  return msg || "Something went wrong. Please try again.";
}

// ── Chrome API wrappers ───────────────────────────────────────────────────────

function getActiveTab() {
  return new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0])));
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function chromeGet(key) { return new Promise((resolve) => chrome.storage.local.get([key], (res) => resolve(res[key] ?? null))); }
function chromeSet(key, value) { return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve)); }
function chromeRemove(key) { return new Promise((resolve) => chrome.storage.local.remove(key, resolve)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
