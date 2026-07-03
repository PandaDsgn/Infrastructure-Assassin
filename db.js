// db.js
const { Pool } = require("pg");
require("dotenv").config();

// Determine if we are running in the cloud or local development
const isProduction = process.env.NODE_ENV === "production";

// Configure connection options using secrets injected by the cloud provider
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

// Replicate the enterprise table creation structure safely
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
        status TEXT
      )
    `);

    // Verify if database needs mock data seed (only if table is empty)
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

// Initialize schema on backend startup
initDb();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
