# 🗡️ Infrastructure Assassin

**Automated IT Cost & Security Optimization Ledger**

Infrastructure Assassin is a role-based, real-time enterprise dashboard designed to monitor cloud resources, identify idle/wasted spend, and quarantine malicious threats. It features a robust Role-Based Access Control (RBAC) system, real-time asynchronous state syncing, and a highly resilient 4-tier AI conversational agent.

---

## ✨ Key Features

* **Role-Based Access Control (RBAC):**
* **IT-Directors** have full clearance to approve/reject requests and instantly terminate/quarantine infrastructure or rogue users.
* **Junior-Developers** can only *request* actions, which routes them into a live approval queue for the Director.


* **4-Tier AI Agent Cascade:** A conversational interface and background auditing tool that gracefully falls back to ensure 100% uptime:
* *Tier 1:* Google Gemini (Primary Core)
* *Tier 2:* Groq / Llama 3.1 (Fast Open-Source Cloud)
* *Tier 3:* DeepSeek (Cost-Effective Fallback)
* *Tier 4:* Local Heuristics Engine (Zero-API mathematical safety net)


* **Prompt-Based Model Overrides:** Users can manually lock the AI agent to a specific model using chat commands (`/use groq`, `/use deepseek`, `/use gemini`, or `/use auto`).
* **Real-Time Bus (SSE + Postgres NOTIFY):** Dashboard updates, inbox notifications, and infrastructure statuses are pushed instantly to all connected clients across multiple server instances using Server-Sent Events and PostgreSQL's native pub/sub channels.
* **Action Timers:** Actions (Keep, Update, Quarantine, Terminate) feature a built-in safety lifecycle, allowing users to "Undo" a dispatched action before it commits to the cloud ledger.
* **Dark/Light Mode:** Full CSS variable-driven UI with a seamless "Evening Mode" toggle.

---

## 🏗️ Architecture & Tech Stack

* **Frontend:** Vanilla JavaScript, HTML5, CSS3 (Zero build-step, raw DOM manipulation).
* **Backend:** Node.js, Express.js.
* **Database:** PostgreSQL (with `pg` module).
* **Authentication:** Firebase Auth (Client SDK for SSO, Admin SDK for backend verification).
* **Containerization:** Docker (`node:22-alpine`).

---

## 🚀 Environment Variables

To run this project locally or in the cloud (e.g., Render), you must provide the following environment variables in a `.env` file or your host's secret manager:

### Database & Auth

```env
# PostgreSQL connection string
DATABASE_URL=postgres://user:password@hostname:5432/dbname

# The secret phrase used during signup to grant the IT-Director role
ADMIN_INVITE_CODE=aegis-admin

# Firebase Admin Service Account (JSON stringified for cloud deployment)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"..."}

# Frontend Firebase Configuration
FIREBASE_API_KEY=your_api_key
FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789
FIREBASE_APP_ID=1:1234:web:abcd

```

### AI API Keys

The system will automatically skip any missing keys and fall down to the next available tier.

```env
GEMINI_API_KEY=your_gemini_key
GROQ_API_KEY=gsk_your_groq_key
DEEPSEEK_API_KEY=your_deepseek_key

```

---

## 🛠️ Local Setup & Deployment

### Running via Docker (Recommended)

This project is fully containerized for Node 22.

1. Clone the repository and navigate to the root directory.
2. Build the Docker image:
```bash
docker build -t infra-assassin .

```


3. Run the container, passing in your environment variables file:
```bash
docker run --env-file .env -p 3000:3000 infra-assassin

```



### Running Locally (Without Docker)

1. Ensure you have **Node.js v18+** installed (required for native `fetch`).
2. Install production dependencies:
```bash
npm install --production

```


3. Start the server:
```bash
node server.js

```



### Database Seeding

You do not need to run manual SQL scripts. On the very first boot, if the backend detects an empty `resources` table, `db.js` will automatically execute a setup script to build the required tables (`resources`, `request_log`) and inject a mock dataset of enterprise telemetry to populate the dashboard.

---

## 💬 AI Chat Commands

The chat widget features an intelligent interceptor. Users can type the following commands directly into the chat box to alter the backend execution flow:

* `/use gemini` - Locks the conversational engine to Tier 1.
* `/use groq` - Locks the conversational engine to Tier 2 (Llama 3.1).
* `/use deepseek` - Locks the conversational engine to Tier 3.
* `/use auto` - Restores the default cascading waterfall logic.
