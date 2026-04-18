// pdf-parse eagerly requires a test PDF when imported at the top of a module,
// which breaks Vercel's read-only sandbox. Lazy-require inside the function
// so the module resolves but the file-system hit only happens on first call.

const MAX_CHARS = 8_000;

/**
 * Extract plain text from a base64-encoded PDF string.
 * Returns the text truncated to MAX_CHARS.
 * @param {string} base64 - raw base64 (no data-URL prefix)
 * @returns {Promise<string>}
 */
async function extractPdfText(base64) {
  // Lazy require avoids the test-file issue on Vercel
  const pdfParse = require("pdf-parse/lib/pdf-parse.js");
  const buffer = Buffer.from(base64, "base64");
  const result = await pdfParse(buffer);
  return result.text.slice(0, MAX_CHARS).trim();
}

module.exports = { extractPdfText };
