const crypto = require("crypto");
const path = require("path");
const qrcode = require("qrcode-terminal");
const PQueue = require("p-queue").default;

let Client = null;
let LocalAuth = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require("whatsapp-web.js"));
} catch (error) {
    dependencyLoadError = error;
}

const DEFAULT_COUNTRY_CODE = "91";
const DUPLICATE_TTL_MS = 15 * 60 * 1000;
const LOG_LIMIT = 250;
const DEFAULT_RATE_LIMIT_MS = 5000;
const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_DELAY_MS = 1500;
const RECONNECT_DELAY_MS = 5000;

const queue = new PQueue({
    concurrency: 1,
    interval: 60000,
    intervalCap: 40
});

let isReady = false;

const serviceState = {
    mode: isLiveModeEnabled() ? "live" : "mock",
    connection: isLiveModeEnabled() ? "disconnected" : "mock",
    lastError: "",
    client: null,
    initPromise: null,
    reconnectTimer: null,
    queueDepth: 0,
    logs: [],
    duplicateSends: new Map(),
    lastCampaigns: [],
    lastQr: null
};

function isLiveModeEnabled() {
    return String(process.env.WHATSAPP_ENABLED || "").trim().toLowerCase() === "true";
}

function buildWhatsAppSetupMessage() {
    if (!isLiveModeEnabled()) {
        return "Live sending is disabled. Set WHATSAPP_ENABLED=true in backend/.env, restart the backend, and scan the QR once.";
    }

    if (serviceState.connection === "open") {
        return "Live sending is active and WhatsApp is connected.";
    }

    if (serviceState.lastQr) {
        return "Open the backend terminal and scan the WhatsApp QR code from Linked Devices.";
    }

    if (serviceState.lastError) {
        return serviceState.lastError;
    }

    if (serviceState.connection === "connecting") {
        return "WhatsApp is connecting. Keep the backend terminal open while the session starts.";
    }

    return "WhatsApp is enabled but not connected yet. Restart the backend and scan the QR code from Linked Devices.";
}

function normalizeWhatsAppPhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) {
        return "";
    }

    if (digits.length === 10) {
        return `${DEFAULT_COUNTRY_CODE}${digits}`;
    }

    if (digits.length === 12 && digits.startsWith(DEFAULT_COUNTRY_CODE)) {
        return digits;
    }

    if (digits.length === 11 && digits.startsWith("0")) {
        return `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
    }

    return digits.length >= 11 && digits.length <= 15 ? digits : "";
}

function validateWhatsAppPhone(phone) {
    const normalized = normalizeWhatsAppPhone(phone);
    if (!normalized) {
        return {
            isValid: false,
            normalized: "",
            reason: "Invalid phone number"
        };
    }

    return {
        isValid: true,
        normalized,
        reason: ""
    };
}

function buildEmiReminderMessage(student) {
    return [
        `Hi ${student?.name || "Student"},`,
        "",
        `Aapka EMI Rs.${formatNumber(student?.pending)} pending hai.`,
        "Please jaldi clear karein.",
        "",
        `Batch: ${student?.batch || "-"}`,
        "",
        "Thank you"
    ].join("\n");
}

function buildOfferMessage(student, customMessage = "") {
    return [
        `Hi ${student?.name || "Student"},`,
        "",
        "New batch launch ho gaya hai.",
        "",
        "Offer:",
        customMessage || "Limited period ke liye special guidance aur enrolment support available hai.",
        "",
        "Interested ho to reply karein."
    ].join("\n");
}

function buildCustomMessage(student, customMessage = "") {
    return [
        `Hi ${student?.name || "Student"},`,
        "",
        customMessage || "Admin ne aapke liye ek message share kiya hai.",
        "",
        "Reply karke batayein agar aapko help chahiye."
    ].join("\n");
}

function renderMessageTemplate(student, template = {}) {
    const kind = String(template.kind || "emi_reminder").trim().toLowerCase();
    if (kind === "offer") {
        return buildOfferMessage(student, template.customMessage);
    }

    if (kind === "custom") {
        return buildCustomMessage(student, template.customMessage);
    }

    return buildEmiReminderMessage(student);
}

function createCampaignDraft(options = {}) {
    const sourceStudents = Array.isArray(options.students) ? options.students : [];
    const audienceType = resolveAudienceType(options);
    const batch = normalizeText(options.batch);
    const agent = normalizeText(options.agent);
    const messageType = resolveMessageType(options);
    const customMessage = normalizeMultilineText(options.customMessage);
    const singleStudent = options.student || null;

    let selectedStudents = sourceStudents.slice();

    if (audienceType === "single") {
        selectedStudents = singleStudent ? [singleStudent] : [];
    } else if (audienceType === "pending") {
        selectedStudents = selectedStudents.filter((student) => safeNumber(student?.pending) > 0);
    } else if (audienceType === "paid") {
        selectedStudents = selectedStudents.filter((student) => safeNumber(student?.pending) <= 0);
    }

    if (batch) {
        selectedStudents = selectedStudents.filter((student) => normalizeText(student?.batch) === batch);
    }

    if (agent) {
        selectedStudents = selectedStudents.filter((student) => normalizeText(student?.agent) === agent);
    }

    const uniqueRecipients = [];
    const skipped = [];
    const seenRecipientKeys = new Set();

    selectedStudents.forEach((student) => {
        const validation = validateWhatsAppPhone(student?.phone);
        const recipientKey = validation.normalized || `fallback:${normalizeText(student?.name)}:${normalizeText(student?.batch)}`;

        if (seenRecipientKeys.has(recipientKey)) {
            skipped.push({
                name: student?.name || "",
                phone: student?.phone || "",
                reason: "Duplicate recipient"
            });
            return;
        }

        seenRecipientKeys.add(recipientKey);

        if (!validation.isValid) {
            skipped.push({
                name: student?.name || "",
                phone: student?.phone || "",
                reason: validation.reason
            });
            return;
        }

        uniqueRecipients.push({
            ...student,
            phone: validation.normalized
        });
    });

    const template = {
        kind: messageType,
        customMessage
    };
    const firstRecipient = uniqueRecipients[0] || singleStudent || sourceStudents[0] || null;

    return {
        id: crypto.randomUUID ? crypto.randomUUID() : `campaign-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: normalizeText(options.intent) || (audienceType === "single" ? "send_whatsapp_single" : "send_whatsapp_bulk"),
        audienceType,
        audienceLabel: buildAudienceLabel({
            audienceType,
            batch,
            agent
        }),
        filters: {
            batch,
            agent
        },
        messageType,
        template,
        customMessage,
        students: uniqueRecipients,
        count: uniqueRecipients.length,
        preview: firstRecipient ? renderMessageTemplate(firstRecipient, template) : "",
        previewStudent: firstRecipient
            ? {
                name: firstRecipient.name || "",
                phone: firstRecipient.phone || "",
                batch: firstRecipient.batch || "",
                pending: safeNumber(firstRecipient.pending)
            }
            : null,
        skipped,
        summary: {
            validRecipients: uniqueRecipients.length,
            skippedRecipients: skipped.length
        }
    };
}

function resolveAudienceType(options = {}) {
    const explicitAudience = String(options.audienceType || options.audience || "").trim().toLowerCase();
    if (explicitAudience) {
        return explicitAudience;
    }

    if (options.student) {
        return "single";
    }

    if (options.intent === "send_offer") {
        return "all";
    }

    return "pending";
}

function resolveMessageType(options = {}) {
    const explicitType = String(options.messageType || "").trim().toLowerCase();
    if (explicitType === "offer" || explicitType === "custom" || explicitType === "emi_reminder") {
        return explicitType;
    }

    if (options.intent === "send_offer") {
        return "offer";
    }

    if (normalizeMultilineText(options.customMessage)) {
        return "custom";
    }

    return "emi_reminder";
}

function buildAudienceLabel({ audienceType, batch, agent }) {
    const qualifiers = [];
    if (batch) {
        qualifiers.push(`batch ${batch}`);
    }
    if (agent) {
        qualifiers.push(`agent ${agent}`);
    }

    const suffix = qualifiers.length ? ` (${qualifiers.join(", ")})` : "";

    if (audienceType === "single") {
        return `selected student${suffix}`;
    }
    if (audienceType === "paid") {
        return `paid students${suffix}`;
    }
    if (audienceType === "all") {
        return `all students${suffix}`;
    }

    return `pending students${suffix}`;
}

async function enqueueSendTask(task) {
    serviceState.queueDepth += 1;

    try {
        return await queue.add(async () => task());
    } finally {
        serviceState.queueDepth = Math.max(serviceState.queueDepth - 1, 0);
    }
}

async function sendWhatsAppMessage(phone, message, options = {}) {
    const validation = validateWhatsAppPhone(phone);
    const normalizedMessage = normalizeMultilineText(message);
    const dedupeKey = options.dedupeKey || buildDuplicateKey(validation.normalized, normalizedMessage);
    const now = Date.now();

    pruneDuplicateCache(now);

    if (!validation.isValid) {
        const invalidResult = {
            ok: false,
            status: "invalid_phone",
            phone: String(phone || ""),
            normalizedPhone: "",
            message: normalizedMessage,
            mode: serviceState.mode,
            reason: validation.reason
        };
        logWhatsApp(invalidResult);
        return invalidResult;
    }

    if (!normalizedMessage) {
        const emptyResult = {
            ok: false,
            status: "empty_message",
            phone: String(phone || ""),
            normalizedPhone: validation.normalized,
            message: "",
            mode: serviceState.mode,
            reason: "Message is empty"
        };
        logWhatsApp(emptyResult);
        return emptyResult;
    }

    const cachedDuplicate = serviceState.duplicateSends.get(dedupeKey);
    if (cachedDuplicate && now - cachedDuplicate.time < DUPLICATE_TTL_MS) {
        const duplicateResult = {
            ok: false,
            status: "duplicate_skipped",
            phone: String(phone || ""),
            normalizedPhone: validation.normalized,
            message: normalizedMessage,
            mode: serviceState.mode,
            reason: "Duplicate send prevented"
        };
        logWhatsApp(duplicateResult);
        return duplicateResult;
    }

    const retryLimit = resolvePositiveNumber(options.retryLimit, DEFAULT_RETRY_LIMIT);
    const retryDelayMs = resolvePositiveNumber(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        try {
            const transportResult = await sendViaConfiguredTransport(validation.normalized, normalizedMessage);
            serviceState.duplicateSends.set(dedupeKey, {
                time: Date.now()
            });

            const successResult = {
                ok: true,
                status: serviceState.mode === "live" ? "sent" : "mock_sent",
                phone: String(phone || ""),
                normalizedPhone: validation.normalized,
                message: normalizedMessage,
                mode: serviceState.mode,
                transport: transportResult.transport,
                attempt: attempt + 1
            };
            logWhatsApp(successResult);
            return successResult;
        } catch (error) {
            serviceState.lastError = error?.message || "WhatsApp send failed";

            if (attempt >= retryLimit) {
                const failureResult = {
                    ok: false,
                    status: isWhatsAppReady() ? "failed" : "not_ready",
                    phone: String(phone || ""),
                    normalizedPhone: validation.normalized,
                    message: normalizedMessage,
                    mode: serviceState.mode,
                    reason: serviceState.lastError,
                    attempt: attempt + 1
                };
                logWhatsApp(failureResult);
                return failureResult;
            }

            await sleep(retryDelayMs * (attempt + 1));
        }
    }

    return {
        ok: false,
        status: "failed",
        phone: String(phone || ""),
        normalizedPhone: validation.normalized,
        message: normalizedMessage,
        mode: serviceState.mode,
        reason: "Unknown WhatsApp error"
    };
}

async function sendBulkWhatsApp(students, messageTemplate, options = {}) {
    const recipients = Array.isArray(students) ? students : [];
    const requestedDelayMs = resolvePositiveNumber(options.rateLimitMs, DEFAULT_RATE_LIMIT_MS);
    const rateLimitMs = serviceState.mode === "live"
        ? Math.max(requestedDelayMs, DEFAULT_RATE_LIMIT_MS)
        : requestedDelayMs;
    const results = [];

    for (let index = 0; index < recipients.length; index += 1) {
        const student = recipients[index];
        const message = typeof messageTemplate === "function"
            ? normalizeMultilineText(messageTemplate(student))
            : renderMessageTemplate(student, messageTemplate);
        const dedupeKey = buildDuplicateKey(normalizeWhatsAppPhone(student?.phone), message);
        const result = await sendWhatsAppMessage(student?.phone, message, {
            ...options,
            dedupeKey
        });

        results.push({
            ...result,
            student: {
                name: student?.name || "",
                phone: student?.phone || "",
                batch: student?.batch || "",
                pending: safeNumber(student?.pending)
            }
        });

        if (index < recipients.length - 1) {
            await sleep(rateLimitMs);
        }
    }

    const summary = summarizeBulkResults(results);
    const campaignRecord = {
        id: options.campaignId || (crypto.randomUUID ? crypto.randomUUID() : `campaign-${Date.now()}`),
        type: normalizeText(options.type) || "broadcast",
        count: recipients.length,
        messageType: normalizeText(messageTemplate?.kind) || "emi_reminder",
        messagePreview: results[0]?.message || "",
        summary,
        createdAt: new Date().toISOString()
    };

    serviceState.lastCampaigns.unshift(campaignRecord);
    serviceState.lastCampaigns = serviceState.lastCampaigns.slice(0, 20);

    return {
        ok: summary.failedCount === 0,
        mode: serviceState.mode,
        summary,
        results,
        campaign: campaignRecord
    };
}

function summarizeBulkResults(results) {
    return (Array.isArray(results) ? results : []).reduce((summary, result) => {
        summary.total += 1;

        if (result?.ok) {
            summary.successCount += 1;
        } else if (result?.status === "duplicate_skipped") {
            summary.duplicateCount += 1;
        } else if (result?.status === "invalid_phone") {
            summary.invalidCount += 1;
        } else {
            summary.failedCount += 1;
        }

        return summary;
    }, {
        total: 0,
        successCount: 0,
        failedCount: 0,
        duplicateCount: 0,
        invalidCount: 0
    });
}

async function sendViaConfiguredTransport(normalizedPhone, message) {
    if (!isLiveModeEnabled()) {
        serviceState.mode = "mock";
        serviceState.connection = "mock";
        await sleep(50);
        return {
            transport: "mock"
        };
    }

    await ensureWhatsAppConnection();

    if (!serviceState.client || !isReady) {
        throw new Error("WhatsApp not ready");
    }

    serviceState.mode = "live";
    const chatId = `${normalizedPhone}@c.us`;

    await enqueueSendTask(async () => {
        await serviceState.client.sendMessage(chatId, message);
    });

    return {
        transport: "whatsapp-web.js"
    };
}

async function ensureWhatsAppConnection() {
    if (!isLiveModeEnabled()) {
        resetMockState();
        return getWhatsAppStatus();
    }

    serviceState.mode = "live";

    if (dependencyLoadError || !Client || !LocalAuth) {
        serviceState.connection = "failed";
        serviceState.lastError = "whatsapp-web.js is not installed. Run npm install whatsapp-web.js qrcode-terminal p-queue in backend.";
        return getWhatsAppStatus();
    }

    if (isReady && serviceState.client) {
        return getWhatsAppStatus();
    }

    if (serviceState.initPromise) {
        try {
            await serviceState.initPromise;
        } catch (_) {
            // Status is exposed through getWhatsAppStatus().
        }
        return getWhatsAppStatus();
    }

    if (!serviceState.client) {
        try {
            await initializeWhatsAppClient();
        } catch (_) {
            // Status is exposed through getWhatsAppStatus().
        }
    }

    return getWhatsAppStatus();
}

async function initWhatsApp() {
    return ensureWhatsAppConnection();
}

function isWhatsAppReady() {
    return serviceState.mode === "live" && serviceState.connection === "open" && isReady;
}

async function initializeWhatsAppClient() {
    clearReconnectTimer();
    serviceState.connection = "connecting";
    serviceState.lastError = "";
    serviceState.lastQr = null;

    const nextClient = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.resolve(__dirname, "..", ".wwebjs_auth")
        }),
        puppeteer: {
            headless: true
        }
    });

    registerClientEvents(nextClient);
    serviceState.client = nextClient;

    const initPromise = nextClient.initialize()
        .catch((error) => {
            if (serviceState.client === nextClient) {
                serviceState.connection = "failed";
                serviceState.lastError = error?.message || "Unable to initialize WhatsApp.";
                serviceState.client = null;
                isReady = false;
            }
            scheduleReconnect();
            throw error;
        })
        .finally(() => {
            if (serviceState.initPromise === initPromise) {
                serviceState.initPromise = null;
            }
        });

    serviceState.initPromise = initPromise;
    return initPromise;
}

function registerClientEvents(nextClient) {
    nextClient.on("qr", (qr) => {
        serviceState.connection = "connecting";
        serviceState.lastQr = qr;
        serviceState.lastError = "";
        isReady = false;
        console.log("Scan this WhatsApp QR from Linked Devices:");
        qrcode.generate(qr, { small: true });
    });

    nextClient.on("authenticated", () => {
        serviceState.connection = "connecting";
        serviceState.lastError = "";
    });

    nextClient.on("ready", () => {
        console.log("WhatsApp connected successfully");
        isReady = true;
        serviceState.connection = "open";
        serviceState.lastError = "";
        serviceState.lastQr = null;
        clearReconnectTimer();
    });

    nextClient.on("auth_failure", (message) => {
        console.error("WhatsApp authentication failed:", message);
        isReady = false;
        serviceState.connection = "failed";
        serviceState.lastError = String(message || "WhatsApp authentication failed");
        serviceState.lastQr = null;
        if (serviceState.client === nextClient) {
            serviceState.client = null;
        }
        scheduleReconnect();
    });

    nextClient.on("disconnected", (reason) => {
        console.log("WhatsApp disconnected:", reason || "unknown reason");
        isReady = false;
        serviceState.connection = "disconnected";
        serviceState.lastError = reason ? `WhatsApp disconnected: ${reason}` : serviceState.lastError;
        serviceState.lastQr = null;
        if (serviceState.client === nextClient) {
            serviceState.client = null;
        }
        scheduleReconnect();
    });
}

function resetMockState() {
    isReady = false;
    clearReconnectTimer();
    serviceState.mode = "mock";
    serviceState.connection = "mock";
    serviceState.client = null;
    serviceState.initPromise = null;
    serviceState.lastError = "";
    serviceState.lastQr = null;
}

function clearReconnectTimer() {
    if (serviceState.reconnectTimer) {
        clearTimeout(serviceState.reconnectTimer);
        serviceState.reconnectTimer = null;
    }
}

function scheduleReconnect() {
    if (serviceState.reconnectTimer || !isLiveModeEnabled()) {
        return;
    }

    serviceState.reconnectTimer = setTimeout(async () => {
        serviceState.reconnectTimer = null;
        if (serviceState.client || serviceState.initPromise || isReady) {
            return;
        }

        try {
            await ensureWhatsAppConnection();
        } catch (error) {
            serviceState.lastError = error?.message || "Unable to reconnect WhatsApp.";
            scheduleReconnect();
        }
    }, RECONNECT_DELAY_MS);
}

function logWhatsApp(entry = {}) {
    const logEntry = {
        id: crypto.randomUUID ? crypto.randomUUID() : `wa-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: new Date().toISOString(),
        phone: entry.normalizedPhone || entry.phone || "",
        message: normalizeMultilineText(entry.message).slice(0, 500),
        status: entry.status || "unknown",
        mode: entry.mode || serviceState.mode,
        reason: entry.reason || "",
        attempt: entry.attempt || 1,
        transport: entry.transport || "",
        ok: Boolean(entry.ok)
    };

    serviceState.logs.unshift(logEntry);
    serviceState.logs = serviceState.logs.slice(0, LOG_LIMIT);
    console.log(`[WHATSAPP ${logEntry.status.toUpperCase()}] ${logEntry.time} | ${logEntry.phone} | ${logEntry.mode}`);
    return logEntry;
}

function getWhatsAppLogs(limit = 50) {
    return serviceState.logs.slice(0, Math.max(resolvePositiveNumber(limit, 50), 1));
}

function getWhatsAppStatus() {
    return {
        mode: serviceState.mode,
        connection: serviceState.connection,
        queueDepth: serviceState.queueDepth,
        lastError: serviceState.lastError,
        canSend: serviceState.mode === "live" && serviceState.connection === "open",
        requiresQr: serviceState.mode === "live" && serviceState.connection !== "open",
        qr: serviceState.lastQr,
        setupMessage: buildWhatsAppSetupMessage(),
        recentLogs: getWhatsAppLogs(8),
        recentCampaigns: serviceState.lastCampaigns.slice(0, 5)
    };
}

function getStatus() {
    return getWhatsAppStatus();
}

function buildDuplicateKey(phone, message) {
    return crypto
        .createHash("sha1")
        .update(`${phone || ""}|${message || ""}`)
        .digest("hex");
}

function pruneDuplicateCache(now = Date.now()) {
    for (const [key, value] of serviceState.duplicateSends.entries()) {
        if (!value?.time || now - value.time > DUPLICATE_TTL_MS) {
            serviceState.duplicateSends.delete(key);
        }
    }
}

function normalizeText(value) {
    return String(value || "").trim();
}

function normalizeMultilineText(value) {
    return String(value || "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function resolvePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value) {
    return new Intl.NumberFormat("en-IN", {
        maximumFractionDigits: 0
    }).format(safeNumber(value));
}

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(resolvePositiveNumber(ms, 0), 0));
    });
}

module.exports = {
    buildCustomMessage,
    buildEmiReminderMessage,
    buildOfferMessage,
    createCampaignDraft,
    ensureWhatsAppConnection,
    getStatus,
    getWhatsAppLogs,
    getWhatsAppStatus,
    initWhatsApp,
    isWhatsAppReady,
    logWhatsApp,
    normalizeWhatsAppPhone,
    renderMessageTemplate,
    sendBulkWhatsApp,
    sendWhatsAppMessage,
    validateWhatsAppPhone
};
