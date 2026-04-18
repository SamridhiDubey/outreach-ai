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
  return {
    name:       extractName(),
    title:      extractHeadline(),
    company:    extractCurrentCompany(),
    location:   extractLocation(),
    about:      extractAbout(),
    experience: extractExperience(),
    education:  extractEducation(),
    skills:     extractSkills(),
    profileUrl: location.href.split("?")[0],
  };
}

// ── Field extractors ──────────────────────────────────────────────────────────

function extractName() {
  // Try selectors first
  const fromDOM = firstText([
    "h1.text-heading-xlarge",
    "h1[class*='text-heading']",
    "h1[data-anonymize='person-name']",
    ".pv-text-details__left-panel h1",
    ".pv-top-card--list li:first-child",
    "main h1",
  ]);
  if (fromDOM) return fromDOM;

  // og:title is "Name - Title | LinkedIn"
  const og = metaContent("og:title");
  if (og) return og.split(/\s[-|]\s/)[0].trim();

  // document.title is "Name | LinkedIn" or "Name - Title | LinkedIn"
  const title = document.title;
  if (title && !title.toLowerCase().startsWith("linkedin")) {
    return title.split(/\s[-|]\s/)[0].trim();
  }

  return "";
}

function extractHeadline() {
  return firstText([
    "div.text-body-medium.break-words",
    "[class*='text-body-medium'][class*='break-words']",
    ".pv-text-details__left-panel .text-body-medium",
    "[data-field='headline']",
    ".pv-top-card--list-bullet li:first-child",
  ]);
}

function extractCurrentCompany() {
  // LinkedIn often surfaces current company in the top-card "experience" button
  const btn = document.querySelector(
    "button[aria-label*='Current company']," +
    "a[aria-label*='Current company']"
  );
  if (btn) {
    const span = btn.querySelector("span[aria-hidden='true']");
    if (span?.innerText.trim()) return span.innerText.trim();
  }

  // Fallback: first experience item's company name
  const firstExp = getExperienceItems()[0];
  if (firstExp?.company) return firstExp.company;

  return firstText([
    ".pv-text-details__right-panel .inline-show-more-text",
    ".pv-text-details__right-panel span[aria-hidden='true']",
  ]);
}

function extractLocation() {
  return firstText([
    ".pv-text-details__left-panel span.text-body-small.inline.t-black--light",
    ".pv-text-details__left-panel .text-body-small.inline",
    "[data-field='location']",
    ".pv-top-card--list-bullet li.t-16",
  ]);
}

function extractAbout() {
  // LinkedIn hides truncated text in a visually-hidden span
  const section = findSectionByHeading("about");
  if (section) {
    const hidden = section.querySelector(".visually-hidden");
    if (hidden?.innerText.trim()) return hidden.innerText.trim();

    const inline = section.querySelector(".inline-show-more-text");
    if (inline?.innerText.trim()) return inline.innerText.trim();

    // Grab all non-empty aria-hidden spans inside the section
    const spans = [...section.querySelectorAll("span[aria-hidden='true']")]
      .map((s) => s.innerText.trim())
      .filter(Boolean);
    if (spans.length) return spans.join(" ");
  }

  return firstText([
    "#about ~ div .visually-hidden",
    "#about ~ div .inline-show-more-text",
    ".pv-about__summary-text",
  ]);
}

function extractExperience() {
  return getExperienceItems().slice(0, 6);
}

function extractEducation() {
  const section = findSectionByHeading("education");
  if (!section) return [];

  const items = section.querySelectorAll("li.artdeco-list__item");
  const results = [];

  items.forEach((item) => {
    const spans = visibleSpans(item);
    if (!spans.length) return;

    results.push({
      school:  spans[0] || "",
      degree:  spans[1] || "",
      years:   spans.find((s) => /\d{4}/.test(s)) || "",
    });
  });

  return results.slice(0, 3);
}

function extractSkills() {
  const section = findSectionByHeading("skills");
  if (!section) return [];

  return [...section.querySelectorAll("li.artdeco-list__item")]
    .slice(0, 8)
    .map((item) => {
      const s = item.querySelector("span[aria-hidden='true']");
      return s?.innerText.trim() || "";
    })
    .filter(Boolean);
}

// ── Experience item parser ────────────────────────────────────────────────────

function getExperienceItems() {
  const section = findSectionByHeading("experience");
  if (!section) return [];

  const listItems = section.querySelectorAll("li.artdeco-list__item");
  const results = [];

  listItems.forEach((item) => {
    const spans = visibleSpans(item);
    if (!spans.length) return;

    // LinkedIn renders two layouts:
    //  A) Single role at a company  → [Role, Company · Type, Duration, Location]
    //  B) Multiple roles at company → [Company] then child items with role/duration

    // Detect layout B: item contains nested sub-list
    const subList = item.querySelector("ul");
    if (subList) {
      // Parent item is the company header
      const company = spans[0] || "";
      const subItems = subList.querySelectorAll("li.artdeco-list__item");
      subItems.forEach((sub) => {
        const subSpans = visibleSpans(sub);
        results.push(parseRoleSpans(subSpans, company));
      });
    } else {
      results.push(parseRoleSpans(spans, ""));
    }
  });

  return results.filter((e) => e.role);
}

function parseRoleSpans(spans, fallbackCompany) {
  // spans[0] = role title
  // spans[1] = "Company · Employment type"  OR  duration if layout B
  // spans[2] = duration  OR  location
  // spans[3] = location
  const role     = spans[0] || "";
  const raw1     = spans[1] || "";
  const raw2     = spans[2] || "";

  // Split "Company · Full-time" on bullet/dot separators
  const parts    = raw1.split(/\s*[·•]\s*/);
  const company  = fallbackCompany || parts[0] || "";
  const empType  = parts[1] || "";

  // Duration usually matches "Month Year – Month Year" or "X yrs Y mos"
  const durationRaw = [raw1, raw2, spans[3] || ""].find((s) =>
    /\d{4}|yr|mo|Present/i.test(s)
  ) || "";

  return { role, company, empType, duration: cleanDuration(durationRaw) };
}

function cleanDuration(str) {
  // Remove leading/trailing fluff, keep "Jan 2022 – Present · 2 yrs" style
  return str.replace(/^[·•\s]+|[·•\s]+$/g, "").trim();
}

// ── Section finder ────────────────────────────────────────────────────────────

/**
 * Finds a profile section by its heading text.
 * LinkedIn uses anchor elements like <div id="experience"> or <section>
 * elements with a nested h2 containing the heading text.
 */
function findSectionByHeading(keyword) {
  // Strategy 1: id-based anchor (new UI)
  const anchor = document.getElementById(keyword);
  if (anchor) {
    // Walk up to find the enclosing section/div, then grab the pvs-list sibling
    const container = anchor.closest("section") ||
                      anchor.parentElement?.parentElement;
    if (container) return container;
  }

  // Strategy 2: scan all sections for matching h2 text
  const sections = document.querySelectorAll(
    "section.artdeco-card, section[data-section]"
  );
  for (const sec of sections) {
    const heading = sec.querySelector("h2, h3");
    if (heading?.innerText.toLowerCase().includes(keyword)) return sec;
  }

  return null;
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

  // 2. Otherwise try clicking the "Message" button on the profile
  const msgBtn = findMessageButton();
  if (msgBtn) {
    msgBtn.click();
    // Wait up to 2 s for the compose box to appear
    for (let i = 0; i < 10; i++) {
      await sleep(200);
      if (tryInsertIntoBox(text)) return true;
    }
  }

  return false;
}

function findMessageButton() {
  // Primary CTA on profile pages
  const candidates = document.querySelectorAll(
    "a[href*='/messaging/'], " +
    "button[aria-label*='Message'], " +
    ".pvs-profile-actions button"
  );
  for (const btn of candidates) {
    const label = (btn.innerText || btn.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("message")) return btn;
  }
  return null;
}

function tryInsertIntoBox(text) {
  const selectors = [
    ".msg-form__contenteditable[contenteditable='true']",
    ".compose-form__message-field[contenteditable='true']",
    "div.msg-form__msg-content-container div[contenteditable='true']",
    "div[role='textbox'][contenteditable='true']",
  ];

  for (const sel of selectors) {
    const box = document.querySelector(sel);
    if (!box) continue;

    box.focus();
    // Select all existing text and replace — works with LinkedIn's React listener
    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, text);
    // Dispatch input event so React's synthetic event system picks it up
    box.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
    return true;
  }

  return false;
}
