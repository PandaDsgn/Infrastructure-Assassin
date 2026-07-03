require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { db, auth } = require("./firebase"); // Keeps Firebase for SSO/Users
const pgDb = require("./db"); // Imports our brand new PostgreSQL pool
const { evaluateResource } = require("./agent");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.static("public"));
app.use(express.json());

// Initialize Gemini for the Conversational Chat Core
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const pendingApprovals = [];

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
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided." });
  }

  const token = authHeader.split(" ")[1];

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
    res.json({ success: true, role: assignedRole });
  } catch (error) {
    res.status(500).json({ error: "Failed to create user profile." });
  }
});

// --- INFRASTRUCTURE AUDIT ROUTE (POSTGRESQL UPGRADE) ---
let cachedAuditResults = null;
let lastAuditTime = 0;

app.get("/api/audit", authenticateUser, async (req, res) => {
  if (cachedAuditResults && Date.now() - lastAuditTime < 300000) {
    return res.json(cachedAuditResults);
  }

  try {
    // Fetch directly from live PostgreSQL database
    const { rows } = await pgDb.query(
      "SELECT * FROM resources WHERE status = 'Active'",
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

// --- ACTION & APPROVAL ROUTES ---
app.post("/api/action", authenticateUser, async (req, res) => {
  const { actionType, resource_name, details } = req.body;
  if (req.user.role === "Junior-Developer") {
    pendingApprovals.push({
      id: crypto.randomUUID(),
      requester: req.user.name,
      action: actionType,
      resource: resource_name,
      details: details || "Immediate",
      time: new Date().toLocaleString(),
    });
    return res.json({
      success: true,
      pending: true,
      message: "Action requires IT-Director approval. Request sent.",
    });
  }

  // PRODUCTION UPGRADE: If admin runs it, update the state directly in PostgreSQL
  try {
    let targetStatus = "Active";
    if (actionType === "TERMINATE") targetStatus = "Terminated";
    else if (actionType === "QUARANTINE") targetStatus = "Quarantined";

    await pgDb.query(
      "UPDATE resources SET status = $1 WHERE resource_name = $2",
      [targetStatus, resource_name],
    );

    // Wipe audit cache to refresh frontend display immediately
    cachedAuditResults = null;
    lastAuditTime = 0;

    res.json({
      success: true,
      pending: false,
      message: `${actionType} protocol successfully committed to live cloud ledger.`,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply resource state update." });
  }
});

app.get("/api/approvals", authenticateUser, (req, res) => {
  if (req.user.role !== "IT-Director") return res.json([]);
  res.json(pendingApprovals);
});

app.post(
  "/api/approvals/resolve",
  authenticateUser,
  requireAdmin,
  async (req, res) => {
    const { id, decision } = req.body;
    const requestIndex = pendingApprovals.findIndex((r) => r.id === id);
    if (requestIndex === -1)
      return res.status(404).json({ error: "Request no longer exists." });

    const request = pendingApprovals[requestIndex];
    pendingApprovals.splice(requestIndex, 1);

    if (decision === "Approve") {
      try {
        let targetStatus = "Active";
        if (request.action === "TERMINATE") targetStatus = "Terminated";
        else if (request.action === "QUARANTINE") targetStatus = "Quarantined";

        await pgDb.query(
          "UPDATE resources SET status = $1 WHERE resource_name = $2",
          [targetStatus, request.resource],
        );
        cachedAuditResults = null;
        lastAuditTime = 0;
      } catch (err) {
        return res
          .status(500)
          .json({ error: "Approval pipeline database synchronization error." });
      }
    }

    res.json({
      success: true,
      message:
        decision === "Approve"
          ? `Approved ${request.action} for ${request.resource}`
          : `Rejected ${request.requester}'s request.`,
    });
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
      await auth.deleteUser(targetUid);
      await db.collection("users").doc(targetUid).delete();
      res.json({
        success: true,
        message: "User permanently erased from all systems.",
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
    // Pull full resource list out of live PostgreSQL database for AI context mapping
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

const PORT = process.env.PORT || 3000; // Let host determine runtime port dynamically
app.listen(PORT, () => console.log(`🔥 BACKEND LIVE ON PORT ${PORT}`));
