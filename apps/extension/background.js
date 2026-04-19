const BACKEND_URL = "https://outreach-ai-backend.vercel.app";
const EXTENSION_SECRET = "outreach-ext-v1-a9f3k2m8p5";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GENERATE_MESSAGE") {
    handleGenerate(message.payload).then(sendResponse).catch((err) => {
      sendResponse({ error: err.message });
    });
    return true; // keep channel open for async response
  }
});

async function handleGenerate({ profileData, resumeText, tone, userId, role, purpose, extraNotes, referralJob }) {
  const response = await fetch(`${BACKEND_URL}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-extension-token": EXTENSION_SECRET,
    },
    body: JSON.stringify({ profileData, resumeText, tone, userId, role, purpose, extraNotes, referralJob }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Backend error: ${response.status}`);
  }

  return response.json();
}
