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

function computeGuaranteedAnswer(resource) {
  const isIdle = resource.days_since_last_login >= 30 ? "YES" : "NO";
  const isMalicious = resource.is_malicious ? "YES" : "NO";
  const needsUpdate = resource.needs_update ? "YES" : "NO";

  if (isMalicious === "YES") return "QUARANTINE";
  if (isIdle === "YES") return "TERMINATE";
  if (needsUpdate === "YES") return "UPDATE";
  return "KEEP";
}

// Scores every resource in ONE Gemini call instead of one call per resource.
// The Gemini free tier caps out at 20 requests/day/model - looping
// evaluateResource() per row burns through that in a single audit refresh
// once there's more than a handful of resources. Since the correct answer
// is fully deterministic anyway (see computeGuaranteedAnswer), Gemini here
// is just a rubber stamp, so there's no reason to spend N calls on it.
async function evaluateResourcesBatch(resources) {
  const guaranteedAnswers = resources.map(computeGuaranteedAnswer);

  if (DEV_SANDBOX_MODE || resources.length === 0) {
    return guaranteedAnswers;
  }

  const summary = resources
    .map((r, i) => {
      const isIdle = r.days_since_last_login >= 30 ? "YES" : "NO";
      const isMalicious = r.is_malicious ? "YES" : "NO";
      const needsUpdate = r.needs_update ? "YES" : "NO";
      return `${i}. "${r.resource_name}" -> Malicious: ${isMalicious}, Idle Over 30 Days: ${isIdle}, Needs Critical Update: ${needsUpdate}`;
    })
    .join("\n");

  const prompt = `
    You are a strict enterprise IT security agent reviewing a batch of resources.
    For EACH numbered resource below, output exactly one line in the format
    "INDEX: ACTION" (e.g. "0: TERMINATE") and nothing else - no extra text.

    RULES (apply independently per resource, in priority order):
    1. If Malicious is YES -> QUARANTINE
    2. Else if Idle Over 30 Days is YES -> TERMINATE
    3. Else if Needs Critical Update is YES -> UPDATE
    4. Otherwise -> KEEP

    Resources:
    ${summary}
    `;

  try {
    const result = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: prompt,
    });
    const rawResponse = result.text.toUpperCase();

    const finalAnswers = [...guaranteedAnswers];
    const lineRegex = /(\d+)\s*[:\-]\s*(QUARANTINE|TERMINATE|UPDATE|KEEP)/g;
    let match;
    while ((match = lineRegex.exec(rawResponse)) !== null) {
      const idx = parseInt(match[1], 10);
      if (idx >= 0 && idx < finalAnswers.length) {
        finalAnswers[idx] = match[2];
      }
    }
    return finalAnswers;
  } catch (error) {
    console.log(
      `[GEMINI API ERROR] Batch audit request failed: ${error.message}. Dropping to safe defaults.`,
    );
    return guaranteedAnswers;
  }
}

module.exports = { evaluateResource, evaluateResourcesBatch };
