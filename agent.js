// agent.js
require("dotenv").config();
// @google/generative-ai reached end-of-life on Nov 30, 2025 - Google no
// longer maintains it and calls against the current API can fail outright.
// Use the current unified SDK instead.
const { GoogleGenAI } = require("@google/genai");

// Initialize Gemini Core
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = "gemini-2.5-flash";

const DEV_SANDBOX_MODE = false;

async function evaluateResource(resource) {
  // 1. Analyze the resource status locally
  const isIdle = resource.days_since_last_login >= 30 ? "YES" : "NO";
  const isMalicious = resource.is_malicious ? "YES" : "NO";
  const needsUpdate = resource.needs_update ? "YES" : "NO";

  // 2. THE HACKATHON SAFETY NET: Calculate the correct answer locally
  let guaranteedAnswer = "KEEP";
  if (isMalicious === "YES") guaranteedAnswer = "QUARANTINE";
  else if (isIdle === "YES") guaranteedAnswer = "TERMINATE";
  else if (needsUpdate === "YES") guaranteedAnswer = "UPDATE";

  // Sandbox short-circuit
  if (DEV_SANDBOX_MODE) {
    return guaranteedAnswer;
  }

  const prompt = `
    You are a strict enterprise IT security agent. You must respond with EXACTLY ONE WORD.
    Malicious Threat: ${isMalicious}
    Idle Over 30 Days: ${isIdle}
    Needs Critical Update: ${needsUpdate}

    RULES:
    1. If Malicious Threat is YES -> output QUARANTINE
    2. If Idle Over 30 Days is YES -> output TERMINATE
    3. If Needs Critical Update is YES -> output UPDATE
    4. Otherwise -> output KEEP
    `;

  try {
    // ⚡ THE GEMINI CLOUD PIPELINE ⚡
    const result = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
    });
    const rawResponse = result.text.toUpperCase();

    if (rawResponse.includes("QUARANTINE")) return "QUARANTINE";
    if (rawResponse.includes("TERMINATE")) return "TERMINATE";
    if (rawResponse.includes("UPDATE")) return "UPDATE";

    return guaranteedAnswer;
  } catch (error) {
    console.log(
      `[GEMINI API ERROR] Request failed: ${error.message}. Dropping to safe defaults.`,
    );
    return guaranteedAnswer;
  }
}

module.exports = { evaluateResource };
