require("dotenv").config();

const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = "gemini-2.5-flash";

const DEV_SANDBOX_MODE = false;

function computeGuaranteedAnswer(resource) {
  const isIdle = resource.days_since_last_login >= 30 ? "YES" : "NO";
  const isMalicious = resource.is_malicious ? "YES" : "NO";
  const needsUpdate = resource.needs_update ? "YES" : "NO";

  if (isMalicious === "YES") return "QUARANTINE";
  if (isIdle === "YES") return "TERMINATE";
  if (needsUpdate === "YES") return "UPDATE";
  return "KEEP";
}

async function evaluateResource(resource) {
  const isIdle = resource.days_since_last_login >= 30 ? "YES" : "NO";
  const isMalicious = resource.is_malicious ? "YES" : "NO";
  const needsUpdate = resource.needs_update ? "YES" : "NO";

  let guaranteedAnswer = computeGuaranteedAnswer(resource);

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
    if (!process.env.GEMINI_API_KEY) throw new Error("No Gemini key found");
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
      `[GEMINI API ERROR] Single audit failed: ${error.message}. Routing to Groq...`,
    );

    try {
      if (!process.env.GROQ_API_KEY) throw new Error("No Groq key found");
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
          }),
        },
      );

      if (!response.ok) throw new Error(`Groq HTTP Error: ${response.status}`);
      const data = await response.json();
      const rawResponse = data.choices[0].message.content.toUpperCase();

      if (rawResponse.includes("QUARANTINE")) return "QUARANTINE";
      if (rawResponse.includes("TERMINATE")) return "TERMINATE";
      if (rawResponse.includes("UPDATE")) return "UPDATE";

      return guaranteedAnswer;
    } catch (groqError) {
      console.log(
        `[GROQ API ERROR] Single audit failed: ${groqError.message}. Routing to DeepSeek...`,
      );

      try {
        if (!process.env.DEEPSEEK_API_KEY)
          throw new Error("No DeepSeek key found");
        const response = await fetch(
          "https://api.deepseek.com/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages: [{ role: "user", content: prompt }],
            }),
          },
        );

        if (!response.ok)
          throw new Error(`DeepSeek HTTP Error: ${response.status}`);
        const data = await response.json();
        const rawResponse = data.choices[0].message.content.toUpperCase();

        if (rawResponse.includes("QUARANTINE")) return "QUARANTINE";
        if (rawResponse.includes("TERMINATE")) return "TERMINATE";
        if (rawResponse.includes("UPDATE")) return "UPDATE";

        return guaranteedAnswer;
      } catch (deepseekError) {
        console.log(
          `[DEEPSEEK API ERROR] Single audit failed: ${deepseekError.message}. Dropping to safe defaults.`,
        );
        return guaranteedAnswer;
      }
    }
  }
}

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
    if (!process.env.GEMINI_API_KEY) throw new Error("No Gemini key found");
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
      `[GEMINI API ERROR] Batch audit failed: ${error.message}. Routing to Groq...`,
    );

    try {
      if (!process.env.GROQ_API_KEY) throw new Error("No Groq key found");
      const response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [{ role: "user", content: prompt }],
          }),
        },
      );

      if (!response.ok) throw new Error(`Groq HTTP Error: ${response.status}`);
      const data = await response.json();
      const rawResponse = data.choices[0].message.content.toUpperCase();

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
    } catch (groqError) {
      console.log(
        `[GROQ API ERROR] Batch audit failed: ${groqError.message}. Routing to DeepSeek...`,
      );

      try {
        if (!process.env.DEEPSEEK_API_KEY)
          throw new Error("No DeepSeek key found");
        const response = await fetch(
          "https://api.deepseek.com/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages: [{ role: "user", content: prompt }],
            }),
          },
        );

        if (!response.ok)
          throw new Error(`DeepSeek HTTP Error: ${response.status}`);
        const data = await response.json();
        const rawResponse = data.choices[0].message.content.toUpperCase();

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
      } catch (deepseekError) {
        console.log(
          `[DEEPSEEK API ERROR] Batch audit request failed: ${deepseekError.message}. Dropping to safe defaults.`,
        );
        return guaranteedAnswers;
      }
    }
  }
}

module.exports = { evaluateResource, evaluateResourcesBatch };
