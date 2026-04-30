const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const dashboardRouter = require("./routes/dashboard");
const chatRouter = require("./routes/chat");
const whatsappCompatRouter = require("./routes/whatsappRoutes");
const whatsappRouter = require("./routes/whatsapp");
const { initWhatsApp } = require("./services/whatsappService");
require("dotenv").config({
    path: require("path").join(__dirname, ".env")
});
console.log("ENV CHECK → WHATSAPP_ENABLED:", process.env.WHATSAPP_ENABLED);

const DEFAULT_ALLOWED_ORIGINS = [
    "https://sciencesangrah.live",
    "https://www.sciencesangrah.live"
];
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || DEFAULT_ALLOWED_ORIGINS[0]).replace(/\/+$/, "");
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const FIREBASE_STORAGE_BUCKET = String(process.env.FIREBASE_STORAGE_BUCKET || "").trim();
const BOOK_ACCESS_TOKEN_SECRET = String(process.env.BOOK_ACCESS_TOKEN_SECRET || "").trim() || crypto.randomBytes(32).toString("hex");
const BOOK_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

const RAZORPAY_KEY_ID = String(process.env.RAZORPAY_KEY_ID || "").trim();
const RAZORPAY_KEY_SECRET = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
const DEFAULT_RAZORPAY_FLOW = String(process.env.RAZORPAY_FLOW || "checkout").trim().toLowerCase();

const CLASS_CONFIG = {
    "10th": {
        displayName: "10th Khazana",
        amountInr: 1,
        bookIds: ["10th-hindi", "10th-english", "10th-maths", "10th-science", "10th-sst"]
    },
    "12th": {
        displayName: "12th Khazana",
        amountInr: 1,
        bookIds: ["12th-hindi", "12th-english", "12th-maths", "12th-physics", "12th-chemistry", "12th-biology"]
    }
};

initializeFirebaseAdmin();

const firestore = admin.firestore();
const storageBucket = admin.storage().bucket();
const app = express();
let classConfigRefreshPromise = null;

app.use(cors({
    origin(origin, callback) {
        if (!origin || isAllowedRequestOrigin(origin)) {
            callback(null, true);
            return;
        }

        callback(null, false);
    },
    credentials: true
}));
app.use(express.json());
app.use("/api", dashboardRouter);
app.use("/api", chatRouter);
app.use("/api", whatsappRouter);
app.use("/api", whatsappCompatRouter);

app.get("/api/health", async (_req, res) => {
    await refreshKhazanaClassConfig();
    res.json({
        ok: true,
        service: "khazana-razorpay-backend",
        flow: DEFAULT_RAZORPAY_FLOW,
        classes: Object.fromEntries(
            Object.entries(CLASS_CONFIG).map(([classLevel, config]) => [
                classLevel,
                {
                    displayName: config.displayName,
                    amountInr: config.amountInr
                }
            ])
        )
    });
});

app.post("/api/khazana/access", verifyFirebaseUser, async (req, res) => {
    try {
        await refreshKhazanaClassConfig();
        const accessSummary = await ensureUserAccessForVerifiedUser(req.user);
        res.json({
            success: true,
            uid: req.user.uid,
            accessSummary
        });
    } catch (error) {
        console.error("Failed to load Khazana access summary:", error);
        res.status(500).json({
            message: error?.message || "Unable to load Khazana access summary."
        });
    }
});

app.post("/api/khazana/resources", verifyFirebaseUser, async (req, res) => {
    try {
        await refreshKhazanaClassConfig();
        await ensureUserAccessForVerifiedUser(req.user);
        const purchasedClasses = await getPurchasedKhazanaClasses(req.user.uid);
        if (!purchasedClasses.length) {
            res.json({
                success: true,
                resources: []
            });
            return;
        }

        const snapshot = await firestore.collection("resources").get();
        res.json({
            success: true,
            resources: snapshot.docs
                .map((docSnapshot) => ({
                    id: docSnapshot.id,
                    ...docSnapshot.data()
                }))
                .filter((resource) => isReadableKhazanaNoteResource(resource, purchasedClasses))
                .map((resource) => sanitizeKhazanaResourceForClient(resource))
        });
    } catch (error) {
        console.error("Failed to load Khazana resources:", error);
        res.status(500).json({
            message: error?.message || "Unable to load Khazana resources."
        });
    }
});

app.post("/api/khazana/book-access", verifyFirebaseUser, async (req, res) => {
    try {
        await refreshKhazanaClassConfig();
        await ensureUserAccessForVerifiedUser(req.user);

        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const bookId = String(req.body?.bookId || "").trim();
        const requestedDisposition = String(req.body?.disposition || "inline").trim().toLowerCase();
        const disposition = requestedDisposition === "attachment" ? "attachment" : "inline";

        if (!classLevel || !bookId) {
            res.status(400).json({ message: "Book access payload is incomplete." });
            return;
        }

        const resolvedBook = await resolveKhazanaBookFileForUser({
            uid: req.user.uid,
            classLevel,
            bookId
        });

        if (!resolvedBook) {
            res.status(404).json({ message: "Book file is not mapped yet for this subject." });
            return;
        }

        const token = createBookAccessToken({
            uid: req.user.uid,
            classLevel,
            bookId,
            storagePath: resolvedBook.storagePath,
            fileName: resolvedBook.fileName
        });

        res.json({
            success: true,
            classLevel,
            bookId,
            fileName: resolvedBook.fileName,
            url: buildBookFileUrl(req, token, disposition)
        });
    } catch (error) {
        console.error("Failed to create secure Khazana book link:", error);
        const statusCode = /purchase|not purchased|not unlocked/i.test(String(error?.message || "")) ? 403 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to create secure Khazana book link."
        });
    }
});

app.post(
    "/api/admin/khazana/book-pdf",
    verifyFirebaseUser,
    requireAdminUser,
    express.raw({ type: "application/pdf", limit: "55mb" }),
    async (req, res) => {
        try {
            await refreshKhazanaClassConfig();

            const classLevel = normalizeClassLevel(req.headers["x-class-level"]);
            const bookId = String(req.headers["x-book-id"] || "").trim();
            const originalFileName = decodeHeaderValue(req.headers["x-file-name"]);
            const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

            if (!classLevel || !bookId) {
                res.status(400).json({ message: "Class level or book id is missing." });
                return;
            }

            if (!originalFileName) {
                res.status(400).json({ message: "Original file name is missing." });
                return;
            }

            if (!fileBuffer.length) {
                res.status(400).json({ message: "PDF file body is empty." });
                return;
            }

            if (!looksLikePdfBuffer(fileBuffer)) {
                res.status(400).json({ message: "Only PDF files are allowed." });
                return;
            }

            const bookConfig = await getKhazanaBookDefinition(classLevel, bookId);
            if (!bookConfig) {
                res.status(404).json({ message: "Requested Khazana book is not configured." });
                return;
            }

            const safeName = sanitizeStorageFileName(originalFileName || "book.pdf");
            const storagePath = `paid-notes/${classLevel}/${bookId}/${Date.now()}_${safeName}`;
            const file = storageBucket.file(storagePath);

            await file.save(fileBuffer, {
                resumable: false,
                metadata: {
                    contentType: "application/pdf",
                    cacheControl: "private,max-age=3600",
                    metadata: {
                        source: "admin-khazana-pdf",
                        classLevel,
                        bookId,
                        uploadedBy: req.user.uid
                    }
                }
            });

            res.json({
                success: true,
                storagePath,
                fileName: originalFileName
            });
        } catch (error) {
            console.error("Failed to upload Khazana PDF via admin backend:", error);
            res.status(500).json({
                message: error?.message || "Unable to upload the requested PDF."
            });
        }
    }
);

app.post("/api/admin/khazana/storage-file/delete", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const storagePath = String(req.body?.storagePath || "").trim();
        if (!storagePath) {
            res.status(400).json({ message: "Storage path is required." });
            return;
        }

        if (!isManagedKhazanaStoragePath(storagePath)) {
            res.status(400).json({ message: "Storage path is outside the managed Khazana folders." });
            return;
        }

        await storageBucket.file(storagePath).delete({ ignoreNotFound: true });
        res.json({
            success: true,
            storagePath
        });
    } catch (error) {
        console.error("Failed to delete Khazana storage file via admin backend:", error);
        res.status(500).json({
            message: error?.message || "Unable to delete the requested storage file."
        });
    }
});

app.get("/api/khazana/book-file", async (req, res) => {
    try {
        const token = String(req.query?.token || "").trim();
        if (!token) {
            res.status(400).json({ message: "Missing book access token." });
            return;
        }

        const accessPayload = verifyBookAccessToken(token);
        await streamKhazanaBookFile(req, res, accessPayload);
    } catch (error) {
        const message = String(error?.message || "");
        const statusCode = /expired|invalid|tampered|token/i.test(message)
            ? 401
            : (/not found|missing/i.test(message) ? 404 : 500);
        console.error("Failed to stream secure Khazana book file:", error);
        res.status(statusCode).send(message || "Unable to stream the requested book file.");
    }
});

app.head("/api/khazana/book-file", async (req, res) => {
    try {
        const token = String(req.query?.token || "").trim();
        if (!token) {
            res.status(400).end();
            return;
        }

        const accessPayload = verifyBookAccessToken(token);
        await streamKhazanaBookFile(req, res, accessPayload, { headOnly: true });
    } catch (error) {
        const message = String(error?.message || "");
        const statusCode = /expired|invalid|tampered|token/i.test(message)
            ? 401
            : (/not found|missing/i.test(message) ? 404 : 500);
        console.error("Failed to prepare secure Khazana book HEAD response:", error);
        res.status(statusCode).end();
    }
});

app.post("/api/khazana/session", verifyFirebaseUser, async (req, res) => {
    try {
        requireRazorpayCredentials();

        const classLevel = normalizeClassLevel(req.body?.classLevel);
        if (!classLevel || !CLASS_CONFIG[classLevel]) {
            res.status(400).json({ message: "Invalid class level." });
            return;
        }

        const expectedAmountInr = Number(req.body?.expectedAmountInr);
        const classConfig = await getFreshKhazanaClassConfigForPayment(classLevel, expectedAmountInr);
        const flow = normalizeGatewayMode(req.body?.gatewayMode || DEFAULT_RAZORPAY_FLOW);
        const attemptId = createAttemptId();
        const amountPaise = Math.round(classConfig.amountInr * 100);
        const studentProfile = await getStudentProfile(req.user.uid);
        const pagePath = resolveRequestedPagePath(req);

        const attemptRef = firestore.collection("khazana_payment_attempts").doc(attemptId);
        await attemptRef.set({
            uid: req.user.uid,
            classLevel,
            amountInr: classConfig.amountInr,
            amountPaise,
            currency: "INR",
            flow,
            status: "created",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            pagePath: pagePath || null,
            student: {
                email: studentProfile.email || req.user.email || "",
                name: studentProfile.name || req.user.name || "",
                mobile: studentProfile.mobile || ""
            }
        }, { merge: true });

        if (flow === "payment_link") {
            const session = await createPaymentLinkSession({
                attemptId,
                classLevel,
                classConfig,
                amountPaise,
                studentProfile,
                requestOrigin: String(req.headers.origin || "").trim(),
                pagePath
            });

            await attemptRef.set({
                paymentLinkId: session.paymentLinkId,
                referenceId: session.referenceId,
                callbackUrl: session.callbackUrl,
                status: "checkout_started",
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            res.json({
                mode: "payment_link",
                attemptId,
                redirectUrl: session.redirectUrl,
                amount: amountPaise,
                amountInr: classConfig.amountInr,
                currency: "INR",
                displayName: classConfig.displayName
            });
            return;
        }

        const order = await createCheckoutOrder({
            attemptId,
            classLevel,
            classConfig,
            amountPaise
        });

        await attemptRef.set({
            orderId: order.id,
            receipt: order.receipt || attemptId,
            status: "checkout_started",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({
            mode: "checkout",
            attemptId,
            keyId: RAZORPAY_KEY_ID,
            amount: amountPaise,
            amountInr: classConfig.amountInr,
            currency: "INR",
            orderId: order.id,
            businessName: "Science Sangrah",
            description: `${classConfig.displayName} Notes Access`,
            displayName: classConfig.displayName,
            prefill: buildPrefill(studentProfile, req.user),
            notes: {
                attemptId,
                classLevel,
                uid: req.user.uid
            },
            theme: {
                color: "#790c13"
            }
        });
    } catch (error) {
        console.error("Failed to create Khazana payment session:", error);
        const message = error?.message || "Unable to create Razorpay payment session.";
        const statusCode = /price|pricing|configured/i.test(message) ? 409 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to create Razorpay payment session."
        });
    }
});

app.post("/api/khazana/verify", verifyFirebaseUser, async (req, res) => {
    try {
        await refreshKhazanaClassConfig();
        requireRazorpayCredentials();

        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const attemptId = String(req.body?.attemptId || "").trim();
        const paymentId = String(req.body?.razorpay_payment_id || "").trim();
        let orderId = String(req.body?.razorpay_order_id || "").trim();
        const paymentLinkId = String(req.body?.razorpay_payment_link_id || "").trim();
        const signature = String(req.body?.razorpay_signature || "").trim();

        if (!classLevel || !attemptId) {
            res.status(400).json({ message: "Payment verification payload is incomplete." });
            return;
        }

        const attemptRef = firestore.collection("khazana_payment_attempts").doc(attemptId);
        const attemptSnapshot = await attemptRef.get();
        if (!attemptSnapshot.exists) {
            res.status(404).json({ message: "Payment attempt not found." });
            return;
        }

        const attempt = attemptSnapshot.data() || {};
        if (attempt.uid !== req.user.uid) {
            res.status(403).json({ message: "This payment attempt belongs to a different user." });
            return;
        }

        if (normalizeClassLevel(attempt.classLevel) !== classLevel) {
            res.status(400).json({ message: "Class level does not match the saved payment attempt." });
            return;
        }

        if (attempt.status === "completed") {
            res.json({ success: true, alreadyVerified: true });
            return;
        }

        let verifiedPaymentId = paymentId;
        let payment;

        if (attempt.flow === "payment_link") {
            const verifiedLinkPayment = await verifyPaymentLinkAttempt({
                attempt,
                paymentId,
                paymentLinkId,
                orderId
            });
            payment = verifiedLinkPayment.payment;
            verifiedPaymentId = verifiedLinkPayment.paymentId;
            orderId = verifiedLinkPayment.orderId;
        } else {
            if (!paymentId || !orderId || !signature) {
                res.status(400).json({ message: "Payment verification payload is incomplete." });
                return;
            }

            payment = await razorpayRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, "GET");
            orderId = orderId || String(payment?.order_id || "").trim();
            if (!orderId) {
                res.status(400).json({ message: "Razorpay order could not be resolved for this payment." });
                return;
            }

            if (!isValidRazorpaySignature(orderId, paymentId, signature)) {
                res.status(400).json({ message: "Razorpay signature verification failed." });
                return;
            }

            if (attempt.orderId && attempt.orderId !== orderId) {
                res.status(400).json({ message: "Razorpay order does not match the saved checkout session." });
                return;
            }

            validatePaymentAgainstAttempt(payment, attempt, orderId);
            const order = await razorpayRequest(`/v1/orders/${encodeURIComponent(orderId)}`, "GET");
            validateOrderAgainstAttempt(order, attempt, attemptId);
        }

        await grantKhazanaAccess({
            uid: req.user.uid,
            classLevel,
            payment,
            paymentId: verifiedPaymentId,
            orderId,
            attemptId,
            attemptRef,
            attempt
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Failed to verify Khazana payment:", error);
        res.status(500).json({
            message: error?.message || "Unable to verify Razorpay payment."
        });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log("Server running on port", PORT);
        console.log("Khazana active pricing:", Object.fromEntries(
            Object.entries(CLASS_CONFIG).map(([classLevel, config]) => [classLevel, config.amountInr])
        ));
        initWhatsApp().catch((error) => {
            console.error("WhatsApp init failed:", error?.message || error);
        });
    });
}

module.exports = app;

function isAllowedRequestOrigin(origin) {
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        return true;
    }

    try {
        const parsedOrigin = new URL(origin);
        return (
            (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:")
            && /^(localhost|127\.0\.0\.1)$/i.test(parsedOrigin.hostname)
        );
    } catch (_) {
        return false;
    }
}

function initializeFirebaseAdmin() {
    if (admin.apps.length) return;

    const storageBucket = resolveFirebaseStorageBucket();

    const rawServiceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (rawServiceAccount) {
        const serviceAccount = JSON.parse(rawServiceAccount);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            storageBucket
        });
        return;
    }

    const localServiceAccountPath = path.join(__dirname, "serviceAccount.json");
    if (fs.existsSync(localServiceAccountPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(localServiceAccountPath, "utf8"));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            storageBucket
        });
        console.log(`Firebase Admin initialized with local service account: ${localServiceAccountPath}`);
        return;
    }

    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        storageBucket
    });
    console.warn("Firebase Admin initialized with application default credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or add backend/serviceAccount.json to guarantee the correct Firebase project.");
}

async function refreshKhazanaClassConfig() {
    if (classConfigRefreshPromise) {
        return classConfigRefreshPromise;
    }

    classConfigRefreshPromise = (async () => {
        try {
            const snapshot = await firestore.collection("khazana_config").doc("main").get();
            if (!snapshot.exists) return CLASS_CONFIG;

            const data = snapshot.data() || {};
            const classes = data.classes || {};

            Object.entries(classes).forEach(([classLevel, incomingClass]) => {
                const normalizedClass = normalizeClassLevel(classLevel);
                if (!normalizedClass || !CLASS_CONFIG[normalizedClass] || !incomingClass || typeof incomingClass !== "object") {
                    return;
                }

                const fallback = CLASS_CONFIG[normalizedClass];
                const amountInr = Number(incomingClass.offerPrice ?? incomingClass.amountInr ?? fallback.amountInr);
                const books = Array.isArray(incomingClass.books) ? incomingClass.books : [];
                const bookIds = books
                    .map((book) => String(book?.id || "").trim())
                    .filter(Boolean);

                CLASS_CONFIG[normalizedClass] = {
                    ...fallback,
                    displayName: String(incomingClass.displayName || fallback.displayName).trim(),
                    amountInr: Number.isFinite(amountInr) && amountInr >= 0 ? amountInr : fallback.amountInr,
                    bookIds: bookIds.length ? bookIds : fallback.bookIds
                };
            });
        } catch (error) {
            console.warn("Unable to refresh Khazana admin config, using backend defaults:", error);
        } finally {
            classConfigRefreshPromise = null;
        }

        return CLASS_CONFIG;
    })();

    return classConfigRefreshPromise;
}

async function getFreshKhazanaClassConfigForPayment(classLevel, expectedAmountInr) {
    const normalizedClass = normalizeClassLevel(classLevel);
    if (!normalizedClass || !CLASS_CONFIG[normalizedClass]) {
        throw new Error("Invalid class level.");
    }

    const snapshot = await firestore.collection("khazana_config").doc("main").get();
    if (!snapshot.exists) {
        throw new Error("Khazana pricing is not configured in admin yet. Please save the Khazana price again.");
    }

    const incomingClass = snapshot.data()?.classes?.[normalizedClass];
    if (!incomingClass || typeof incomingClass !== "object") {
        throw new Error(`${normalizedClass} Khazana pricing is not configured in admin yet.`);
    }

    const fallback = CLASS_CONFIG[normalizedClass];
    const amountInr = Number(incomingClass.offerPrice ?? incomingClass.amountInr);
    if (!Number.isFinite(amountInr) || amountInr <= 0) {
        throw new Error(`${normalizedClass} Khazana offer price is invalid. Please save a valid admin price.`);
    }

    if (Number.isFinite(expectedAmountInr) && expectedAmountInr >= 0) {
        const expectedPaise = Math.round(expectedAmountInr * 100);
        const actualPaise = Math.round(amountInr * 100);
        if (expectedPaise !== actualPaise) {
            throw new Error(`Khazana price changed from ₹${expectedAmountInr} to ₹${amountInr}. Please refresh the page and try again.`);
        }
    }

    const books = Array.isArray(incomingClass.books) ? incomingClass.books : [];
    const bookIds = books
        .map((book) => String(book?.id || "").trim())
        .filter(Boolean);

    CLASS_CONFIG[normalizedClass] = {
        ...fallback,
        displayName: String(incomingClass.displayName || fallback.displayName).trim(),
        amountInr,
        bookIds: bookIds.length ? bookIds : fallback.bookIds
    };

    return CLASS_CONFIG[normalizedClass];
}

async function verifyFirebaseUser(req, res, next) {
    try {
        const authHeader = String(req.headers.authorization || "");
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
        if (!token) {
            res.status(401).json({ message: "Missing Firebase ID token." });
            return;
        }

        req.user = await admin.auth().verifyIdToken(token);
        next();
    } catch (error) {
        console.error("Firebase auth verification failed:", error);
        res.status(401).json({ message: "Invalid Firebase ID token." });
    }
}

async function requireAdminUser(req, res, next) {
    try {
        const adminSnapshot = await firestore.collection("admins").doc(req.user.uid).get();
        const adminData = adminSnapshot.exists ? adminSnapshot.data() || {} : null;
        const role = String(adminData?.role || "").trim().toLowerCase();
        if (!["admin", "superadmin", "manager", "editor"].includes(role)) {
            res.status(403).json({ message: "Admin access is required for this action." });
            return;
        }

        req.adminRole = role;
        next();
    } catch (error) {
        console.error("Admin authorization failed:", error);
        res.status(500).json({ message: "Unable to verify admin access." });
    }
}

function requireRazorpayCredentials() {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay credentials are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    }
}

function normalizeClassLevel(value) {
    const raw = String(value || "").trim();
    if (raw === "10" || raw === "10th") return "10th";
    if (raw === "12" || raw === "12th") return "12th";
    return "";
}

function normalizeGatewayMode(value) {
    const raw = String(value || "").trim().toLowerCase();
    return raw === "payment_link" ? "payment_link" : "checkout";
}

function resolveFirebaseStorageBucket() {
    if (FIREBASE_STORAGE_BUCKET) {
        return FIREBASE_STORAGE_BUCKET;
    }

    const rawServiceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (rawServiceAccount) {
        try {
            const parsed = JSON.parse(rawServiceAccount);
            if (parsed?.project_id) {
                return `${String(parsed.project_id).trim()}.firebasestorage.app`;
            }
        } catch (_) {
        }
    }

    return "science-sangrah-5067f.firebasestorage.app";
}

function createAttemptId() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `attempt_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
}

async function getPurchasedKhazanaClasses(uid) {
    const accessSnapshot = await firestore.collection("user_access").doc(uid).get();
    if (!accessSnapshot.exists) {
        return [];
    }

    const accessSummary = accessSnapshot.data() || {};
    return Object.entries(normalizeAccessSummary(accessSummary))
        .filter(([, value]) => String(value?.purchase_status || "").trim().toLowerCase() === "completed")
        .map(([classLevel]) => classLevel);
}

async function assertPurchasedKhazanaClass(uid, classLevel) {
    const purchasedClasses = await getPurchasedKhazanaClasses(uid);
    if (!purchasedClasses.includes(classLevel)) {
        throw new Error(`This ${classLevel} book is not unlocked for the current user.`);
    }
}

async function resolveKhazanaBookFileForUser({ uid, classLevel, bookId }) {
    await assertPurchasedKhazanaClass(uid, classLevel);

    const bookConfig = await getKhazanaBookDefinition(classLevel, bookId);
    if (!bookConfig) {
        throw new Error("Requested Khazana book is not configured.");
    }

    const directStoragePath = extractStoragePathFromKhazanaBook(bookConfig);
    if (directStoragePath) {
        return {
            storagePath: directStoragePath,
            fileName: buildKhazanaBookFileName(classLevel, bookConfig)
        };
    }

    const legacyResource = await resolveLegacyKhazanaResource(classLevel, bookConfig);
    if (legacyResource?.storagePath) {
        return {
            storagePath: legacyResource.storagePath,
            fileName: legacyResource.fileName || buildKhazanaBookFileName(classLevel, bookConfig)
        };
    }

    return null;
}

async function getKhazanaBookDefinition(classLevel, bookId) {
    const snapshot = await firestore.collection("khazana_config").doc("main").get();
    if (!snapshot.exists) {
        return null;
    }

    const books = snapshot.data()?.classes?.[classLevel]?.books;
    if (!Array.isArray(books)) {
        return null;
    }

    return books.find((book) => String(book?.id || "").trim() === bookId) || null;
}

function extractStoragePathFromKhazanaBook(book = {}) {
    const configuredPath = String(book.storagePath || "").trim();
    if (configuredPath) {
        return configuredPath;
    }

    return extractStoragePathFromFileUrl(book.fileUrl);
}

async function resolveLegacyKhazanaResource(classLevel, bookConfig = {}) {
    const subjectCandidates = new Set([
        normalizeSubjectLookupKey(bookConfig.subjectKey),
        normalizeSubjectLookupKey(bookConfig.name),
        normalizeSubjectLookupKey(bookConfig.titleLabel)
    ].filter(Boolean));

    if (!subjectCandidates.size) {
        return null;
    }

    const snapshot = await firestore.collection("resources").get();
    for (const docSnapshot of snapshot.docs) {
        const resource = docSnapshot.data() || {};
        if (String(resource.resourceType || "").trim().toLowerCase() !== "notes") {
            continue;
        }

        if (normalizeClassLevel(resource.classLevel) !== classLevel) {
            continue;
        }

        const subjectKey = normalizeSubjectLookupKey(resource.subject);
        if (!subjectCandidates.has(subjectKey)) {
            continue;
        }

        const storagePath = String(resource.storagePath || "").trim() || extractStoragePathFromFileUrl(resource.fileUrl || resource.url);
        if (!storagePath) {
            continue;
        }

        return {
            storagePath,
            fileName: String(resource.fileName || "").trim()
        };
    }

    return null;
}

function extractStoragePathFromFileUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    try {
        const url = new URL(raw);
        const objectPath = url.pathname.split("/o/")[1] || "";
        if (!objectPath) {
            return "";
        }

        return decodeURIComponent(objectPath);
    } catch (_) {
        return "";
    }
}

function sanitizeStorageFileName(fileName) {
    return String(fileName || "file")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/_+/g, "_")
        || "file";
}

function looksLikePdfBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
        return false;
    }

    return buffer.subarray(0, 5).toString("utf8") === "%PDF-";
}

function isManagedKhazanaStoragePath(storagePath) {
    const normalizedPath = String(storagePath || "").trim();
    return normalizedPath.startsWith("paid-notes/")
        || normalizedPath.startsWith("media/khazana-covers/");
}

function decodeHeaderValue(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    try {
        return decodeURIComponent(raw);
    } catch (_) {
        return raw;
    }
}

function normalizeSubjectLookupKey(value) {
    return String(value || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "");
}

function buildKhazanaBookFileName(classLevel, bookConfig = {}) {
    const classLabel = String(classLevel || "").trim();
    const titleLabel = String(bookConfig.titleLabel || bookConfig.name || bookConfig.subjectKey || bookConfig.id || "Notes").trim();
    return sanitizeDownloadFileName(`${classLabel} ${titleLabel} Notes.pdf`);
}

function sanitizeDownloadFileName(fileName) {
    const normalized = String(fileName || "notes.pdf")
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/\s+/g, " ");

    return normalized || "notes.pdf";
}

function createBookAccessToken(payload = {}) {
    const data = {
        uid: String(payload.uid || "").trim(),
        classLevel: normalizeClassLevel(payload.classLevel),
        bookId: String(payload.bookId || "").trim(),
        storagePath: String(payload.storagePath || "").trim(),
        fileName: sanitizeDownloadFileName(payload.fileName),
        exp: Date.now() + BOOK_ACCESS_TOKEN_TTL_MS
    };

    const encodedPayload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    return `${encodedPayload}.${signature}`;
}

function verifyBookAccessToken(token) {
    const [encodedPayload, signature] = String(token || "").split(".");
    if (!encodedPayload || !signature) {
        throw new Error("Invalid book access token.");
    }

    const expectedSignature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    const left = Buffer.from(signature);
    const right = Buffer.from(expectedSignature);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        throw new Error("Book access token has been tampered with.");
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload?.uid || !payload?.classLevel || !payload?.bookId || !payload?.storagePath) {
        throw new Error("Book access token is incomplete.");
    }

    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Date.now()) {
        throw new Error("Book access token has expired.");
    }

    return payload;
}

function buildBookFileUrl(req, token, disposition = "inline") {
    const requestedDisposition = String(disposition || "inline").trim().toLowerCase() === "attachment"
        ? "attachment"
        : "inline";
    const baseUrl = getRequestBaseUrl(req);
    const url = new URL("/api/khazana/book-file", `${baseUrl}/`);
    url.searchParams.set("token", token);
    if (requestedDisposition === "attachment") {
        url.searchParams.set("disposition", "attachment");
    }
    return url.toString();
}

function getRequestBaseUrl(req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "http";
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    return `${protocol}://${host}`;
}

async function streamKhazanaBookFile(req, res, accessPayload, options = {}) {
    const headOnly = Boolean(options.headOnly);
    const storagePath = String(accessPayload.storagePath || "").trim();
    if (!storagePath) {
        throw new Error("Book file path is missing.");
    }

    const file = storageBucket.file(storagePath);
    const [exists] = await file.exists();
    if (!exists) {
        throw new Error("Requested book file was not found in storage.");
    }

    const [metadata] = await file.getMetadata();
    const totalSize = Number(metadata?.size || 0);
    const contentType = String(metadata?.contentType || "application/pdf").trim() || "application/pdf";
    const disposition = String(req.query?.disposition || "").trim().toLowerCase() === "attachment"
        ? "attachment"
        : "inline";
    const fileName = sanitizeDownloadFileName(accessPayload.fileName || path.basename(storagePath));
    const contentDisposition = `${disposition}; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Disposition", contentDisposition);

    const rangeHeader = String(req.headers.range || "").trim();
    const range = parseHttpRange(rangeHeader, totalSize);

    if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
        if (headOnly) {
            res.end();
            return;
        }

        file.createReadStream({ start: range.start, end: range.end })
            .on("error", (error) => {
                if (!res.headersSent) {
                    res.status(500).end("Unable to stream the requested book range.");
                    return;
                }
                res.destroy(error);
            })
            .pipe(res);
        return;
    }

    res.setHeader("Content-Length", String(totalSize));
    if (headOnly) {
        res.end();
        return;
    }

    file.createReadStream()
        .on("error", (error) => {
            if (!res.headersSent) {
                res.status(500).end("Unable to stream the requested book file.");
                return;
            }
            res.destroy(error);
        })
        .pipe(res);
}

function parseHttpRange(rangeHeader, totalSize) {
    if (!rangeHeader || !Number.isFinite(totalSize) || totalSize <= 0) {
        return null;
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader);
    if (!match) {
        return null;
    }

    let start = match[1] === "" ? NaN : Number(match[1]);
    let end = match[2] === "" ? NaN : Number(match[2]);

    if (Number.isNaN(start) && Number.isNaN(end)) {
        return null;
    }

    if (Number.isNaN(start)) {
        const suffixLength = Math.min(Number(end) || 0, totalSize);
        start = Math.max(0, totalSize - suffixLength);
        end = totalSize - 1;
    } else if (Number.isNaN(end) || end >= totalSize) {
        end = totalSize - 1;
    }

    if (start < 0 || end < start || start >= totalSize) {
        return null;
    }

    return { start, end };
}

function isReadableKhazanaNoteResource(resource = {}, purchasedClasses = []) {
    if (String(resource.resourceType || "").trim().toLowerCase() !== "notes") {
        return false;
    }

    const resourceClass = normalizeClassLevel(resource.classLevel);
    return Boolean(resourceClass) && purchasedClasses.includes(resourceClass);
}

function sanitizeKhazanaResourceForClient(resource = {}) {
    return {
        id: resource.id || "",
        resourceType: resource.resourceType || "",
        classLevel: resource.classLevel || "",
        subject: resource.subject || "",
        title: resource.title || resource.name || "",
        pageUrl: resource.pageUrl || ""
    };
}

async function getStudentProfile(uid) {
    const snapshot = await firestore.collection("users").doc(uid).get();
    if (!snapshot.exists) return {};
    return snapshot.data() || {};
}

async function ensureUserAccessForVerifiedUser(firebaseUser) {
    const uid = String(firebaseUser?.uid || "").trim();
    if (!uid) {
        return null;
    }

    const userAccessRef = firestore.collection("user_access").doc(uid);
    const userAccessSnapshot = await userAccessRef.get();
    const currentAccess = userAccessSnapshot.exists ? userAccessSnapshot.data() || {} : null;

    const email = String(firebaseUser?.email || "").trim();
    const attemptDocs = await findKhazanaAttemptDocsForUser(uid, email);
    const repairedAccess = await reconcilePaidPaymentLinkAttemptsForUser(uid, attemptDocs);
    if (hasCompletedAccess(repairedAccess)) {
        return repairedAccess;
    }

    if (hasCompletedAccess(currentAccess)) {
        return currentAccess;
    }

    const completedAttempts = attemptDocs.filter((docSnapshot) => {
        const attempt = docSnapshot.data() || {};
        return isCompletedKhazanaAttempt(attempt);
    });

    if (!completedAttempts.length) {
        return null;
    }

    const purchasedClasses = new Set();
    const classes = {};

    completedAttempts
        .map((docSnapshot) => docSnapshot.data() || {})
        .filter((attempt) => attempt.status === "completed" && CLASS_CONFIG[normalizeClassLevel(attempt.classLevel)])
        .forEach((attempt) => {
        const classLevel = normalizeClassLevel(attempt.classLevel);
        const classConfig = CLASS_CONFIG[classLevel];
        if (!classLevel || !classConfig) return;

        purchasedClasses.add(classLevel);
        classes[classLevel] = {
            purchase_id: attempt.purchaseId || classes[classLevel]?.purchase_id || "",
            purchase_status: "completed",
            unlocked_books: classConfig.bookIds,
            purchased_at: toIsoString(attempt.verifiedAt) || classes[classLevel]?.purchased_at || new Date().toISOString(),
            amount_paid: Number.isFinite(Number(attempt.amountInr)) ? Number(attempt.amountInr) : classConfig.amountInr,
            razorpay_payment_id: String(attempt.paymentId || classes[classLevel]?.razorpay_payment_id || "").trim(),
            razorpay_order_id: String(attempt.orderId || classes[classLevel]?.razorpay_order_id || "").trim()
        };
        });

    await userAccessRef.set({
        user_id: uid,
        purchased_classes: Array.from(purchasedClasses),
        classes,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const refreshedSnapshot = await userAccessRef.get();
    return refreshedSnapshot.exists ? refreshedSnapshot.data() || null : null;
}

function hasCompletedAccess(accessSummary) {
    const classes = normalizeAccessSummary(accessSummary);
    return Object.values(classes).some((value) => String(value?.purchase_status || "").trim().toLowerCase() === "completed");
}

function normalizeAccessSummary(accessSummary) {
    const normalized = {};
    const rawClasses = accessSummary?.classes;

    if (rawClasses && typeof rawClasses === "object") {
        Object.entries(rawClasses).forEach(([key, value]) => {
            const normalizedKey = normalizeClassLevel(key);
            if (!normalizedKey || !value || typeof value !== "object") return;
            normalized[normalizedKey] = {
                ...(normalized[normalizedKey] || {}),
                ...value
            };
        });
    }

    const purchasedClasses = Array.isArray(accessSummary?.purchased_classes)
        ? accessSummary.purchased_classes
        : [];

    purchasedClasses.forEach((value) => {
        const normalizedKey = normalizeClassLevel(value);
        if (!normalizedKey) return;
        normalized[normalizedKey] = {
            ...(normalized[normalizedKey] || {}),
            purchase_status: normalized[normalizedKey]?.purchase_status || "completed"
        };
    });

    const fallbackClass = normalizeClassLevel(accessSummary?.class_purchased);
    if (fallbackClass) {
        normalized[fallbackClass] = {
            ...(normalized[fallbackClass] || {}),
            purchase_status: normalized[fallbackClass]?.purchase_status || String(accessSummary?.purchase_status || "completed")
        };
    }

    return normalized;
}

async function findKhazanaAttemptDocsForUser(uid, email) {
    const attemptsById = new Map();

    const uidSnapshot = await firestore
        .collection("khazana_payment_attempts")
        .where("uid", "==", uid)
        .get();

    uidSnapshot.docs.forEach((docSnapshot) => {
        attemptsById.set(docSnapshot.id, docSnapshot);
    });

    if (email) {
        const emailSnapshot = await firestore
            .collection("khazana_payment_attempts")
            .where("student.email", "==", email)
            .get();

        emailSnapshot.docs.forEach((docSnapshot) => {
            attemptsById.set(docSnapshot.id, docSnapshot);
        });
    }

    return Array.from(attemptsById.values());
}

async function findCompletedKhazanaAttemptsForUser(uid, email) {
    const attemptDocs = await findKhazanaAttemptDocsForUser(uid, email);
    return attemptDocs.filter((docSnapshot) => {
        const attempt = docSnapshot.data() || {};
        return isCompletedKhazanaAttempt(attempt);
    });
}

function isCompletedKhazanaAttempt(attempt) {
    return attempt.status === "completed" && CLASS_CONFIG[normalizeClassLevel(attempt.classLevel)];
}

async function reconcilePaidPaymentLinkAttemptsForUser(uid, attemptDocs) {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        return null;
    }

    const pendingPaymentLinkAttempts = attemptDocs
        .map((docSnapshot) => ({
            id: docSnapshot.id,
            data: docSnapshot.data() || {}
        }))
        .filter(({ data }) => (
            data.status !== "completed"
            && data.flow === "payment_link"
            && data.paymentLinkId
            && CLASS_CONFIG[normalizeClassLevel(data.classLevel)]
        ))
        .sort((left, right) => getMillis(right.data.createdAt) - getMillis(left.data.createdAt))
        .slice(0, 10);

    for (const { id, data: attempt } of pendingPaymentLinkAttempts) {
        try {
            const classLevel = normalizeClassLevel(attempt.classLevel);
            const verifiedLinkPayment = await verifyPaymentLinkAttempt({
                attempt,
                paymentId: "",
                paymentLinkId: "",
                orderId: ""
            });

            await grantKhazanaAccess({
                uid,
                classLevel,
                payment: verifiedLinkPayment.payment,
                paymentId: verifiedLinkPayment.paymentId,
                orderId: verifiedLinkPayment.orderId,
                attemptId: id,
                attemptRef: firestore.collection("khazana_payment_attempts").doc(id),
                attempt
            });

            const refreshedSnapshot = await firestore.collection("user_access").doc(uid).get();
            return refreshedSnapshot.exists ? refreshedSnapshot.data() || null : null;
        } catch (error) {
            const message = String(error?.message || "");
            if (!/not marked as paid|payment id is not available|lookup failed/i.test(message)) {
                console.warn(`Unable to reconcile Khazana payment link attempt ${id}:`, error);
            }
        }
    }

    return null;
}

function getMillis(value) {
    if (!value) return 0;
    if (typeof value.toMillis === "function") return value.toMillis();
    if (typeof value.toDate === "function") return value.toDate().getTime();
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function toIsoString(value) {
    if (!value) return "";

    if (typeof value.toDate === "function") {
        return value.toDate().toISOString();
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function buildPrefill(profile, firebaseUser) {
    const name = String(profile.name || firebaseUser.name || "").trim();
    const email = String(profile.email || firebaseUser.email || "").trim();
    const contact = sanitizeContact(profile.mobile || "");

    const prefill = {};
    if (name) prefill.name = name;
    if (email) prefill.email = email;
    if (contact) prefill.contact = contact;
    return prefill;
}

function sanitizeContact(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (!digits) return "";
    if (digits.length === 10) return digits;
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    return "";
}

async function createCheckoutOrder({ attemptId, classLevel, classConfig, amountPaise }) {
    return razorpayRequest("/v1/orders", "POST", {
        amount: amountPaise,
        currency: "INR",
        receipt: attemptId.slice(0, 40),
        notes: {
            attemptId,
            classLevel,
            product: classConfig.displayName
        }
    });
}

async function createPaymentLinkSession({ attemptId, classLevel, classConfig, amountPaise, studentProfile, requestOrigin, pagePath }) {
    const callbackUrl = buildPaymentCallbackUrl(classLevel, attemptId, requestOrigin, pagePath);
    const referenceId = attemptId.slice(0, 40);

    const payload = {
        amount: amountPaise,
        currency: "INR",
        accept_partial: false,
        description: `${classConfig.displayName} Notes Access`,
        reference_id: referenceId,
        callback_url: callbackUrl,
        callback_method: "get",
        notes: {
            attemptId,
            classLevel,
            product: classConfig.displayName
        }
    };

    const customer = buildPaymentLinkCustomer(studentProfile);
    if (Object.keys(customer).length > 0) {
        payload.customer = customer;
    }

    const paymentLink = await razorpayRequest("/v1/payment_links", "POST", payload);
    return {
        paymentLinkId: paymentLink.id,
        referenceId,
        callbackUrl,
        redirectUrl: paymentLink.short_url
    };
}

function buildPaymentLinkCustomer(profile) {
    const customer = {};
    const name = String(profile.name || "").trim();
    const email = String(profile.email || "").trim();
    const contact = sanitizeContact(profile.mobile || "");

    if (name) customer.name = name;
    if (email) customer.email = email;
    if (contact) customer.contact = contact;
    return customer;
}

function buildPaymentCallbackUrl(classLevel, attemptId, requestOrigin = "", pagePath = "") {
    const origin = resolveFrontendOrigin(requestOrigin);
    if (!origin) {
        throw new Error("FRONTEND_ORIGIN is required for payment-link callbacks.");
    }

    const effectivePagePath = resolvePaymentCallbackPagePath(pagePath, requestOrigin, origin);
    const baseUrl = resolveFrontendPageBaseUrl(origin, effectivePagePath);
    const url = new URL("khazana-payment-status.html", baseUrl);
    url.searchParams.set("class", classLevel);
    url.searchParams.set("attempt", attemptId);
    url.searchParams.set("attemptId", attemptId);
    return url.toString();
}

function resolvePaymentCallbackPagePath(pagePath = "", requestOrigin = "", resolvedOrigin = "") {
    const sanitizedPagePath = sanitizeFrontendPagePath(pagePath);
    if (!sanitizedPagePath) {
        return "";
    }

    const requestedOrigin = String(requestOrigin || "").trim().replace(/\/+$/, "");
    if (!requestedOrigin || requestedOrigin === resolvedOrigin) {
        return sanitizedPagePath;
    }

    return stripHostingerPreviewPrefix(sanitizedPagePath);
}

function resolveFrontendPageBaseUrl(origin, pagePath = "") {
    const normalizedPath = sanitizeFrontendPagePath(pagePath);
    if (!normalizedPath) {
        return new URL("/", origin).toString();
    }

    return new URL(normalizedPath, origin).toString();
}

function resolveFrontendOrigin(requestOrigin = "") {
    const candidate = String(requestOrigin || "").trim().replace(/\/+$/, "");
    if (candidate && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(candidate))) {
        return candidate;
    }

    return FRONTEND_ORIGIN || "";
}

function resolveRequestedPagePath(req) {
    const bodyPath = sanitizeFrontendPagePath(req.body?.pagePath);
    if (bodyPath) {
        return bodyPath;
    }

    return extractPathnameFromUrl(req.headers?.referer || req.headers?.referrer || "");
}

function sanitizeFrontendPagePath(value) {
    const raw = String(value || "").trim();
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
        return "";
    }

    try {
        return new URL(raw, "http://localhost").pathname;
    } catch (_) {
        return "";
    }
}

function stripHostingerPreviewPrefix(pathname = "") {
    const normalizedPath = sanitizeFrontendPagePath(pathname);
    if (!normalizedPath) {
        return "";
    }

    const previewMatch = normalizedPath.match(/\/files\/public_html(\/.*)$/i);
    return previewMatch ? previewMatch[1] : normalizedPath;
}

function extractPathnameFromUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    try {
        return sanitizeFrontendPagePath(new URL(raw).pathname);
    } catch (_) {
        return "";
    }
}

async function razorpayRequest(path, method, body) {
    const response = await fetch(`https://api.razorpay.com${path}`, {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`,
            "Content-Type": "application/json"
        },
        body: method === "GET" ? undefined : JSON.stringify(body || {})
    });

    const payload = await safeReadJson(response);
    if (!response.ok) {
        const detail = payload?.error?.description || payload?.error?.reason || payload?.message;
        throw new Error(detail || `Razorpay API request failed for ${path}.`);
    }

    return payload;
}

async function safeReadJson(response) {
    try {
        return await response.json();
    } catch (_) {
        return null;
    }
}

function isValidRazorpaySignature(orderId, paymentId, signature) {
    const digest = crypto
        .createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    const left = Buffer.from(digest);
    const right = Buffer.from(signature);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validatePaymentAgainstAttempt(payment, attempt, orderId, options = {}) {
    if (!payment || payment.id == null) {
        throw new Error("Razorpay payment lookup failed.");
    }

    const paymentOrderId = String(payment.order_id || "").trim();
    const expectedOrderId = String(orderId || "").trim();
    if (paymentOrderId && expectedOrderId && paymentOrderId !== expectedOrderId) {
        throw new Error("Razorpay payment order does not match the returned order.");
    }

    if (!options.allowMissingOrderId && !paymentOrderId) {
        throw new Error("Razorpay payment order could not be resolved.");
    }

    if (!["authorized", "captured"].includes(String(payment.status || "").toLowerCase())) {
        throw new Error("Razorpay payment is not successful.");
    }

    if (Number(payment.amount) !== Number(attempt.amountPaise)) {
        throw new Error("Paid amount does not match the selected class.");
    }

    if (String(payment.currency || "").toUpperCase() !== "INR") {
        throw new Error("Payment currency does not match INR.");
    }
}

function validateOrderAgainstAttempt(order, attempt, attemptId) {
    if (!order || !order.id) {
        throw new Error("Razorpay order lookup failed.");
    }

    if (attempt.orderId && order.id !== attempt.orderId) {
        throw new Error("Razorpay order does not match the saved session.");
    }

    if (String(order.receipt || "") !== String(attempt.receipt || attemptId).slice(0, 40)) {
        throw new Error("Razorpay order receipt does not match the payment attempt.");
    }
}

async function verifyPaymentLinkAttempt({ attempt, paymentId, paymentLinkId, orderId }) {
    const paymentLink = await resolvePaymentLinkForAttempt({ paymentId, paymentLinkId, attempt });
    validatePaymentLinkAgainstAttempt(paymentLink, attempt, paymentLinkId, "", "");

    const resolvedPaymentId = String(paymentId || getPaymentIdFromPaymentLink(paymentLink) || "").trim();
    if (!resolvedPaymentId) {
        throw new Error("Razorpay payment link is paid, but payment id is not available yet.");
    }

    const payment = await razorpayRequest(`/v1/payments/${encodeURIComponent(resolvedPaymentId)}`, "GET");
    const resolvedOrderId = String(orderId || payment?.order_id || paymentLink?.order_id || "").trim();

    validatePaymentAgainstAttempt(payment, attempt, resolvedOrderId, { allowMissingOrderId: true });
    validatePaymentLinkAgainstAttempt(paymentLink, attempt, paymentLinkId, resolvedPaymentId, resolvedOrderId);

    return {
        payment,
        paymentId: resolvedPaymentId,
        orderId: resolvedOrderId,
        paymentLink
    };
}

function getPaymentIdFromPaymentLink(paymentLink) {
    const payments = Array.isArray(paymentLink?.payments) ? paymentLink.payments : [];
    const successfulPayment = payments.find((entry) => {
        const status = String(entry?.status || entry?.payment_status || "").trim().toLowerCase();
        return entry?.payment_id && (!status || ["authorized", "captured", "paid"].includes(status));
    });

    return successfulPayment?.payment_id || paymentLink?.payment_id || "";
}

async function resolvePaymentLinkForAttempt({ paymentId, paymentLinkId, attempt }) {
    const candidateId = String(paymentLinkId || attempt.paymentLinkId || "").trim();
    if (candidateId) {
        return razorpayRequest(`/v1/payment_links/${encodeURIComponent(candidateId)}`, "GET");
    }

    const paymentLinkList = await razorpayRequest(`/v1/payment_links?payment_id=${encodeURIComponent(paymentId)}`, "GET");
    const items = Array.isArray(paymentLinkList?.items) ? paymentLinkList.items : [];
    return items[0] || null;
}

function validatePaymentLinkAgainstAttempt(paymentLink, attempt, returnedPaymentLinkId, paymentId, orderId) {
    if (!paymentLink) {
        throw new Error("Razorpay payment link lookup failed.");
    }

    if (returnedPaymentLinkId && paymentLink.id !== returnedPaymentLinkId) {
        throw new Error("Returned Razorpay payment link does not match the verified payment.");
    }

    if (attempt.paymentLinkId && paymentLink.id !== attempt.paymentLinkId) {
        throw new Error("Razorpay payment link does not match the saved session.");
    }

    if (attempt.referenceId && paymentLink.reference_id !== attempt.referenceId) {
        throw new Error("Razorpay payment link reference does not match the saved session.");
    }

    const capturedPayments = Array.isArray(paymentLink.payments) ? paymentLink.payments : [];
    if (paymentId && capturedPayments.length > 0 && !capturedPayments.some((entry) => entry?.payment_id === paymentId)) {
        throw new Error("Razorpay payment link does not contain the verified payment.");
    }

    if (orderId && paymentLink.order_id && paymentLink.order_id !== orderId) {
        throw new Error("Razorpay payment link order does not match the verified payment.");
    }

    if (String(paymentLink.status || "").toLowerCase() !== "paid") {
        throw new Error("Razorpay payment link is not marked as paid.");
    }
}

async function grantKhazanaAccess({ uid, classLevel, payment, paymentId, orderId, attemptId, attemptRef, attempt }) {
    const classConfig = CLASS_CONFIG[classLevel];
    if (!classConfig) {
        throw new Error("Unknown class configuration.");
    }

    const paidAmountInr = Number.isFinite(Number(attempt.amountInr)) ? Number(attempt.amountInr) : classConfig.amountInr;
    const paidAmountPaise = Number.isFinite(Number(attempt.amountPaise)) ? Number(attempt.amountPaise) : Math.round(paidAmountInr * 100);
    const userAccessRef = firestore.collection("user_access").doc(uid);
    const purchaseRef = firestore.collection("purchases").doc();

    await firestore.runTransaction(async (transaction) => {
        const latestAttempt = await transaction.get(attemptRef);
        const latestAttemptData = latestAttempt.data() || {};
        if (latestAttemptData.status === "completed") {
            return;
        }

        transaction.set(purchaseRef, {
            user_id: uid,
            class_purchased: classLevel,
            purchase_status: "completed",
            amount_paid: paidAmountInr,
            amount_paid_paise: paidAmountPaise,
            currency: "INR",
            razorpay_payment_id: paymentId,
            razorpay_order_id: orderId,
            payment_state: payment.status || "captured",
            payment_source: attempt.flow || "checkout",
            payment_link_id: latestAttemptData.paymentLinkId || null,
            payment_attempt_id: attemptId,
            student: {
                name: String(latestAttemptData?.student?.name || attempt?.student?.name || "").trim(),
                email: String(latestAttemptData?.student?.email || attempt?.student?.email || "").trim(),
                mobile: String(latestAttemptData?.student?.mobile || attempt?.student?.mobile || "").trim()
            },
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.set(userAccessRef, {
            user_id: uid,
            purchased_classes: admin.firestore.FieldValue.arrayUnion(classLevel),
            classes: {
                [classLevel]: {
                    purchase_id: purchaseRef.id,
                    purchase_status: "completed",
                    unlocked_books: classConfig.bookIds,
                    purchased_at: new Date().toISOString(),
                    amount_paid: paidAmountInr,
                    razorpay_payment_id: paymentId,
                    razorpay_order_id: orderId
                }
            },
            updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.set(attemptRef, {
            status: "completed",
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            paymentId,
            orderId,
            purchaseId: purchaseRef.id,
            paymentState: payment.status || "captured",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });
}
