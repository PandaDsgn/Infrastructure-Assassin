// agent.js
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini Core
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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
    const result = await model.generateContent(prompt);
    const rawResponse = result.response.text().toUpperCase();

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
