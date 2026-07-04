require("dotenv").config();

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

let credentialConfig;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
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

initializeApp({
  credential: credentialConfig,
});

const db = getFirestore();
const auth = getAuth();

module.exports = { db, auth };
