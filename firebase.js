require("dotenv").config();

// 1. Modern Firebase Admin Modular Imports
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

let credentialConfig;

// 2. Determine environment and load credentials safely
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // CLOUD PRODUCTION: Parse the JSON string injected by the cloud provider's secrets manager
  try {
    const serviceAccountConfig = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT,
    );
    credentialConfig = cert(serviceAccountConfig);
    console.log(
      "🔥 Firebase initialized via secure cloud environment variable.",
    );
  } catch (error) {
    console.error(
      "CRITICAL: Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable.",
      error,
    );
    process.exit(1);
  }
} else {
  // LOCAL DEVELOPMENT: Fallback to the local JSON file
  try {
    const serviceAccount = require("./firebase-service-account.json");
    credentialConfig = cert(serviceAccount);
    console.log("🔥 Firebase initialized via local service account file.");
  } catch (error) {
    console.error(
      "CRITICAL: Local firebase-service-account.json not found.",
      error,
    );
    process.exit(1);
  }
}

// 3. Initialize the app using the selected credentials
initializeApp({
  credential: credentialConfig,
});

// 4. Instantiate the services
const db = getFirestore();
const auth = getAuth();

// 5. Export them for server.js
module.exports = { db, auth };
