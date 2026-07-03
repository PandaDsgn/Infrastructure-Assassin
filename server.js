require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { db, auth } = require("./firebase");
const pgDb = require("./db");
const { evaluateResource } = require("./agent");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.static("public"));
app.use(express.json());

// Initialize Gemini for the Conversational Chat Core
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- PUBLIC CONFIG ENDPOINT ---
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

// --- SECURE FIREBASE MIDDLEWARE ---
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query && req.query.token) {
    // Fallback for connections that can't set custom headers - specifically
    // native EventSource (used for /api/events), which has no way to send
    // an Authorization header. Every other route keeps using the header.
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

// --- REAL-TIME EVENT STREAM (SERVER-SENT EVENTS) ---
// Keeps a live, push-based channel open to every connected dashboard so that
// resource/approval/personnel changes appear instantly without any client
// having to poll or reload the page.
let sseClients = []; // [{ uid, role, res }]

// Pushes an already-built payload to every client connected to THIS
// instance. This is called from two places: (1) below, kept for symmetry/
// direct local testing, and (2) the pgDb realtime bus callback registered at
// startup, which fires whenever ANY instance publishes an event - including
// this one. That's what makes the broadcast reach every replica instead of
// just whichever process happened to handle the originating request.
function pushToLocalClients(payload) {
  const message = JSON.stringify(payload);
  sseClients.forEach((client) => {
    try {
      client.res.write(`data: ${message}\n\n`);
    } catch (err) {
      // Dead connection - it will be cleaned up by the client's 'close' handler.
    }
  });
}

// Fire-and-forget: publishes to Postgres NOTIFY so every instance (this one
// included, via the LISTEN subscription below) pushes it to its local SSE
// clients. Callers keep using broadcastEvent(type, data) exactly as before.
function broadcastEvent(type, data = {}) {
  pgDb.publishRealtimeEvent(type, data).catch((err) => {
    console.error(`[REALTIME BUS] Failed to publish "${type}":`, err.message);
    // Fall back to at least notifying this instance's own clients so the
    // person who triggered the action still sees it update.
    pushToLocalClients({ type, data, timestamp: Date.now() });
  });
}

// Subscribe this instance to the shared bus. Every event published by any
// instance (via broadcastEvent -> publishRealtimeEvent) arrives here and
// gets fanned out to whatever SSE clients happen to be connected locally.
pgDb.initRealtimeBus(pushToLocalClients).catch((err) => {
  console.error("[REALTIME BUS] Failed to initialize:", err.message);
});

app.get("/api/events", authenticateUser, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable buffering on reverse proxies (e.g. nginx)
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  const client = { uid: req.user.uid, role: req.user.role, res };
  sseClients.push(client);

  // Heartbeat prevents idle-timeout disconnects on load balancers/proxies.
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

// --- IDENTITY & REGISTRATION ENDPOINTS ---
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

// --- INFRASTRUCTURE AUDIT ROUTE ---
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

    const auditedResources = [];
    for (let i = 0; i < rows.length; i++) {
      const action = await evaluateResource(rows[i]);
      auditedResources.push({ ...rows[i], recommended_action: action });
    }

    cachedAuditResults = auditedResources;
    lastAuditTime = Date.now();
    res.json(auditedResources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- RBAC ACTION & APPROVAL ROUTES ---

// Single source of truth for what each action type resolves to. Used both
// when an Admin applies an action directly and when an Admin approves a
// Developer's pending request, so the two paths can never drift apart.
function resolveTargetStatus(actionType) {
  if (actionType === "TERMINATE") return "Terminated";
  if (actionType === "QUARANTINE") return "Quarantined";
  if (actionType === "UPDATE") return "Updated";
  if (actionType === "KEEP") return "Kept Active";
  return "Active";
}

app.post("/api/action", authenticateUser, async (req, res) => {
  const { actionType, resource_name } = req.body;

  try {
    if (req.user.role === "Junior-Developer") {
      await pgDb.query(
        "UPDATE resources SET status = 'Pending Approval', pending_action_by = $1, pending_action_type = $2 WHERE resource_name = $3",
        [req.user.name, actionType, resource_name],
      );

      cachedAuditResults = null;
      lastAuditTime = 0;

      // Push this immediately to every connected dashboard (esp. Admins)
      // so the pending request shows up in real time.
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

// Route to drop a developer's request from the queue completely
app.post("/api/action/cancel-request", authenticateUser, async (req, res) => {
  const { resource_name } = req.body;
  try {
    await pgDb.query(
      "UPDATE resources SET status = 'Active', pending_action_by = NULL, pending_action_type = NULL WHERE resource_name = $1",
      [resource_name],
    );
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
    const { rows } = await pgDb.query(
      "SELECT * FROM resources WHERE status = 'Pending Approval'",
    );
    const pendingRequests = rows.map((row) => ({
      id: row.id,
      requester: row.pending_action_by,
      action: row.pending_action_type || "UNKNOWN",
      resource: row.resource_name,
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
        "SELECT pending_action_type, resource_name FROM resources WHERE id = $1",
        [id],
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: "Request not found." });
      }
      const requestedAction = rows[0].pending_action_type;

      let finalStatus;
      let message;

      if (decision === "Approve") {
        // Apply whatever the developer actually asked for - Keep, Update,
        // Quarantine, or Terminate - not a hardcoded outcome.
        finalStatus = resolveTargetStatus(requestedAction);
        message = `Approved. ${requestedAction || "Requested action"} applied to ${rows[0].resource_name}.`;
      } else {
        finalStatus = "Active";
        message = "Rejected user request.";
      }

      await pgDb.query(
        "UPDATE resources SET status = $1, pending_action_by = NULL, pending_action_type = NULL WHERE id = $2",
        [finalStatus, id],
      );

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

// --- ADMIN USER MANAGEMENT ROUTES ---
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
      // 1. Fetch user snapshot profile from Firestore to inspect authority rank
      const userRef = db.collection("users").doc(targetUid);
      const doc = await userRef.get();

      // If the target is an IT Director, block the action completely
      if (doc.exists && doc.data().role === "IT-Director") {
        return res.status(403).json({
          error:
            "ACCESS DENIED: IT Directors cannot terminate other IT Directors.",
        });
      }

      // 2. Fall through to clear Junior Developer instances if safe
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

// --- CONVERSATIONAL AI ---
let chatHistory = [];
let lastResourceContext = null;

app.post("/api/chat", authenticateUser, async (req, res) => {
  const userMessage = req.body.message;
  chatHistory.push(`User: ${userMessage}`);
  if (chatHistory.length > 6) chatHistory.shift();

  try {
    const { rows } = await pgDb.query("SELECT * FROM resources");

    const prompt = `You are "Infrastructure Assassin", an enterprise IT security AI.
        Talking to ${req.user.name} (Role: ${req.user.role}).
        Infrastructure Data: ${JSON.stringify(rows)}
        Recent Context: ${chatHistory.join("\n")}

        RULES:
        1. Never execute actions.
        2. Tell the user to use dashboard buttons.
        3. If Junior-Developer, remind them it requires approval.

        Respond to: "${userMessage}"`;

    const result = await chatModel.generateContent(prompt);
    const finalReply = result.response.text().trim();

    chatHistory.push(`Assassin AI: ${finalReply}`);
    return res.json({ reply: finalReply });
  } catch (error) {
    console.error("[GEMINI UNAVAILABLE]: Routing to Tier-2 Local NLP Engine.");

    const msg = userMessage.toLowerCase();
    if (msg.includes("figma")) lastResourceContext = "figma";
    else if (msg.includes("vpn") || msg.includes("freevpn"))
      lastResourceContext = "vpn";
    else if (msg.includes("datadog")) lastResourceContext = "datadog";
    else if (msg.includes("gitlab")) lastResourceContext = "gitlab";
    else if (msg.includes("aws") || msg.includes("ec2"))
      lastResourceContext = "aws";

    let localReply =
      "Neural Link offline. Operating via local metrics: You have ₹970 in potential savings identified.";

    if (lastResourceContext === "figma")
      localReply =
        "Figma Enterprise has been flagged to TERMINATE. It costs ₹120/month but hasn't been accessed in 45 days.";
    else if (lastResourceContext === "vpn")
      localReply =
        "CRITICAL ALERT: FreeVPN_Crack.exe has been flagged as malicious. Immediate QUARANTINE recommended.";
    else if (lastResourceContext === "datadog")
      localReply =
        "Datadog Test Environment is secure. It is actively used. Recommendation: KEEP.";
    else if (lastResourceContext === "gitlab")
      localReply =
        "GitLab Runner (v14.1) requires a critical security patch. Recommendation: UPDATE.";
    else if (lastResourceContext === "aws")
      localReply =
        "AWS EC2 Production is secure and active. Recommendation: KEEP.";

    chatHistory.push(`Assassin AI: ${localReply}`);
    return res.json({ reply: localReply });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🔥 BACKEND LIVE ON PORT ${PORT}`));
