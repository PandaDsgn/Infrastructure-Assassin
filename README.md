## Role-Based Access Control (Mock SSO Integration)

This application simulates an Enterprise Single Sign-On (SSO) environment with Identity Provider token handling. The backend is protected by middleware that enforces Role-Based Access Control (RBAC).

To test the security restrictions, use the following mock credentials:

**IT Director (Full Access)**
- **Email:** `rachel.green@gmail.com`
- **Password:** `admin`
- *Expected Behavior:* Dashboard unlocks, AI auditing begins, termination execution pipelines are accessible.

**Junior Developer (Restricted Access)**
- **Email:** `ross.geller@gmail.com`
- **Password:** `dev`
- *Expected Behavior:* Login succeeds, but backend API explicitly denies access to the dashboard (`403 Forbidden`).

# Infrastructure Assassin 

An automated, full-stack enterprise IT security and cost-optimization dashboard. This platform leverages local Large Language Models (LLMs) to audit infrastructure, identify idle/malicious software, and execute zero-trust security protocols.

## System Architecture
This project is built with a resilient, decoupled architecture to ensure high availability and data privacy:
* **Frontend:** Vanilla HTML/CSS/JS with reactive UI and dark-mode integration.
* **Backend:** Node.js / Express server managing secure API routes and SQLite database queries.
* **Primary AI Engine:** Offline, zero-latency inference using Meta's **Llama 3.2** via local Ollama endpoint.
* **Fallback NLP Engine:** Custom deterministic matrix to ensure 100% uptime if the neural engine fails.

## Key Features
* **Role-Based Access Control (RBAC):** Simulated SSO environment. Junior Developers can only *request* security actions, while IT Directors maintain execution authority via a secure Admin Inbox.
* **Two-Tiered AI Fallback:** Seamlessly shifts from generative AI analysis to a hardcoded local NLP matrix if network timeouts or hardware limits are reached.
* **Context-Aware Chat:** Built-in neural chat interface that maintains conversation history and context for active infrastructure debugging.

## Local Installation Guide

1. **Install Dependencies:**
   ```bash
   npm install express cors sqlite3
