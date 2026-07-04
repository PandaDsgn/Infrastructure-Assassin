require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { db, auth } = require("./firebase");
const pgDb = require("./db");
const { evaluateResource, evaluateResourcesBatch } = require("./agent");

const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.static("public"));
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error(
    "[STARTUP WARNING] GEMINI_API_KEY is not set in this environment - " +
      "every /api/chat request will fail and fall back to the local NLP " +
      "engine. Set it as a real environment variable/secret on the host " +
      "(a .env file is not copied into the Docker image and most hosts " +
      "don't read it in production).",
  );
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const CHAT_MODEL_NAME = "gemini-2.5-flash";

app.get("/api/config", (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
  });
});

async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "No authorization token provided." });
  }

  try {
    const decodedToken = await auth.verifyIdToken(token);
    const userDoc = await db.collection("users").doc(decodedToken.uid).get();

    let role = "Junior-Developer";
    let name = decodedToken.email.split("@")[0];

    if (userDoc.exists) {
      const userData = userDoc.data();
      role = userData.role || role;
      name = userData.name || name;
    }

    req.user = { uid: decodedToken.uid, email: decodedToken.email, name, role };
    next();
  } catch (error) {
    console.error("[AUTH ERROR] Token verification failed:", error.message);
    return res.status(401).json({ error: "Session expired or invalid." });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "IT-Director")
    return res.status(403).json({ error: "Admin clearance required." });
  next();
}

let sseClients = [];

function pushToLocalClients(payload) {
  const message = JSON.stringify(payload);
  sseClients.forEach((client) => {
    try {
      client.res.write(`data: ${message}\n\n`);
    } catch (err) {}
  });
}

function broadcastEvent(type, data = {}) {
  pgDb.publishRealtimeEvent(type, data).catch((err) => {
    console.error(`[REALTIME BUS] Failed to publish "${type}":`, err.message);
    pushToLocalClients({ type, data, timestamp: Date.now() });
  });
}

pgDb.initRealtimeBus(pushToLocalClients).catch((err) => {
  console.error("[REALTIME BUS] Failed to initialize:", err.message);
});

app.get("/api/events", authenticateUser, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  const client = { uid: req.user.uid, role: req.user.role, res };
  sseClients.push(client);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter((c) => c !== client);
  });
});

app.get("/api/auth/me", authenticateUser, (req, res) => {
  res.json({ name: req.user.name, role: req.user.role, email: req.user.email });
});

app.post("/api/auth/register", authenticateUser, async (req, res) => {
  const { name, inviteCode } = req.body;
  const uid = req.user.uid;

  const SECRET_CODE = process.env.ADMIN_INVITE_CODE || "aegis-admin";
  const assignedRole =
    inviteCode === SECRET_CODE ? "IT-Director" : "Junior-Developer";

  try {
    await db
      .collection("users")
      .doc(uid)
      .set({
        name: name || req.user.email.split("@")[0],
        role: assignedRole,
        email: req.user.email,
      });
    broadcastEvent("user_registered", { uid, role: assignedRole });
    res.json({ success: true, role: assignedRole });
  } catch (error) {
    res.status(500).json({ error: "Failed to create user profile." });
  }
});

let cachedAuditResults = null;
let lastAuditTime = 0;

app.get("/api/audit", authenticateUser, async (req, res) => {
  if (cachedAuditResults && Date.now() - lastAuditTime < 300000) {
    return res.json(cachedAuditResults);
  }

  try {
    const { rows } = await pgDb.query(
      "SELECT * FROM resources WHERE status = 'Active' OR status = 'Pending Approval'",
    );

    const actions = await evaluateResourcesBatch(rows);
    const auditedResources = rows.map((row, i) => ({
      ...row,
      recommended_action: actions[i],
    }));

    cachedAuditResults = auditedResources;
    lastAuditTime = Date.now();
    res.json(auditedResources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function resolveTargetStatus(actionType) {
  if (actionType === "TERMINATE") return "Terminated";
  if (actionType === "QUARANTINE") return "Quarantined";
  if (actionType === "UPDATE") return "Updated";
  if (actionType === "KEEP") return "Kept Active";
  return "Active";
}

app.post("/api/action", authenticateUser, async (req, res) => {
  const { actionType, resource_name } = req.body;

  const { rows } = await pgDb.query(
    "SELECT status FROM resources WHERE resource_name = $1",
    [resource_name],
  );

  if (rows[0] && rows[0].status === "Pending Approval") {
    return res.status(409).json({ error: "Request already in progress." });
  }

  try {
    if (req.user.role === "Junior-Developer") {
      const logResult = await pgDb.query(
        `INSERT INTO request_log (resource_name, requester_uid, requester_name, action_type, status)
         VALUES ($1, $2, $3, $4, 'Pending') RETURNING id`,
        [resource_name, req.user.uid, req.user.name, actionType],
      );
      const logId = logResult.rows[0].id;

      await pgDb.query(
        "UPDATE resources SET status = 'Pending Approval', pending_action_by = $1, pending_action_type = $2, pending_log_id = $3 WHERE resource_name = $4",
        [req.user.name, actionType, logId, resource_name],
      );

      cachedAuditResults = null;
      lastAuditTime = 0;

      broadcastEvent("resource_pending", {
        resource_name,
        requester: req.user.name,
        actionType,
      });

      return res.json({
        success: true,
        pending: true,
        message: `${actionType} request routed to Admin control queue.`,
      });
    }

    let targetStatus = resolveTargetStatus(actionType);

    await pgDb.query(
      "UPDATE resources SET status = $1, pending_action_by = NULL, pending_action_type = NULL WHERE resource_name = $2",
      [targetStatus, resource_name],
    );

    cachedAuditResults = null;
    lastAuditTime = 0;

    broadcastEvent("resource_updated", {
      resource_name,
      status: targetStatus,
      actor: req.user.name,
    });

    res.json({
      success: true,
      pending: false,
      message: `${actionType} protocol successfully committed to cloud ledger.`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply resource state update." });
  }
});

app.post("/api/action/cancel-request", authenticateUser, async (req, res) => {
  const { resource_name } = req.body;
  try {
    const { rows } = await pgDb.query(
      "SELECT pending_log_id FROM resources WHERE resource_name = $1",
      [resource_name],
    );
    const logId = rows[0] && rows[0].pending_log_id;

    await pgDb.query(
      "UPDATE resources SET status = 'Active', pending_action_by = NULL, pending_action_type = NULL, pending_log_id = NULL WHERE resource_name = $1",
      [resource_name],
    );

    if (logId) {
      await pgDb.query(
        "UPDATE request_log SET status = 'Cancelled', resolved_at = NOW(), resolved_by = $1 WHERE id = $2",
        [req.user.name, logId],
      );
    }

    cachedAuditResults = null;
    lastAuditTime = 0;
    broadcastEvent("resource_cancelled", {
      resource_name,
      actor: req.user.name,
    });
    res.json({ success: true, message: "Request discarded cleanly." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/approvals", authenticateUser, async (req, res) => {
  if (req.user.role !== "IT-Director") return res.json([]);

  try {
    const { rows } = await pgDb.query(`
      SELECT r.*, rl.requested_at
      FROM resources r
      LEFT JOIN request_log rl ON rl.id = r.pending_log_id
      WHERE r.status = 'Pending Approval'
    `);
    const pendingRequests = rows.map((row) => ({
      id: row.id,
      requester: row.pending_action_by,
      action: row.pending_action_type || "UNKNOWN",
      resource: row.resource_name,
      requested_at: row.requested_at,
    }));
    res.json(pendingRequests);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch approvals." });
  }
});

app.post(
  "/api/approvals/resolve",
  authenticateUser,
  requireAdmin,
  async (req, res) => {
    const { id, decision } = req.body;

    try {
      const { rows } = await pgDb.query(
        "SELECT pending_action_type, resource_name, pending_log_id FROM resources WHERE id = $1",
        [id],
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Request not found." });
      }
      const requestedAction = rows[0].pending_action_type;
      const logId = rows[0].pending_log_id;

      let finalStatus;
      let message;

      if (decision === "Approve") {
        finalStatus = resolveTargetStatus(requestedAction);
        message = `Approved. ${requestedAction || "Requested action"} applied to ${rows[0].resource_name}.`;
      } else {
        finalStatus = "Active";
        message = "Rejected user request.";
      }

      await pgDb.query(
        "UPDATE resources SET status = $1, pending_action_by = NULL, pending_action_type = NULL, pending_log_id = NULL WHERE id = $2",
        [finalStatus, id],
      );

      if (logId) {
        await pgDb.query(
          "UPDATE request_log SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3",
          [
            decision === "Approve" ? "Approved" : "Rejected",
            req.user.name,
            logId,
          ],
        );
      }

      cachedAuditResults = null;
      lastAuditTime = 0;

      broadcastEvent("approval_resolved", {
        id,
        decision,
        requestedAction,
        finalStatus,
      });

      res.json({ success: true, message });
    } catch (err) {
      res
        .status(500)
        .json({ error: "Approval pipeline database synchronization error." });
    }
  },
);

app.get("/api/requests/outgoing", authenticateUser, async (req, res) => {
  try {
    const { rows } = await pgDb.query(
      `SELECT id, resource_name, action_type, status, requested_at, resolved_at, resolved_by
       FROM request_log
       WHERE requester_uid = $1
       ORDER BY requested_at DESC
       LIMIT 100`,
      [req.user.uid],
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch outgoing requests." });
  }
});

app.get("/api/users", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const users = [];
    snapshot.forEach((doc) => {
      if (doc.id !== req.user.uid) {
        users.push({ uid: doc.id, ...doc.data() });
      }
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

app.delete(
  "/api/users/:targetUid",
  authenticateUser,
  requireAdmin,
  async (req, res) => {
    const { targetUid } = req.params;
    try {
      const userRef = db.collection("users").doc(targetUid);
      const doc = await userRef.get();

      if (doc.exists && doc.data().role === "IT-Director") {
        return res.status(403).json({
          error:
            "ACCESS DENIED: IT Directors cannot terminate other IT Directors.",
        });
      }

      await auth.deleteUser(targetUid);
      await userRef.delete();

      broadcastEvent("user_removed", { targetUid, actor: req.user.name });

      res.json({
        success: true,
        message: "Personnel permanently erased from all systems.",
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to completely delete user." });
    }
  },
);

let activeUserTiers = {};
let chatHistories = {};
const MAX_CHAT_HISTORY = 6;

app.post("/api/chat", authenticateUser, async (req, res) => {
  const userMessage = req.body.message.trim();
  const userId = req.user.uid;

  if (!chatHistories[userId]) {
    chatHistories[userId] = [];
  }

  if (!activeUserTiers[userId]) {
    activeUserTiers[userId] = "auto";
  }

  const commandMsg = userMessage.toLowerCase();
  if (commandMsg.startsWith("/use ")) {
    const target = commandMsg.replace("/use ", "").trim();

    if (["gemini", "groq", "deepseek", "auto"].includes(target)) {
      activeUserTiers[userId] = target;

      const targetDisplay =
        target === "auto" ? "Default Waterfall Cascade" : target.toUpperCase();
      const confirmationReply = `Routing preference updated. System is now locked to: **${targetDisplay}**.`;

      chatHistories[userId].push(`System: Locked to ${target}`);
      if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
        chatHistories[userId].shift();
      }
      return res.json({ reply: confirmationReply, source: `System Override` });
    } else {
      return res.json({
        reply: `Unknown target. Please use: \`/use gemini\`, \`/use groq\`, \`/use deepseek\`, or \`/use auto\`.`,
        source: `System Error`,
      });
    }
  }

  chatHistories[userId].push(`User: ${userMessage}`);
  if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
    chatHistories[userId].shift();
  }

  let rows = [];
  try {
    const dbResult = await pgDb.query("SELECT * FROM resources");
    rows = dbResult.rows;
  } catch (dbErr) {
    return res
      .status(500)
      .json({ error: "Failed to read database for context." });
  }

  const systemPrompt = `You are "Infrastructure Assassin", an enterprise IT security AI.
        Talking to ${req.user.name} (Role: ${req.user.role}).
        Infrastructure Data: ${JSON.stringify(rows)}
        Recent Context: ${chatHistories[userId].join("\n")}

        RULES:
        1. Never execute actions.
        2. Tell the user to use dashboard buttons.
        3. If Junior-Developer, remind them it requires approval.`;

  const userPreference = activeUserTiers[userId];

  if (userPreference === "auto" || userPreference === "gemini") {
    try {
      if (!process.env.GEMINI_API_KEY) throw new Error("No Gemini key found");
      const result = await ai.models.generateContent({
        model: CHAT_MODEL_NAME,
        contents: `${systemPrompt}\n\nRespond to: "${userMessage}"`,
      });
      const finalReply = result.text.trim();
      chatHistories[userId].push(`Assassin AI: ${finalReply}`);
      if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
        chatHistories[userId].shift();
      }
      return res.json({ reply: finalReply, source: "Gemini (Tier 1)" });
    } catch (err) {
      console.warn(`[GEMINI FAILED] ${err.message}.`);
      if (userPreference === "gemini") {
        return res.json({
          reply: `[Gemini Error] Quota exhausted or API unavailable.`,
          source: "System Error",
        });
      }
    }
  }

  if (userPreference === "auto" || userPreference === "groq") {
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
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
          }),
        },
      );

      if (!response.ok) {
        const errorDetails = await response.text();
        throw new Error(`Groq rejected payload: ${errorDetails}`);
      }

      const data = await response.json();
      const finalReply = data.choices[0].message.content.trim();
      chatHistories[userId].push(`Assassin AI: ${finalReply}`);
      if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
        chatHistories[userId].shift();
      }
      return res.json({
        reply: finalReply,
        source: "Groq (Tier 2)",
      });
    } catch (err) {
      console.warn(`[GROQ FAILED] ${err.message}.`);
      if (userPreference === "groq") {
        return res.json({
          reply: `[Groq Error] API unavailable.`,
          source: "System Error",
        });
      }
    }
  }

  if (userPreference === "auto" || userPreference === "deepseek") {
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
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userMessage },
            ],
          }),
        },
      );

      if (!response.ok) {
        const errorDetails = await response.text();
        throw new Error(`DeepSeek rejected payload: ${errorDetails}`);
      }

      const data = await response.json();
      const finalReply = data.choices[0].message.content.trim();
      chatHistories[userId].push(`Assassin AI: ${finalReply}`);
      if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
        chatHistories[userId].shift();
      }
      return res.json({ reply: finalReply, source: "DeepSeek (Tier 3)" });
    } catch (err) {
      console.warn(`[DEEPSEEK FAILED] ${err.message}.`);
      if (userPreference === "deepseek") {
        return res.json({
          reply: `[DeepSeek Error] API unavailable.`,
          source: "System Error",
        });
      }
    }
  }

  const msg = userMessage.toLowerCase();
  let localReply = "";
  let dynamicSavings = 0;

  rows.forEach((r) => {
    if (
      (r.status === "Active" || r.status === "Pending Approval") &&
      (r.days_since_last_login >= 30 || r.is_malicious)
    ) {
      dynamicSavings += Number(r.monthly_cost) || 0;
    }
  });

  const words = msg.split(/\s+/).filter((w) => w.length > 2);
  const mentionedResource = rows.find((r) =>
    words.some((word) => r.resource_name.toLowerCase().includes(word)),
  );

  const isAskingCost = msg.match(/(cost|spend|sav|money|budget|summary)/);
  const isAskingTerminate = msg.match(
    /(terminat|delete|remove|kill|idle|unused)/,
  );
  const isAskingQuarantine = msg.match(
    /(quarantin|quanrantin|malicious|virus|malware|threat|hack)/,
  );
  const isAskingUpdate = msg.match(/(updat|patch|upgrad|outdated)/);

  if (mentionedResource) {
    const name = mentionedResource.resource_name;
    const cost = mentionedResource.monthly_cost;
    const idle = mentionedResource.days_since_last_login;

    if (mentionedResource.is_malicious) {
      localReply = `CRITICAL ALERT: ${name} is flagged as malicious. Immediate QUARANTINE recommended. (Cost: ₹${cost}/mo)`;
    } else if (idle >= 30) {
      localReply = `${name} should be TERMINATED. It costs ₹${cost}/mo and has been idle for ${idle} days.`;
    } else if (mentionedResource.needs_update) {
      localReply = `${name} requires a critical security patch. Recommendation: UPDATE.`;
    } else {
      localReply = `${name} is secure and active (Idle: ${idle} days). Recommendation: KEEP.`;
    }
  } else if (isAskingQuarantine) {
    const targets = rows
      .filter((r) => r.is_malicious)
      .map((r) => r.resource_name);
    localReply = targets.length
      ? `URGENT: The following resources are malicious and must be QUARANTINED: ${targets.join(", ")}.`
      : `No active malicious threats detected.`;
  } else if (isAskingTerminate) {
    const targets = rows
      .filter((r) => !r.is_malicious && r.days_since_last_login >= 30)
      .map((r) => r.resource_name);
    localReply = targets.length
      ? `Based on telemetry, these idle resources should be TERMINATED: ${targets.join(", ")}.`
      : `No resources are currently flagged for termination based on idle time.`;
  } else if (isAskingUpdate) {
    const targets = rows
      .filter((r) => r.needs_update && !r.is_malicious)
      .map((r) => r.resource_name);
    localReply = targets.length
      ? `These resources require critical patches (UPDATE): ${targets.join(", ")}.`
      : `All active applications are up to date.`;
  } else if (isAskingCost) {
    localReply = `Local metrics report: You have ₹${dynamicSavings.toLocaleString("en-IN")} in potential savings identified. Focus on Quarantining malicious apps and Terminating idle resources to realize this.`;
  } else {
    localReply = `Neural Link offline. I am operating on local heuristics. You can ask me about costs, threats (quarantine), idle resources (terminate), or type the name of a specific application in the ledger.`;
  }

  chatHistories[userId].push(`Assassin AI: ${localReply}`);
  if (chatHistories[userId].length > MAX_CHAT_HISTORY) {
    chatHistories[userId].shift();
  }
  return res.json({ reply: localReply, source: "Heuristics (Tier 4)" });
});

app.get("/api/chat/history", authenticateUser, (req, res) => {
  res.json(chatHistories[req.user.uid] || []);
});

app.post("/api/chat/clear", authenticateUser, (req, res) => {
  const userId = req.user.uid;
  if (chatHistories[userId]) {
    delete chatHistories[userId];
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 BACKEND LIVE ON PORT ${PORT}`));
