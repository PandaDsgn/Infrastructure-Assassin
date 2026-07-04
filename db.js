const { Pool, Client } = require("pg");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS resources (
        id SERIAL PRIMARY KEY,
        employee_name TEXT,
        resource_type TEXT,
        resource_name TEXT,
        monthly_cost INTEGER,
        install_date TEXT,
        days_since_last_login INTEGER,
        is_malicious BOOLEAN,
        needs_update BOOLEAN,
        status TEXT,
        pending_action_by TEXT DEFAULT NULL,
        pending_action_type TEXT DEFAULT NULL
      )
    `);

    await client.query(`
      ALTER TABLE resources
      ADD COLUMN IF NOT EXISTS pending_action_type TEXT DEFAULT NULL
    `);

    await client.query(`
      ALTER TABLE resources
      ADD COLUMN IF NOT EXISTS pending_log_id INTEGER DEFAULT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS request_log (
        id SERIAL PRIMARY KEY,
        resource_name TEXT,
        requester_uid TEXT,
        requester_name TEXT,
        action_type TEXT,
        status TEXT DEFAULT 'Pending',
        requested_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by TEXT
      )
    `);

    const res = await client.query("SELECT COUNT(*) AS count FROM resources");
    if (parseInt(res.rows[0].count) === 0) {
      console.log(
        "Seeding production ledger database with initial enterprise data...",
      );

      const insertQuery = `
        INSERT INTO resources (employee_name, resource_type, resource_name, monthly_cost, install_date, days_since_last_login, is_malicious, needs_update, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `;

      await client.query(insertQuery, [
        "Alice Smith",
        "SaaS",
        "Figma Enterprise",
        120,
        "2025-11-01",
        45,
        false,
        false,
        "Active",
      ]);
      await client.query(insertQuery, [
        "Bob Jones",
        "Server",
        "AWS EC2 Production",
        450,
        "2024-03-15",
        1,
        false,
        false,
        "Active",
      ]);
      await client.query(insertQuery, [
        "Charlie Davis",
        "Software",
        "FreeVPN_Crack.exe",
        0,
        "2026-05-20",
        2,
        true,
        false,
        "Active",
      ]);
      await client.query(insertQuery, [
        "Diana Prince",
        "SaaS",
        "GitLab Runner (v14.1)",
        85,
        "2023-08-10",
        5,
        false,
        true,
        "Active",
      ]);
      await client.query(insertQuery, [
        "Evan Wright",
        "Cloud",
        "Datadog Test Environment",
        850,
        "2026-01-12",
        60,
        false,
        false,
        "Active",
      ]);

      console.log("Database seeded successfully.");
    }
  } catch (err) {
    console.error("Error executing database setup script:", err.stack);
  } finally {
    client.release();
  }
};

initDb();

let listenerClient = null;
let realtimeCallback = null;

async function initRealtimeBus(onEvent) {
  realtimeCallback = onEvent;

  listenerClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  });

  listenerClient.on("error", (err) => {
    console.error(
      `[REALTIME BUS] Listener connection dropped: ${err.message}. Reconnecting in 2s...`,
    );
    setTimeout(() => initRealtimeBus(realtimeCallback), 2000);
  });

  listenerClient.on("notification", (msg) => {
    if (msg.channel !== "realtime_events") return;
    try {
      const payload = JSON.parse(msg.payload);
      realtimeCallback && realtimeCallback(payload);
    } catch (err) {
      console.error(
        "[REALTIME BUS] Failed to parse notification:",
        err.message,
      );
    }
  });

  await listenerClient.connect();
  await listenerClient.query("LISTEN realtime_events");
  console.log("📡 Realtime bus connected - LISTEN realtime_events");
}

async function publishRealtimeEvent(type, data = {}) {
  const payload = JSON.stringify({ type, data, timestamp: Date.now() });

  await pool.query("SELECT pg_notify('realtime_events', $1)", [payload]);
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  initRealtimeBus,
  publishRealtimeEvent,
};
