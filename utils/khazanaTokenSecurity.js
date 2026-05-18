const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function hashSecret(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function resolveBookAccessTokenSecret(options = {}) {
    const explicitSecret = String(options.explicitSecret || "").trim();
    if (explicitSecret) {
        return {
            secret: explicitSecret,
            source: "env",
            isWeakFallback: false
        };
    }

    const firebaseServiceAccountJson = String(options.firebaseServiceAccountJson || "").trim();
    if (firebaseServiceAccountJson) {
        return {
            secret: hashSecret(`khazana-book-token:${firebaseServiceAccountJson}`),
            source: "firebase-service-account-json",
            isWeakFallback: false
        };
    }

    const localServiceAccountPath = String(options.localServiceAccountPath || "").trim();
    if (localServiceAccountPath) {
        try {
            if (fs.existsSync(localServiceAccountPath)) {
                const localServiceAccount = String(fs.readFileSync(localServiceAccountPath, "utf8") || "").trim();
                if (localServiceAccount) {
                    return {
                        secret: hashSecret(`khazana-book-token:${localServiceAccount}`),
                        source: `firebase-service-account-file:${path.basename(localServiceAccountPath)}`,
                        isWeakFallback: false
                    };
                }
            }
        } catch (_) {
        }
    }

    const razorpayKeySecret = String(options.razorpayKeySecret || "").trim();
    const firebaseProjectId = String(options.firebaseProjectId || "").trim();
    if (razorpayKeySecret) {
        return {
            secret: hashSecret(`khazana-book-token:${firebaseProjectId}:${razorpayKeySecret}`),
            source: "razorpay-key-secret",
            isWeakFallback: false
        };
    }

    const firebaseStorageBucket = String(options.firebaseStorageBucket || "").trim();
    const frontendOrigin = String(options.frontendOrigin || "").trim();
    return {
        secret: hashSecret(`khazana-book-token:${firebaseProjectId}:${firebaseStorageBucket}:${frontendOrigin}`),
        source: "project-fallback",
        isWeakFallback: true
    };
}

module.exports = {
    resolveBookAccessTokenSecret
};
