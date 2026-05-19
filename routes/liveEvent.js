const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const PUBLIC_FIREBASE_CONFIG = {
    apiKey: "AIzaSyDF7arzKYkwsictuiYxYGkYrf6hRkpb9sI",
    authDomain: "science-sangrah-5067f.firebaseapp.com",
    projectId: "science-sangrah-5067f",
    storageBucket: "science-sangrah-5067f.firebasestorage.app",
    messagingSenderId: "560169611023",
    appId: "1:560169611023:web:8259c9db3d2020b4aa587a"
};

let cachedEventAssets = null;
let cachedEventAssetsSignature = "";

function createLiveEventRouter({ admin, projectId, databaseUrl }) {
    const router = express.Router();
    const realtimeDb = admin.database();
    const firestore = admin.firestore();
    const resolvedProjectId = String(projectId || PUBLIC_FIREBASE_CONFIG.projectId).trim() || PUBLIC_FIREBASE_CONFIG.projectId;
    const resolvedDatabaseUrl = String(databaseUrl || `https://${resolvedProjectId}-default-rtdb.firebaseio.com`).trim();
    const TEST_MODE_ALLOWED_ROLES = new Set(["admin", "superadmin", "manager", "editor", "mentor"]);
    const LIVE_EVENT_SESSION_PATH = ["liveEvent", "session", "current", "state"];

    function normalizeRole(value) {
        return String(value || "").trim().toLowerCase();
    }

    function isTestModeAllowedRole(role) {
        return TEST_MODE_ALLOWED_ROLES.has(normalizeRole(role));
    }

    async function getLiveEventSessionState() {
        const snapshot = await firestore
            .collection(LIVE_EVENT_SESSION_PATH[0])
            .doc(LIVE_EVENT_SESSION_PATH[1])
            .collection(LIVE_EVENT_SESSION_PATH[2])
            .doc(LIVE_EVENT_SESSION_PATH[3])
            .get();
        return snapshot.exists ? (snapshot.data() || {}) : {};
    }

    async function readVerifiedFirebaseUserFromRequest(req) {
        const authHeader = String(req.headers.authorization || "");
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
        if (!token) return null;
        return admin.auth().verifyIdToken(token);
    }

    async function resolveRoleFromIdentity(identity = {}) {
        const uid = String(identity.uid || identity.user_id || identity.sub || "").trim();
        const email = String(identity.email || "").trim().toLowerCase();

        if (uid) {
            const adminSnapshot = await firestore.collection("admins").doc(uid).get();
            if (adminSnapshot.exists) {
                const adminData = adminSnapshot.data() || {};
                const adminRole = normalizeRole(adminData.role || "admin");
                if (adminRole) {
                    return {
                        uid,
                        email,
                        role: adminRole,
                        isAuthenticated: true
                    };
                }
            }
        }

        if (email) {
            const adminQuery = await firestore.collection("admins").where("email", "==", email).limit(1).get();
            if (!adminQuery.empty) {
                const adminData = adminQuery.docs[0].data() || {};
                const adminRole = normalizeRole(adminData.role || "admin");
                if (adminRole) {
                    return {
                        uid: uid || String(adminData.uid || adminQuery.docs[0].id || "").trim(),
                        email,
                        role: adminRole,
                        isAuthenticated: true
                    };
                }
            }
        }

        if (uid) {
            const userSnapshot = await firestore.collection("users").doc(uid).get();
            if (userSnapshot.exists) {
                const userData = userSnapshot.data() || {};
                return {
                    uid,
                    email: email || String(userData.email || "").trim().toLowerCase(),
                    role: normalizeRole(userData.role || "student") || "student",
                    isAuthenticated: true
                };
            }
        }

        return {
            uid,
            email,
            role: uid || email ? "student" : "guest",
            isAuthenticated: Boolean(uid || email)
        };
    }

    async function resolveAccessState(req, options = {}) {
        const participantId = sanitizeParticipantId(options.participantId || req.body?.participantId || req.query?.participantId);
        const verifiedUser = await readVerifiedFirebaseUserFromRequest(req).catch(() => null);
        const identity = verifiedUser || (participantId ? { uid: participantId } : {});
        const resolvedIdentity = await resolveRoleFromIdentity(identity);
        const sessionState = await getLiveEventSessionState();
        const testMode = Boolean(sessionState.testMode);
        const allowed = !testMode || isTestModeAllowedRole(resolvedIdentity.role);

        return {
            ...resolvedIdentity,
            testMode,
            allowed,
            message: allowed
                ? ""
                : "Live Event test mode is active. Only admins and mentors can access the event right now."
        };
    }

    router.get("/access", async (req, res) => {
        try {
            const accessState = await resolveAccessState(req);
            res.setHeader("Cache-Control", "no-store, max-age=0");
            res.json({
                ok: true,
                testMode: accessState.testMode,
                allowed: accessState.allowed,
                role: accessState.role,
                authenticated: accessState.isAuthenticated,
                message: accessState.message
            });
        } catch (error) {
            console.error("Failed to resolve live event access:", error);
            res.status(500).json({
                message: error?.message || "Unable to verify live event access."
            });
        }
    });

    router.get("/bootstrap", async (req, res) => {
        try {
            const accessState = await resolveAccessState(req);
            res.setHeader("Cache-Control", "no-store, max-age=0");
            if (!accessState.allowed) {
                res.status(403).json({
                    ok: false,
                    testMode: true,
                    allowed: false,
                    role: accessState.role,
                    message: accessState.message
                });
                return;
            }

            const assets = loadEventAssets();
            const runtime = await ensureRuntime(realtimeDb, assets.config);

            res.json({
                ok: true,
                config: assets.config,
                questions: assets.questions,
                runtime,
                firebase: {
                    ...PUBLIC_FIREBASE_CONFIG,
                    projectId: resolvedProjectId,
                    databaseURL: resolvedDatabaseUrl
                }
            });
        } catch (error) {
            console.error("Failed to bootstrap live event:", error);
            res.status(500).json({
                message: error?.message || "Unable to bootstrap the live event."
            });
        }
    });

    router.get("/certificate", async (req, res) => {
        try {
            const verifiedUser = await readVerifiedFirebaseUserFromRequest(req).catch(() => null);
            const uid = String(verifiedUser?.uid || verifiedUser?.user_id || "").trim();

            if (!uid) {
                res.status(401).json({
                    eligible: false,
                    reason: "auth_required",
                    message: "Please login first to download your certificate."
                });
                return;
            }

            const [participantSnapshot, leaderboardSnapshot, sessionSnapshot, adminSnapshot, userSnapshot] = await Promise.all([
                firestore.collection("liveEvent").doc("session").collection("participants").doc(uid).get(),
                firestore.collection("liveEvent").doc("session").collection("leaderboard").doc(uid).get(),
                firestore.collection("liveEvent").doc("session").collection("current").doc("state").get(),
                firestore.collection("admins").doc(uid).get(),
                firestore.collection("users").doc(uid).get()
            ]);

            const participant = participantSnapshot.exists ? (participantSnapshot.data() || {}) : null;
            const leaderboard = leaderboardSnapshot.exists ? (leaderboardSnapshot.data() || {}) : null;
            const adminProfile = adminSnapshot.exists ? (adminSnapshot.data() || {}) : null;
            const userProfile = userSnapshot.exists ? (userSnapshot.data() || {}) : null;
            const eligibility = resolveCertificateEligibility({ participant, leaderboard, adminProfile });

            if (!eligibility.eligible) {
                const denialMessageByReason = {
                    participation_not_found: "Certificate is not available for this account.",
                    leaderboard_not_published: "Certificate will be available after final rankings are published.",
                    rank_not_eligible: "Certificate is not available for this account."
                };

                res.setHeader("Cache-Control", "no-store, max-age=0");
                res.status(403).json({
                    eligible: false,
                    reason: eligibility.reason,
                    message: denialMessageByReason[eligibility.reason] || "Certificate is not available for this account."
                });
                return;
            }

            const sessionData = sessionSnapshot.exists ? (sessionSnapshot.data() || {}) : {};
            const studentName = String(
                leaderboard?.fullName
                || leaderboard?.name
                || leaderboard?.displayName
                || participant?.fullName
                || participant?.name
                || participant?.displayName
                || adminProfile?.displayName
                || adminProfile?.name
                || userProfile?.fullName
                || userProfile?.name
                || userProfile?.displayName
                || "Learner"
            ).trim() || "Learner";
            const districtName = String(
                participant?.district
                || leaderboard?.district
                || userProfile?.district
                || participant?.city
                || userProfile?.city
                || userProfile?.location
                || participant?.location
                || ""
            ).trim();

            res.setHeader("Cache-Control", "no-store, max-age=0");
            res.json({
                eligible: true,
                studentName,
                districtName,
                uniqueId: uid,
                publishedRank: Number(leaderboard?.publishedRank || 0),
                certificateId: buildCertificateId("science-sangrah-live-quiz-2026-05-15", uid),
                eventLabel: String(sessionData.eventLabel || sessionData.eventTitle || "Science Sangrah Live Event").trim() || "Science Sangrah Live Event",
                eventDateLabel: "15 May 2026"
            });
        } catch (error) {
            console.error("Failed to verify live event certificate eligibility:", error);
            res.status(500).json({
                eligible: false,
                reason: "verification_failed",
                message: "Unable to verify certificate right now."
            });
        }
    });

    router.post("/sync", async (req, res) => {
        try {
            const assets = loadEventAssets();
            const eventId = sanitizeEventId(req.body?.eventId);
            const action = String(req.body?.action || "").trim().toLowerCase();

            if (eventId !== assets.config.eventId) {
                res.status(400).json({ message: "Unknown live event." });
                return;
            }

            if (!["start", "end", "complete"].includes(action)) {
                res.status(400).json({ message: "Unsupported sync action." });
                return;
            }

            const runtimeRef = realtimeDb.ref(buildRuntimePath(eventId));
            await runtimeRef.transaction((current) => applyLifecycleAction(current, assets.config, action, admin));
            const runtimeSnapshot = await runtimeRef.get();

            res.json({
                ok: true,
                runtime: runtimeSnapshot.val() || {}
            });
        } catch (error) {
            console.error("Failed to sync live event state:", error);
            res.status(500).json({
                message: error?.message || "Unable to sync the live event state."
            });
        }
    });

    router.post("/vote", async (req, res) => {
        try {
            const assets = loadEventAssets();
            const eventId = sanitizeEventId(req.body?.eventId);
            const participantId = sanitizeParticipantId(req.body?.participantId);
            const participantName = sanitizeParticipantName(req.body?.participantName);
            const questionIndex = Number(req.body?.questionIndex);
            const option = String(req.body?.option || "").trim().toUpperCase();
            const accessState = await resolveAccessState(req, { participantId });

            if (eventId !== assets.config.eventId) {
                res.status(400).json({ message: "Unknown live event." });
                return;
            }

            if (!participantId || !participantName) {
                res.status(400).json({ message: "Participant identity is required." });
                return;
            }

            if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= assets.questions.length) {
                res.status(400).json({ message: "Question index is invalid." });
                return;
            }

            if (!["A", "B", "C", "D"].includes(option)) {
                res.status(400).json({ message: "Vote option is invalid." });
                return;
            }

            if (!accessState.allowed) {
                res.status(403).json({ message: accessState.message });
                return;
            }

            const rootPath = buildEventRootPath(eventId);
            const runtimeSnapshot = await realtimeDb.ref(`${rootPath}/runtime`).get();
            const runtime = runtimeSnapshot.val() || {};
            const derived = deriveTimeline(runtime, assets.config, assets.questions.length, Date.now());

            if (derived.status !== "live" || derived.phase !== "answering" || derived.questionIndex !== questionIndex) {
                res.status(409).json({ message: "Voting is closed for this question." });
                return;
            }

            const question = assets.questions[questionIndex];
            const latencyMs = Math.max(0, Date.now() - derived.answerStartedAtMs);
            const responseTimeSec = Math.max(0, Math.min(Number(assets.config.answerTimeSec || 0), Math.round(latencyMs / 1000)));
            const isCorrect = option === question.correct;
            const points = isCorrect ? 100 + Math.max(0, Number(assets.config.answerTimeSec || 0) - responseTimeSec) : 0;
            const answerPayload = {
                option,
                displayName: participantName,
                questionIndex,
                correct: isCorrect,
                points,
                latencyMs,
                submittedAt: Date.now()
            };

            const answerRef = realtimeDb.ref(`${rootPath}/answers/${question.key}/${participantId}`);
            const answerTransaction = await answerRef.transaction((current) => (current == null ? answerPayload : current));
            if (!answerTransaction.committed) {
                res.status(409).json({
                    message: "You have already voted for this question.",
                    answer: answerTransaction.snapshot.val() || null
                });
                return;
            }

            const shardId = buildShardId(participantId, Number(assets.config.voteShardCount || 16));
            const shardRef = realtimeDb.ref(`${rootPath}/voteShards/${question.key}/${option}/${shardId}`);
            await shardRef.transaction((current) => Number(current || 0) + 1);

            const leaderboardRef = realtimeDb.ref(`${rootPath}/leaderboard/${participantId}`);
            const leaderboardTransaction = await leaderboardRef.transaction((current) => {
                const score = Number(current?.score || 0) + points;
                const correct = Number(current?.correct || 0) + (isCorrect ? 1 : 0);
                const answered = Number(current?.answered || 0) + 1;
                const existingFastestMs = Number(current?.fastestMs || 0);
                const nextFastestMs = isCorrect
                    ? (existingFastestMs > 0 ? Math.min(existingFastestMs, latencyMs) : latencyMs)
                    : existingFastestMs;

                return {
                    displayName: participantName,
                    score,
                    correct,
                    answered,
                    fastestMs: nextFastestMs,
                    updatedAt: Date.now()
                };
            });

            const participantStats = leaderboardTransaction.snapshot.val() || {
                score: points,
                correct: isCorrect ? 1 : 0,
                answered: 1,
                fastestMs: isCorrect ? latencyMs : 0
            };

            res.json({
                ok: true,
                answer: answerPayload,
                participantStats
            });
        } catch (error) {
            console.error("Failed to submit live event vote:", error);
            res.status(500).json({
                message: error?.message || "Unable to submit the vote."
            });
        }
    });

    return router;
}

function buildEventRootPath(eventId) {
    return `liveEvents/${eventId}`;
}

function buildRuntimePath(eventId) {
    return `${buildEventRootPath(eventId)}/runtime`;
}

function loadEventAssets() {
    const eventConfigPath = resolveEventAssetPath("event-config.json");
    const quizDataPath = resolveEventAssetPath("quiz-data.json");
    const configStats = fs.statSync(eventConfigPath);
    const questionStats = fs.statSync(quizDataPath);
    const nextSignature = [
        eventConfigPath,
        configStats.mtimeMs,
        configStats.size,
        quizDataPath,
        questionStats.mtimeMs,
        questionStats.size
    ].join(":");

    if (cachedEventAssets && cachedEventAssetsSignature === nextSignature) {
        return cachedEventAssets;
    }

    const config = JSON.parse(fs.readFileSync(eventConfigPath, "utf8"));
    const questions = JSON.parse(fs.readFileSync(quizDataPath, "utf8"));

    if (!config?.eventId || !Array.isArray(questions) || questions.length === 0) {
        throw new Error("Live event configuration is incomplete.");
    }

    cachedEventAssets = { config, questions };
    cachedEventAssetsSignature = nextSignature;
    return cachedEventAssets;
}

function buildEventAssetPathCandidates(filename, options = {}) {
    const cwd = options.cwd || process.cwd();
    const dirname = options.dirname || __dirname;

    return [
        path.resolve(cwd, "backend", "live-event", "firebase", filename),
        path.resolve(dirname, "..", "live-event", "firebase", filename),
        path.resolve(cwd, "live-event", "firebase", filename),
        path.resolve(dirname, "..", "..", "live-event", "firebase", filename)
    ];
}

function resolveEventAssetPath(filename, options = {}) {
    const existsSync = options.existsSync || fs.existsSync;
    const candidates = buildEventAssetPathCandidates(filename, options);
    const resolvedPath = candidates.find((candidatePath) => existsSync(candidatePath));

    if (resolvedPath) {
        return resolvedPath;
    }

    throw new Error(`Live event asset not found: ${filename}`);
}

async function ensureRuntime(realtimeDb, config) {
    const runtimeRef = realtimeDb.ref(buildRuntimePath(config.eventId));
    await runtimeRef.transaction((current) => {
        if (current && typeof current === "object") {
            return {
                seed: Number(current.seed || config.engagementSeed || 1),
                status: String(current.status || "pending").toLowerCase(),
                startedAt: Number(current.startedAt || 0),
                endedAt: Number(current.endedAt || 0),
                updatedAt: Number(current.updatedAt || Date.now()),
                youtubeState: String(current.youtubeState || "idle")
            };
        }

        return {
            seed: Number(config.engagementSeed || 1),
            status: "pending",
            startedAt: 0,
            endedAt: 0,
            updatedAt: Date.now(),
            youtubeState: "idle"
        };
    });

    const snapshot = await runtimeRef.get();
    return snapshot.val() || {};
}

function applyLifecycleAction(current, config, action, admin) {
    const base = current && typeof current === "object"
        ? current
        : {
            seed: Number(config.engagementSeed || 1),
            status: "pending",
            startedAt: 0,
            endedAt: 0,
            updatedAt: 0,
            youtubeState: "idle"
        };

    if (action === "start") {
        if (String(base.status || "").toLowerCase() === "ended") {
            return base;
        }

        return {
            ...base,
            status: "live",
            startedAt: Number(base.startedAt || 0) > 0 ? Number(base.startedAt) : admin.database.ServerValue.TIMESTAMP,
            endedAt: 0,
            youtubeState: "live",
            seed: Number(base.seed || config.engagementSeed || 1),
            updatedAt: admin.database.ServerValue.TIMESTAMP
        };
    }

    if (action === "end" || action === "complete") {
        if (Number(base.startedAt || 0) <= 0 && action === "complete") {
            return base;
        }

        return {
            ...base,
            status: "ended",
            youtubeState: action === "end" ? "ended" : "complete",
            endedAt: Number(base.endedAt || 0) > 0 ? Number(base.endedAt) : admin.database.ServerValue.TIMESTAMP,
            updatedAt: admin.database.ServerValue.TIMESTAMP
        };
    }

    return base;
}

function deriveTimeline(runtime, config, questionCount, nowMs) {
    const answerTimeMs = Number(config.answerTimeSec || 0) * 1000;
    const lockTimeMs = Number(config.lockTimeSec || 0) * 1000;
    const explainTimeMs = Number(config.explainTimeSec || 0) * 1000;
    const cycleMs = answerTimeMs + lockTimeMs + explainTimeMs;
    const totalDurationMs = Math.max(0, questionCount) * cycleMs;

    const safeRuntime = runtime || {};
    const status = String(safeRuntime.status || "pending").toLowerCase();
    const startedAt = Number(safeRuntime.startedAt || 0);
    const endedAt = Number(safeRuntime.endedAt || 0);
    const effectiveNowMs = endedAt > 0 ? Math.min(nowMs, endedAt) : nowMs;

    if (!startedAt || status === "pending") {
        return {
            status: "pending",
            phase: "waiting",
            questionIndex: 0,
            answerStartedAtMs: 0
        };
    }

    const elapsedMs = Math.max(0, effectiveNowMs - startedAt);
    if (status === "ended" || elapsedMs >= totalDurationMs) {
        const cappedIndex = Math.max(0, Math.min(questionCount - 1, Math.floor(Math.max(0, Math.min(elapsedMs, Math.max(0, totalDurationMs - 1))) / Math.max(cycleMs, 1))));
        return {
            status: "ended",
            phase: "ended",
            questionIndex: cappedIndex,
            answerStartedAtMs: startedAt + (cappedIndex * cycleMs)
        };
    }

    const questionIndex = Math.min(questionCount - 1, Math.floor(elapsedMs / cycleMs));
    const withinQuestionMs = elapsedMs % cycleMs;
    const answerStartedAtMs = startedAt + (questionIndex * cycleMs);

    if (withinQuestionMs < answerTimeMs) {
        return {
            status: "live",
            phase: "answering",
            questionIndex,
            answerStartedAtMs
        };
    }

    if (withinQuestionMs < (answerTimeMs + lockTimeMs)) {
        return {
            status: "live",
            phase: "locked",
            questionIndex,
            answerStartedAtMs
        };
    }

    return {
        status: "live",
        phase: "explaining",
        questionIndex,
        answerStartedAtMs
    };
}

function buildShardId(participantId, shardCount) {
    const totalShards = Math.max(1, Math.min(64, Number(shardCount || 16)));
    let hash = 0;
    for (let index = 0; index < participantId.length; index += 1) {
        hash = ((hash << 5) - hash) + participantId.charCodeAt(index);
        hash |= 0;
    }
    const slot = Math.abs(hash) % totalShards;
    return `shard-${String(slot).padStart(2, "0")}`;
}

function sanitizeEventId(value) {
    return String(value || "").trim();
}

function sanitizeParticipantId(value) {
    const sanitized = String(value || "").trim();
    return /^[a-zA-Z0-9_-]{4,64}$/.test(sanitized) ? sanitized : "";
}

function sanitizeParticipantName(value) {
    const sanitized = String(value || "").trim().replace(/\s+/g, " ");
    return sanitized.slice(0, 48);
}

function resolveCertificateEligibility({ participant, leaderboard, adminProfile }) {
    const adminRole = String(adminProfile?.role || "").trim().toLowerCase();
    const adminStatus = String(adminProfile?.status || "").trim().toLowerCase();
    if (adminRole === "admin" && adminStatus === "active") {
        return { eligible: true, reason: "", viaAdminOverride: true };
    }

    if (!participant) {
        return { eligible: false, reason: "participation_not_found" };
    }

    if (!leaderboard) {
        return { eligible: false, reason: "leaderboard_not_published" };
    }

    const publishedRank = Number(leaderboard.publishedRank || 0);
    if (!Number.isFinite(publishedRank) || publishedRank <= 0) {
        return { eligible: false, reason: "leaderboard_not_published" };
    }

    if (publishedRank > 100) {
        return { eligible: false, reason: "rank_not_eligible" };
    }

    return { eligible: true, reason: "" };
}

function buildCertificateId(eventSlug, uid) {
    const digest = crypto
        .createHash("sha256")
        .update(`${String(eventSlug || "").trim()}::${String(uid || "").trim()}`)
        .digest("hex")
        .slice(0, 8)
        .toUpperCase();

    return `SS-LIVE-20260515-${digest}`;
}

createLiveEventRouter._test = {
    buildEventAssetPathCandidates,
    resolveEventAssetPath,
    resolveCertificateEligibility,
    buildCertificateId
};

module.exports = createLiveEventRouter;
