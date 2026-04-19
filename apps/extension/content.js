/**
 * OutreachAI — Content Script
 *
 * Runs on linkedin.com/in/* pages.
 * Responsibilities:
 *  1. Extract structured profile data from the DOM (with retries for React hydration)
 *  2. Re-initialize on LinkedIn SPA navigations
 *  3. Insert generated messages into the LinkedIn compose box
 */

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_PROFILE_DATA") {
    // LinkedIn hydrates lazily; retry up to ~3 s before giving up
    extractWithRetry(8, 400)
      .then(sendResponse)
      .catch(() => sendResponse({ error: "Profile not ready. Try refreshing." }));
    return true; // keep channel open for async response
  }

  if (message.type === "INSERT_MESSAGE") {
    insertMessage(message.text)
      .then((ok) => sendResponse({ success: ok }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }
});

// ── SPA navigation detection ──────────────────────────────────────────────────
// LinkedIn is a SPA; the content script survives page transitions.
// We watch the URL so profile data is always fresh.

let lastUrl = location.href;

new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // New page: invalidate any cached state if needed
  }
}).observe(document, { subtree: true, childList: true });

// ── Extraction with retry ─────────────────────────────────────────────────────

async function extractWithRetry(attempts, delayMs) {
  for (let i = 0; i < attempts; i++) {
    const data = extractProfileData();
    // Consider extraction successful if we at least got a name
    if (data.name) return data;
    if (i < attempts - 1) await sleep(delayMs);
  }
  // Return whatever we have even if incomplete
  return extractProfileData();
}

// ── Core extraction ───────────────────────────────────────────────────────────

function extractProfileData() {
  const name           = extractName();
  const profileSection = findProfileSection(name);
  const profileText    = profileSection?.innerText || "";

  return {
    name,
    title:      extractTitle(profileText),
    company:    extractCompany(profileText),
    location:   extractLocation(profileText),
    about:      extractAbout(),
    experience: extractExperience(),
    education:  extractEducation(profileText),
    skills:     extractSkills(),
    profileUrl: location.href.split("?")[0],
  };
}

// ── Name ──────────────────────────────────────────────────────────────────────

function extractName() {
  // Try h1 first (old layout)
  const fromH1 = firstText([
    "h1.text-heading-xlarge",
    "h1[class*='text-heading']",
    "h1[data-anonymize='person-name']",
    "main h1",
  ]);
  if (fromH1) return fromH1;

  // New layout: name is in a section h2 that matches the page title
  const og = metaContent("og:title");
  if (og) return og.split(/\s*[|\-–]\s*/)[0].trim();

  // document.title = "Name | LinkedIn"
  const t = document.title;
  if (t && !t.toLowerCase().startsWith("linkedin")) {
    return t.split(/\s*[|\-–]\s*/)[0].trim();
  }
  return "";
}

// ── Profile section (new LinkedIn layout) ────────────────────────────────────

function findProfileSection(name) {
  // Try h2-name match first (some new layout variants)
  for (const sec of document.querySelectorAll("section")) {
    const h2 = sec.querySelector("h2");
    if (h2 && name && h2.innerText.trim() === name.trim()) return sec;
  }
  // Fallback: section[1] is the profile card in LinkedIn's 2024+ layout
  const sections = document.querySelectorAll("section");
  if (sections.length > 1) return sections[1];
  return sections[0] || null;
}

// Parse profile card text for title/company/location/education
// Profile card innerText looks like:
// "Name\n\n· 1st\n\nTitle Here\n\nCity, Country\n\n·\n\nContact info\n\nCompany\n\nUniversity..."

function extractTitle(profileText) {
  if (!profileText) return firstText(["div.text-body-medium.break-words", "[data-field='headline']"]);
  const lines = cleanLines(profileText);
  // Title is typically 2nd meaningful line (after name and degree indicator)
  const idx = lines.findIndex(l => /^(1st|2nd|3rd)$/i.test(l));
  if (idx !== -1 && lines[idx + 1]) return lines[idx + 1];
  // Fallback: second line
  return lines[1] || "";
}

function extractCompany(profileText) {
  if (!profileText) return "";
  // Company appears as a standalone short line after location
  const lines = cleanLines(profileText);
  // Heuristic: short line (< 40 chars) that comes after a location-like line
  for (let i = 2; i < lines.length; i++) {
    if (lines[i].length < 40 && !/connection|mutual|contact|message|follow/i.test(lines[i])) {
      const prev = lines[i - 1] || "";
      if (/india|usa|uk|canada|remote|\w+,\s*\w+/i.test(prev)) return lines[i];
    }
  }
  // Fallback: look for company after title
  const titleLine = extractTitle(profileText);
  const titleIdx  = lines.indexOf(titleLine);
  if (titleIdx !== -1) {
    for (let i = titleIdx + 1; i < Math.min(titleIdx + 4, lines.length); i++) {
      if (lines[i] && lines[i].length < 50 && !/^\d/.test(lines[i])) return lines[i];
    }
  }
  return "";
}

function extractLocation(profileText) {
  if (!profileText) return firstText([".pv-text-details__left-panel span.text-body-small.inline"]);
  const lines = cleanLines(profileText);
  // Match known country names or "City, State/Country" patterns
  return lines.find(l =>
    /,\s*(india|usa|uk|canada|germany|australia|france|singapore|remote|\w+ state|\w+ province)/i.test(l) ||
    /\w[\w\s]+,\s*\w[\w\s]+(,\s*\w[\w\s]+)?$/.test(l.trim())
  ) || "";
}

function extractEducation(profileText) {
  // Try old selectors first
  const section = findSectionByHeading("education");
  if (section) {
    const items = section.querySelectorAll("li.artdeco-list__item");
    if (items.length) {
      return [...items].slice(0, 3).map(item => {
        const spans = visibleSpans(item);
        return { school: spans[0] || "", degree: spans[1] || "" };
      });
    }
  }

  // New layout: education appears in the profile card text
  if (profileText) {
    const lines = cleanLines(profileText);
    const uniLine = lines.find(l => /university|institute|college|school|iit|nit|bits/i.test(l));
    if (uniLine) return [{ school: uniLine, degree: "" }];
  }
  return [];
}

// ── About ──────────────────────────────────────────────────────────────────────

function extractAbout() {
  // Find section with h2 = "About"
  for (const sec of document.querySelectorAll("section")) {
    const h2 = sec.querySelector("h2");
    if (h2?.innerText.trim().toLowerCase() === "about") {
      // Remove the heading from the text
      const full = sec.innerText.trim();
      return full.replace(/^about\n*/i, "").trim().slice(0, 1000);
    }
  }
  // Old layout fallbacks
  return firstText(["#about ~ div .visually-hidden", "#about ~ div .inline-show-more-text", ".pv-about__summary-text"]);
}

// ── Experience ────────────────────────────────────────────────────────────────

function extractExperience() {
  // Old layout: artdeco list items
  const items = getExperienceItems();
  if (items.length) return items.slice(0, 6);

  // New layout: dedicated Experience section with h2
  for (const sec of document.querySelectorAll("section")) {
    const h2 = sec.querySelector("h2");
    if (h2?.innerText.trim().toLowerCase() === "experience") {
      const text = sec.innerText.replace(/^experience\n*/i, "").trim();
      return [{ role: "", company: "", duration: text.slice(0, 500) }];
    }
  }

  // Newest layout: experience is in the page body but not a dedicated section.
  // Scan all elements for an "Experience" heading and grab the following content.
  for (const el of document.querySelectorAll("h2, h3, [class*='heading']")) {
    if (el.innerText?.trim().toLowerCase() === "experience") {
      let sibling = el.closest("section") || el.parentElement;
      if (sibling) {
        const text = sibling.innerText.replace(/^experience\n*/i, "").trim();
        if (text.length > 20) return [{ role: "", company: "", duration: text.slice(0, 500) }];
      }
    }
  }
  return [];
}

function extractSkills() {
  const section = findSectionByHeading("skills");
  if (!section) return [];
  return [...section.querySelectorAll("li.artdeco-list__item")]
    .slice(0, 8)
    .map(item => item.querySelector("span[aria-hidden='true']")?.innerText.trim() || "")
    .filter(Boolean);
}

// ── Experience item parser (old layout) ──────────────────────────────────────

function getExperienceItems() {
  const section = findSectionByHeading("experience");
  if (!section) return [];
  const listItems = section.querySelectorAll("li.artdeco-list__item");
  const results = [];
  listItems.forEach((item) => {
    const spans = visibleSpans(item);
    if (!spans.length) return;
    const subList = item.querySelector("ul");
    if (subList) {
      const company = spans[0] || "";
      subList.querySelectorAll("li.artdeco-list__item").forEach((sub) => {
        results.push(parseRoleSpans(visibleSpans(sub), company));
      });
    } else {
      results.push(parseRoleSpans(spans, ""));
    }
  });
  return results.filter((e) => e.role);
}

function parseRoleSpans(spans, fallbackCompany) {
  const role    = spans[0] || "";
  const raw1    = spans[1] || "";
  const raw2    = spans[2] || "";
  const parts   = raw1.split(/\s*[·•]\s*/);
  const company = fallbackCompany || parts[0] || "";
  const durationRaw = [raw1, raw2, spans[3] || ""].find(s => /\d{4}|yr|mo|Present/i.test(s)) || "";
  return { role, company, duration: durationRaw.replace(/^[·•\s]+|[·•\s]+$/g, "").trim() };
}

// ── Section finder (old layout) ───────────────────────────────────────────────

function findSectionByHeading(keyword) {
  const anchor = document.getElementById(keyword);
  if (anchor) {
    const container = anchor.closest("section") || anchor.parentElement?.parentElement;
    if (container) return container;
  }
  for (const sec of document.querySelectorAll("section.artdeco-card, section[data-section], section")) {
    const heading = sec.querySelector("h2, h3");
    if (heading?.innerText.toLowerCase().includes(keyword)) return sec;
  }
  return null;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function cleanLines(text) {
  return text.split("\n").map(l => l.trim()).filter(l => l && l !== "·" && l !== "•");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function firstText(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el?.innerText.trim()) return el.innerText.trim();
    } catch { /* invalid selector in some browser versions */ }
  }
  return "";
}

function visibleSpans(container) {
  return [...container.querySelectorAll("span[aria-hidden='true']")]
    .map((s) => s.innerText.trim())
    .filter(Boolean);
}

function metaContent(property) {
  return document.querySelector(`meta[property='${property}']`)?.content || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Message insertion ─────────────────────────────────────────────────────────

async function insertMessage(text) {
  // 1. If a compose box is already open, use it directly
  if (tryInsertIntoBox(text)) return true;

  // 2. Click the Message button on the profile and wait for the box
  const msgBtn = findMessageButton();
  if (msgBtn) {
    msgBtn.click();
    // Wait up to 4 s for the compose box to appear
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      if (tryInsertIntoBox(text)) return true;
    }
  }

  return false;
}

function findMessageButton() {
  // Try aria-label first — most reliable
  const byAria = document.querySelector(
    "button[aria-label^='Message'], " +
    "button[aria-label*=' Message']"
  );
  if (byAria) return byAria;

  // Scan all buttons in the profile action area for one labelled "Message"
  const allButtons = document.querySelectorAll(
    ".pvs-profile-actions button, " +
    ".pv-top-card__actions button, " +
    ".ph5 button, " +
    "main button"
  );
  for (const btn of allButtons) {
    const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim().toLowerCase();
    if (text === "message" || text.startsWith("message ")) return btn;
  }

  return null;
}

function tryInsertIntoBox(text) {
  const specificSelectors = [
    ".msg-form__contenteditable[contenteditable='true']",
    ".compose-form__message-field[contenteditable='true']",
    "div.msg-form__msg-content-container div[contenteditable='true']",
    "div[role='textbox'][contenteditable='true']",
  ];

  // Try specific selectors first
  for (const sel of specificSelectors) {
    const box = document.querySelector(sel);
    if (box && isVisible(box)) return insertIntoBox(box, text);
  }

  // Fallback: any visible contenteditable on the page (catches new LinkedIn layouts)
  for (const box of document.querySelectorAll("[contenteditable='true']")) {
    if (isVisible(box)) return insertIntoBox(box, text);
  }

  return false;
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.top >= 0;
}

function insertIntoBox(box, text) {
  box.focus();
  document.execCommand("selectAll", false, null);

  // Strategy 1: DataTransfer paste — most reliable with React
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    if (box.innerText?.trim()) return true;
  } catch {}

  // Strategy 2: execCommand fallback
  document.execCommand("insertText", false, text);
  box.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
  return true;
}
