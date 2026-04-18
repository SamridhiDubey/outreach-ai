const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.default();

// Model explicitly requested by the project spec
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 400;
// Resume text is truncated before reaching Claude to cap token spend
const RESUME_MAX_CHARS = 6_000;

const TONE_INSTRUCTIONS = {
  friendly:
    "Warm and conversational. Use the person's first name. Feel like a message from a real human, not a recruiter template.",
  professional:
    "Polished and respectful. Maintain a business-appropriate tone while still sounding human and genuine.",
  direct:
    "Get to the point immediately. Lead with value or the ask. No fluff. Short sentences.",
};

/**
 * Build the system prompt containing the sender's resume.
 * Marked with cache_control so repeated calls with the same resume are cheap.
 *
 * @param {string} resumeText
 * @param {string} tone
 * @returns {Array} Anthropic system blocks
 */
function buildSystemBlocks(resumeText, tone) {
  const truncated = resumeText.slice(0, RESUME_MAX_CHARS);
  const toneNote = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.friendly;

  const text = `You are an expert LinkedIn outreach writer. Your job is to write short, highly personalized LinkedIn DMs on behalf of the sender described below.

RULES:
- Never open with "I came across your profile", "Hope this message finds you well", or any other cliché.
- Reference something specific and concrete from the recipient's background (role, company, a project, an accomplishment).
- Connect it naturally to the sender's background — make it feel relevant, not random.
- End with ONE clear but low-pressure ask (a quick chat, a question, a connection).
- Length: aim for 2–3 sentences (under 300 characters ideal, never more than 5 sentences).
- Do NOT include a subject line, greeting header, or sign-off. Just the message body.
- Do NOT wrap the message in quotes.

TONE: ${toneNote}

SENDER'S RESUME:
${truncated}`;

  return [
    {
      type: "text",
      text,
      // Cache the system prompt + resume so repeat generations for the same
      // user hit the cache instead of re-tokenizing the resume every time.
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * Build the user message from LinkedIn profile data.
 *
 * @param {object} profileData
 * @returns {string}
 */
function buildUserPrompt(profileData) {
  const { name, title, company, location, about, experience, education, skills } =
    profileData;

  const experienceText = Array.isArray(experience)
    ? experience
        .map((e) => {
          const parts = [e.role, e.company, e.duration].filter(Boolean);
          return parts.join(" · ");
        })
        .join("\n")
    : String(experience || "");

  const educationText = Array.isArray(education)
    ? education
        .map((e) => [e.school, e.degree].filter(Boolean).join(", "))
        .join("\n")
    : "";

  const skillsText = Array.isArray(skills) ? skills.join(", ") : "";

  const lines = [
    `Name: ${name || "Unknown"}`,
    title     && `Title: ${title}`,
    company   && `Current Company: ${company}`,
    location  && `Location: ${location}`,
    about     && `About: ${about.slice(0, 500)}`,
    experienceText && `Experience:\n${experienceText}`,
    educationText  && `Education:\n${educationText}`,
    skillsText     && `Skills: ${skillsText}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `Write a LinkedIn DM to this person:\n\n${lines}\n\nReturn only the message body — nothing else.`;
}

/**
 * Call Claude to generate a personalized LinkedIn DM.
 *
 * @param {object} profileData - extracted LinkedIn profile fields
 * @param {string} resumeText  - sender's resume (plain text or extracted PDF text)
 * @param {string} tone        - "friendly" | "professional" | "direct"
 * @returns {Promise<string>}  - the generated message
 */
async function generateMessage(profileData, resumeText, tone = "friendly") {
  const system = buildSystemBlocks(resumeText, tone);
  const userPrompt = buildUserPrompt(profileData);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Claude response.");

  return textBlock.text.trim();
}

module.exports = { generateMessage };
