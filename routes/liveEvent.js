const fs = require("fs");
const path = require("path");
const express = require("express");

const PUBLIC_FIREBASE_CONFIG = {
    apiKey: "AIzaSyDF7arzKYkwsictuiYxYGkYrf6hRkpb9sI",
    authDomain: "science-sangrah-5067f.firebaseapp.com",
    projectId: "science-sangrah-5067f",
    storageBucket: "science-sangrah-5067f.firebasestorage.app",
    messagingSenderId: "560169611023",
    appId: "1:560169611023:web:8259c9db3d2020b4aa587a"
};

const EVENT_CONFIG_PATH = path.join(__dirname, "..", "..", "live-event", "firebase", "event-config.json");
const QUIZ_DATA_PATH = path.join(__dirname, "..", "..", "live-event", "firebase", "quiz-data.json");

module.exports = function createLiveEventRouter({ admin, projectId, databaseUrl }) {
    const router = express.Router();
    const realtimeDb = admin.database();
    const resolvedProjectId = String(projectId || PUBLIC_FIREBASE_CONFIG.projectId).trim() || PUBLIC_FIREBASE_CONFIG.projectId;
    const resolvedDatabaseUrl = String(databaseUrl || `https://${resolvedProjectId}-default-rtdb.firebaseio.com`).trim();

    router.get("/bootstrap", async (_req, res) => {
        try {
            const assets = loadEventAssets();
            const runtime = await ensureRuntime(realtimeDb, assets.config);

            res.setHeader("Cache-Control", "no-store, max-age=0");
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
};

function buildEventRootPath(eventId) {
    return `liveEvents/${eventId}`;
}

function buildRuntimePath(eventId) {
    return `${buildEventRootPath(eventId)}/runtime`;
}

function loadEventAssets() {
    const config = JSON.parse(fs.readFileSync(EVENT_CONFIG_PATH, "utf8"));
    const questions = JSON.parse(fs.readFileSync(QUIZ_DATA_PATH, "utf8"));

    if (!config?.eventId || !Array.isArray(questions) || questions.length === 0) {
        throw new Error("Live event configuration is incomplete.");
    }

    return { config, questions };
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
