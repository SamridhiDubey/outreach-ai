const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.default();

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 400;
const CONTEXT_MAX_CHARS = 6_000;

const TONE_INSTRUCTIONS = {
  friendly:     "Warm and conversational. Use the person's first name. Feel like a message from a real human, not a template.",
  professional: "Polished and respectful. Business-appropriate tone while still sounding human and genuine.",
  direct:       "Get to the point immediately. Lead with value or the ask. No fluff. Short sentences.",
};

const PURPOSE_INSTRUCTIONS = {
  connect:  "The goal is a genuine casual connection — no hard ask. Warm and human, reference something specific about their work or background.",
  referral: "The sender wants a referral at the recipient's company for a specific role. Make a genuine connection first, then a soft specific ask for a referral. Be respectful of their time.",
};

function buildSystemBlocks(context, tone, role, purpose) {
  const truncated = context.slice(0, CONTEXT_MAX_CHARS);
  const toneNote  = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.friendly;

  let roleInstructions;
  let contextLabel;

  if (role === "recruiter") {
    contextLabel = "JOB OPPORTUNITY DETAILS";
    roleInstructions = `You are an expert LinkedIn outreach writer helping a RECRUITER reach out to potential candidates.

RULES:
- Never open with "I came across your profile", "Hope this message finds you well", or any cliché opener.
- Reference something specific from the candidate's background that makes them a strong fit for this role.
- Mention the company or role briefly — don't paste the full job description.
- End with ONE low-pressure ask (a quick chat, a question, interest check).
- Length: 2–3 sentences (under 300 characters ideal, never more than 5 sentences).
- Do NOT include a subject line, greeting header, or sign-off. Just the message body.
- Do NOT wrap the message in quotes.`;
  } else {
    contextLabel = "SENDER'S RESUME";
    const purposeNote = PURPOSE_INSTRUCTIONS[purpose] || PURPOSE_INSTRUCTIONS.connect;
    roleInstructions = `You are an expert LinkedIn outreach writer. Write short, personalized LinkedIn DMs on behalf of the job seeker described in the SENDER'S RESUME below.

CRITICAL RULES:
- The SENDER is the person whose resume you have. The RECIPIENT is the LinkedIn profile in the user message. These are two different people — never mix them up.
- Only reference the RECIPIENT'S own companies, roles, and accomplishments when describing their background. Never attribute the sender's employers or projects to the recipient.
- When mentioning the sender's background, only use facts explicitly stated in the resume. Do NOT invent or infer the sender's current company, team, or role — if it's not clearly written in the resume, don't say it.
- Connect the RECIPIENT'S background to the SENDER'S background to show relevance — but keep them clearly separate.
- Never open with "I came across your profile", "Hope this message finds you well", or any cliché opener.
- End with ONE clear but low-pressure ask.
- Length: 2–3 sentences (under 300 characters ideal, never more than 5 sentences).
- Do NOT include a subject line, greeting header, or sign-off. Just the message body.
- Do NOT wrap the message in quotes.

OUTREACH PURPOSE: ${purposeNote}`;
  }

  const text = `${roleInstructions}

TONE: ${toneNote}

${contextLabel}:
${truncated}`;

  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

function detectRecipientType(title = "") {
  const t = title.toLowerCase();
  if (/\b(hr|human resource|talent|recruiter|recruiting|people ops|people partner|acquisition|sourcer)\b/.test(t))
    return "hr";
  if (/\b(ceo|cto|coo|cfo|founder|co-founder|president|vp|vice president|head of|director|chief)\b/.test(t))
    return "leader";
  if (/\b(manager|lead|principal|staff|senior|engineering manager|tech lead)\b/.test(t))
    return "manager";
  return "engineer";
}

const RECIPIENT_TYPE_INSTRUCTIONS = {
  hr: "The recipient is in HR, talent acquisition, or recruiting — they post and own job openings. Lead with the specific role you're interested in. No need to warm up much — they expect direct outreach about jobs. Mention the role/job ID if provided.",
  leader: "The recipient is a senior leader (VP, Director, Head of, C-suite). Be concise and confident. Show you understand what their team/org works on. Don't be too casual — they're busy. Make a clear, specific ask.",
  manager: "The recipient is an engineering manager or team lead. They care about team fit and technical credibility. Reference their team's work or tech stack. A referral ask should feel like peer-to-peer, not fan mail.",
  engineer: "The recipient is an individual contributor (engineer, designer, analyst, etc.). Be peer-to-peer and genuine. Talk about their actual technical work or projects. A referral ask should feel like one professional to another, not transactional.",
};

function buildUserPrompt(profileData, extraNotes, referralJob = "") {
  const { name, title, company, location, about, experience, education, skills } = profileData;

  const experienceText = Array.isArray(experience)
    ? experience.map((e) => [e.role, e.company, e.duration].filter(Boolean).join(" · ")).join("\n")
    : String(experience || "");

  const educationText = Array.isArray(education)
    ? education.map((e) => [e.school, e.degree].filter(Boolean).join(", ")).join("\n")
    : "";

  const skillsText = Array.isArray(skills) ? skills.join(", ") : "";

  const lines = [
    `Name: ${name || "Unknown"}`,
    title          && `Title: ${title}`,
    company        && `Current Company: ${company}`,
    location       && `Location: ${location}`,
    about          && `About: ${about.slice(0, 500)}`,
    experienceText && `Experience:\n${experienceText}`,
    educationText  && `Education:\n${educationText}`,
    skillsText     && `Skills: ${skillsText}`,
  ].filter(Boolean).join("\n");

  const recipientType = detectRecipientType(profileData.title);
  const recipientNote = RECIPIENT_TYPE_INSTRUCTIONS[recipientType];

  let prompt = `Write a LinkedIn DM to this RECIPIENT (not the sender):\n\n${lines}\n\nRECIPIENT TYPE: ${recipientNote}\n\nRemember: only reference the RECIPIENT'S own experience listed above. Return only the message body — nothing else.`;
  if (referralJob?.trim()) {
    prompt += `\n\nThe sender is asking for a referral for this specific role: ${referralJob.trim()} — mention this job in the message.`;
  }
  if (extraNotes?.trim()) {
    prompt += `\n\nAdditional context from the sender: ${extraNotes.trim()}`;
  }
  return prompt;
}

async function generateMessage(profileData, context, tone = "friendly", role = "jobseeker", purpose = "connect", extraNotes = "", referralJob = "") {
  const system     = buildSystemBlocks(context, tone, role, purpose);
  const userPrompt = buildUserPrompt(profileData, extraNotes, referralJob);

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
