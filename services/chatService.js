const { getDashboardPayload } = require("./sheetsService");
const {
    createCampaignDraft,
    renderMessageTemplate,
    sendBulkWhatsApp,
    sendWhatsAppMessage
} = require("./whatsappService");
const {
    isClearedPaymentStatus,
    isPendingPaymentStatus
} = require("../utils/paymentStatus");

const DATA_NOT_AVAILABLE = "Data not available";
const UNCLEAR_QUERY = "Samajh nahi aaya, please thoda clear poochiye";
const MEMORY_TTL_MS = 30 * 60 * 1000;
const CHAT_DATA_MAX_AGE_MS = 20 * 1000;
const LIST_PAGE_SIZE = 5;
const INDIA_TIME_ZONE = "Asia/Kolkata";
const CONVERSATION_LOG_LIMIT = 300;
const sessionMemory = new Map();
const conversationHistory = [];

// Cached Intl formatters for performance (avoid creating per-call)
const CACHED_DATE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
});
const CACHED_DATE_DISPLAY_FORMATTER = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeZone: INDIA_TIME_ZONE
});
const CACHED_CURRENCY_FORMATTER = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
});
const CACHED_NUMBER_FORMATTER = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0
});

const PHRASE_NORMALIZATION_MAP = [
    ["sbse", "sabse"],
    ["sabse jyada", "sabse zyada"],
    ["jada", "zyada"],
    ["kin kin", "kis_kis"],
    ["kin kin ka", "kis_kis"],
    ["kis kiska", "kis_kis"],
    ["kis kis ka", "kis_kis"],
    ["kis-kis ka", "kis_kis"],
    ["kisne kisne", "kis_kis"],
    ["bacha hai", "pending"],
    ["due hai", "pending"],
    ["reh gaya", "pending"],
    ["reh gya", "pending"],
    ["amount pending", "pending"],
    ["is mahine", "this month"],
    ["abhi tk", "till now"],
    ["abhi tak", "till now"],
    ["kon", "kaun"],
    ["konsa", "kaunsa"],
    ["kaunsi", "kaunsa"],
    ["kis kis", "kis_kis"],
    ["kis-kis", "kis_kis"],
    ["jisne jisne", "kis_kis"],
    ["jisne", "who"],
    ["jinhone", "who"],
    ["batch upgrade kiya", "upgrade"],
    ["upgrade kiya hai", "upgrade"],
    ["upgrade kiya", "upgrade"],
    ["who else", "aur kaun"],
    ["us batch", "us_batch"],
    ["usme", "us_batch"],
    ["usmein", "us_batch"],
    ["us me", "us_batch"],
    ["what about that", "uska"],
    ["today's", "today"],
    ["weekly sales", "week sales"],
    ["monthly sales", "month sales"],
    ["kisne upgrade kiya", "upgrade list"],
    ["kisi ka pending hai kya", "pending exists"],
    ["kisi ka emi pending hai kya", "pending exists"],
    ["kiska emi bacha hai", "kiska pending hai"],
    ["kiska due hai", "kiska pending hai"],
    ["emi nahi di hai", "pending"],
    ["emi nhi di hai", "pending"],
    ["emi nahi dee hai", "pending"],
    ["emi nhi dee hai", "pending"],
    ["emi nahi diya hai", "pending"],
    ["emi nhi diya hai", "pending"],
    ["emi di hai", "paid"],
    ["emi dee hai", "paid"],
    ["emi diya hai", "paid"],
    ["payment di hai", "paid"],
    ["payment kiya hai", "paid"],
    ["emi clear hua", "paid"],
    ["emi clear hua hai", "paid"],
    ["emi clear ho gaya", "paid"],
    ["emi clear ho gya", "paid"],
    ["emi clear", "paid"],
    ["clear hua", "paid"],
    ["clear ho gaya", "paid"],
    ["clear ho gya", "paid"],
    ["batch khareeda", "batch paid"],
    ["batch kharida", "batch paid"],
    ["batch khareede", "batch paid"],
    ["batch purchase kiya", "batch paid"],
    ["students ke naam", "student list"],
    ["student ke naam", "student list"],
    ["students ka naam", "student list"],
    ["kon kon se students", "student list"],
    ["kaun kaun se students", "student list"],
    ["emi pr liya hai", "pending"],
    ["emi par liya hai", "pending"],
    ["next emi date", "emi schedule"],
    ["emi date", "emi schedule"],
    ["date ane wali hai", "emi schedule"],
    // Reasoning phrases
    ["kyu nahi", "kyu"],
    ["kyun nahi", "kyu"],
    ["kyon nahi", "kyu"],
    ["kyu nhi", "kyu"],
    ["kaise hoga", "kaise"],
    ["kaise karein", "kaise"],
    ["kaise kare", "kaise"],
    ["kab tak", "kab"],
    ["kab dena hai", "emi schedule"],
    ["kab deni hai", "emi schedule"],
    ["kya kare", "suggest_action"],
    ["kya karu", "suggest_action"],
    ["kya karun", "suggest_action"],
    ["kya karna chahiye", "suggest_action"],
    ["suggest karo", "suggest_action"],
    // Typo corrections
    ["pendng", "pending"],
    ["pendig", "pending"],
    ["emii", "emi"],
    ["studnet", "student"],
    ["studnets", "students"],
    ["paymnt", "payment"],
    ["pyment", "payment"],
    ["revnue", "revenue"],
    ["reveue", "revenue"],
    // Additional Hinglish
    ["kitna bacha", "pending"],
    ["kitna baki", "pending"],
    ["kitna dena hai", "pending"],
    ["kitna pending", "pending"],
    ["kitna diya", "paid"],
    ["kitna liya", "paid"],
    ["reminder bhejo", "whatsapp"],
    ["message bhejo", "whatsapp"],
    ["whatsapp bhejo", "whatsapp"],
    ["msg bhejo", "whatsapp"],
    ["follow up karo", "follow up"],
    ["sabhi ko", "sabko"],
    ["sab ko", "sabko"],
    ["new batch launch", "launch"]
];

const SEMANTIC_MAP = {
    pending: ["bacha", "due", "remaining", "rest"],
    highest: ["sabse zyada", "highest", "most", "max"],
    lowest: ["sabse kam", "lowest", "least"]
};

const WORD_NORMALIZATION_MAP = {
    aaj: "today",
    aj: "today",
    kal: "yesterday",
    kb: "kab",
    bachcha: "student",
    bachche: "students",
    bachchon: "students",
    bache: "students",
    baccha: "student",
    bacche: "students",
    bacchon: "students",
    hafta: "week",
    hafte: "week",
    weekly: "week",
    mahina: "month",
    mahine: "month",
    monthly: "month",
    bikri: "sales",
    bika: "sales",
    sale: "sales",
    collections: "revenue",
    collection: "revenue",
    baki: "pending",
    baaki: "pending",
    latest: "recent",
    newest: "recent",
    joined: "recent",
    clear: "paid",
    cleared: "paid",
    khareeda: "paid",
    kharida: "paid",
    khareede: "paid",
    kharide: "paid",
    bought: "paid",
    purchase: "paid",
    purchased: "paid",
    versus: "vs",
    // Reasoning words
    kyun: "kyu",
    kyon: "kyu",
    reason: "kyu",
    wajah: "kyu",
    tarika: "kaise",
    // Typo resilience
    batche: "batch",
    agnt: "agent",
    paymnt: "payment",
    studnt: "student",
    emis: "emi",
    pendign: "pending",
    totl: "total"
};

const STOP_WORDS = new Set([
    "aaj",
    "aj",
    "today",
    "yesterday",
    "till",
    "now",
    "kab",
    "date",
    "schedule",
    "next",
    "week",
    "month",
    "sales",
    "sale",
    "revenue",
    "student",
    "students",
    "batch",
    "agent",
    "pending",
    "due",
    "paid",
    "payment",
    "amount",
    "emi",
    "kitna",
    "kitni",
    "kitne",
    "ka",
    "ki",
    "ke",
    "me",
    "mein",
    "hai",
    "hain",
    "tha",
    "the",
    "hua",
    "hui",
    "huye",
    "babu",
    "ji",
    "sir",
    "bhai",
    "kitna?",
    "detail",
    "details",
    "data",
    "full",
    "pura",
    "total",
    "top",
    "sabse",
    "zyada",
    "highest",
    "lowest",
    "least",
    "most",
    "best",
    "list",
    "recent",
    "new",
    "count",
    "status",
    "performance",
    "compare",
    "vs",
    "risk",
    "prediction",
    "defaulter",
    "kaun",
    "kiska",
    "kiski",
    "kisne",
    "kisi",
    "kaunsa",
    "which",
    "kis",
    "kis_kis",
    "ne",
    "se",
    "aur",
    "show",
    "naam",
    "name",
    "number",
    "mobile",
    "contact",
    "batao",
    "batayo",
    "bataiye",
    "please",
    "kitnaaa",
    "uska",
    "uski",
    "uske",
    "us_batch",
    "sold",
    "bika",
    "clear",
    "cleared",
    "khareeda",
    "kharida",
    "khareede",
    "kharide",
    "list?",
    "students?",
    "student?",
    "kyu",
    "why",
    "kaise",
    "how",
    "kab",
    "when",
    "suggest_action",
    "action",
    "suggest",
    "follow",
    "send",
    "bhejo",
    "whatsapp",
    "message",
    "sabko",
    "all",
    "offer",
    "launch",
    "announcement",
    "broadcast"
]);

const STUDENT_FOLLOW_UP_INTENTS = new Set([
    "student_lookup",
    "student_payment",
    "student_pending",
    "emi_highest",
    "emi_lowest",
    "emi_risk",
    "emi_schedule"
]);

const BATCH_FOLLOW_UP_INTENTS = new Set([
    "batch_query",
    "batch_top",
    "batch_comparison",
    "batch_pending",
    "batch_paid",
    "batch_ranking"
]);

const AGENT_FOLLOW_UP_INTENTS = new Set([
    "agent_query",
    "agent_top",
    "agent_performance"
]);

const LIST_INTENTS = new Set([
    "student_list",
    "recent_students",
    "top_students",
    "top_pending_students",
    "pending_list",
    "paid_list",
    "emi_risk",
    "emi_upcoming",
    "emi_defaulters",
    "upgrade_list",
    "batch_ranking",
    "batch_revenue",
    "agent_performance"
]);

const INTENT_SPLIT_PATTERN = /\s+(?:aur|and|also)\s+|,|\s+\+\s+/i;

async function getChatReply(message, sessionId = "default-session") {
    const rawMessage = normalizeMessage(message);
    if (!rawMessage) {
        return buildResolution("Please enter a message.", emptyMemory("empty"));
    }

    pruneSessionMemory();

    try {
        const dashboard = await getDashboardPayload({ maxAgeMs: CHAT_DATA_MAX_AGE_MS });
        const context = {
            data: Array.isArray(dashboard?.data) ? dashboard.data : [],
            metrics: dashboard?.metrics || {},
            batchStats: dashboard?.batchStats || {},
            agentStats: dashboard?.agentStats || {}
        };

        return handleChat(rawMessage, context, sessionId);
    } catch (error) {
        console.error("Failed to prepare chat reply:", error);
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("error"));
    }
}

async function handleChat(message, context, sessionId = "default-session") {
    const rawSegments = splitIntents(message);
    if (!rawSegments.length) {
        return "Please enter a message.";
    }

    const data = Array.isArray(context?.data) ? context.data : [];
    const metrics = context?.metrics || {};
    const batchStats = context?.batchStats || {};
    const agentStats = context?.agentStats || {};
    const indexes = buildDataIndexes(data, batchStats, agentStats);
    let workingSession = getSessionState(sessionId);
    const results = [];

    for (const segment of rawSegments) {
        const rawQuery = normalizeMessage(segment);
        const query = normalizeQuery(rawQuery);
        if (!query) {
            continue;
        }

        const resolution = await processIntentQuery({
            rawQuery,
            query,
            data,
            metrics,
            indexes,
            session: workingSession
        });

        workingSession = resolution.memoryState;
        results.push(resolution);
    }

    if (!results.length) {
        return buildResolution("Please enter a message.", emptyMemory("empty"));
    }

    const combined = combineReplies(results);
    updateSessionMemory(sessionId, combined.memoryState);
    return combined;
}

async function processIntentQuery({ rawQuery, query, data, metrics, indexes, session }) {
    const signals = analyzeQuery(query);
    let entities = extractEntities(rawQuery, query, indexes, session, signals);
    entities = applyMemory(entities, session, query, signals);

    const intentResult = detectIntentWithConfidence(query, entities, signals, session);
    const intent = intentResult.intent;
    const confidence = intentResult.confidence;

    // Log query for debugging and accuracy improvement
    logQuery(rawQuery || query, intent, confidence);

    // Low-confidence fallback with smart suggestions
    if (intent === "unknown" || confidence < 0.4) {
        const fallback = buildSmartFallback(query, entities, signals, session);
        return buildResolution(fallback.reply, {
            ...buildMemoryState({ session, intent: "unknown", entities }),
            lastFailedQuery: query
        }, {
            intent: "unknown",
            confidence,
            suggestions: fallback.suggestions
        });
    }

    const validationReply = validateData(intent, entities, signals);

    if (validationReply) {
        return buildResolution(validationReply, buildMemoryState({ session, intent, entities }), {
            intent,
            confidence,
            pending: entities.student?.pending || 0,
            phone: entities.student?.phone || entities.phone || "",
            batch: entities.batch || "",
            agent: entities.agent || ""
        });
    }

    return resolveIntent({
        intent,
        rawQuery,
        query,
        signals,
        entities,
        data,
        metrics,
        indexes,
        session,
        confidence
    });
}

function analyzeQuery(query) {
    return {
        wantsRevenue: hasAny(query, ["revenue", "sales", "sold"]),
        wantsPending: hasAny(query, ["pending", "emi", "due"]),
        wantsPaid: hasAny(query, ["paid", "payment"]),
        wantsStudentList: hasAny(query, ["student list", "students list"]),
        wantsStudents: hasAny(query, ["student", "students"]),
        wantsBatch: query.includes("batch"),
        wantsAgent: query.includes("agent"),
        wantsUpgrade: query.includes("upgrade"),
        wantsCount: hasAny(query, ["kitne", "count", "how many"]),
        asksAmount: hasAny(query, ["kitna", "kitni", "amount", "total"]),
        wantsHighest: hasAny(query, ["sabse zyada", "highest", "most", "top", "best"]),
        wantsLowest: hasAny(query, ["sabse kam", "lowest", "least"]),
        wantsComparison: hasAny(query, ["vs", "compare", "comparison"]),
        wantsList: hasAny(query, ["list", "kaun", "kis_kis", "which", "show", "who", "kisne", "name", "naam"]),
        wantsRecent: hasAny(query, ["recent", "latest", "new"]),
        wantsRisk: hasAny(query, ["risk", "prediction", "defaulter", "default"]) || hasAny(query, ["nahi dega", "nahi de raha", "nahi de rahe"]),
        wantsUpcoming: hasAny(query, ["next emi", "upcoming emi", "next due", "upcoming", "follow up"]),
        wantsDefaulters: hasAny(query, ["defaulter", "nahi de raha", "nahi de rahe", "default"]),
        wantsWhatsapp: hasAny(query, ["whatsapp", "message", "reminder"]),
        wantsSend: hasAny(query, ["bhejo", "send", "broadcast", "share", "forward"]),
        wantsAll: hasAny(query, ["sabko", "all", "sabhi"]),
        wantsOffer: hasAny(query, ["offer", "launch", "announcement", "announce"]),
        wantsCustomMessage: query.includes(":") || hasAny(query, ["custom message", "message bhejo", "broadcast"]),
        wantsSchedule: hasAny(query, ["emi schedule"]) || (query.includes("emi") && hasAny(query, ["date", "kab", "jani", "jaani", "due date", "is month", "this month"])),
        asksPhone: hasAny(query, ["phone", "mobile", "number", "contact"]),
        asksDetail: hasAny(query, ["detail", "details", "data", "full", "pura", "status"]),
        asksMore: hasAny(query, ["aur kaun", "more", "next"]),
        asksThat: hasAny(query, ["uska", "uski", "uske", "that", "us_batch"]),
        asksWhose: hasAny(query, ["kiska", "kiski", "whose"]),
        asksWhy: hasAny(query, ["kyu", "kyon", "why", "kaise nahi", "reason", "wajah"]),
        asksHow: hasAny(query, ["kaise", "how", "tarika", "method"]),
        asksWhen: hasAny(query, ["kab", "when", "next date", "date kya hai", "timing"]),
        asksAction: hasAny(query, ["suggest_action", "action", "suggest", "kya kare", "kya karu"]),
        asksNameOnly: hasAny(query, ["student ka naam", "students ka naam", "student name", "name", "naam"]),
        asksExistence: hasAny(query, ["pending exists", "hai kya", "any pending", "kisi ka"]),
        wantsUpgradeList: hasAny(query, ["upgrade list", "kisne upgrade", "upgraded students", "kis_kis", "who upgrade", "upgrade students"]),
        wantsFollowUp: hasAny(query, ["follow up", "follow-up", "followup"]),
        isAffirmative: hasAny(query, ["haan", "han", "yes", "confirm", "approved", "approve", "kar do", "bhej do", "send kar do", "ok"]),
        isNegative: hasAny(query, ["nahi", "mat", "cancel", "stop", "rehne do", "mat bhejo"]),
        time: detectTimeContext(query),
        comparison: detectComparativeWords(query),
        topCount: detectTopCount(query),
        followUpContext: detectFollowUpContext(query)
    };
}

function extractEntities(rawQuery, query, indexes, session, signals) {
    const phone = detectPhoneStrict(query);
    const studentByPhone = phone ? getStudentByPhone(phone, indexes) : null;
    const batchMatches = expandBatchComparisonMatches(
        query,
        findNamedMatches(query, indexes.batchEntries),
        indexes.batchEntries,
        signals
    );
    const agentMatches = findNamedMatches(query, indexes.agentEntries);
    const nameHint = extractNameHint(query, batchMatches, agentMatches);
    const studentLookup = studentByPhone
        ? { status: "found", student: studentByPhone, matches: [studentByPhone] }
        : getStudentByName(nameHint, indexes);

    return {
        phone,
        nameHint,
        studentLookup,
        student: studentLookup.student || null,
        batches: batchMatches,
        batch: batchMatches[0] || "",
        agents: agentMatches,
        agent: agentMatches[0] || "",
        time: signals.time,
        comparison: signals.comparison,
        topCount: signals.topCount,
        phoneStrict: phone,
        customMessage: extractCustomMessage(rawQuery),
        comparativeWord: signals.comparison,
        followUpContext: signals.followUpContext,
        followUp: signals.asksMore || signals.asksThat || signals.asksNameOnly,
        listContinue: signals.asksMore,
        fromMemory: false
    };
}

function detectIntent(query, entities, signals, session) {
    const result = detectIntentWithConfidence(query, entities, signals, session);
    return result.intent;
}

function detectIntentWithConfidence(query, entities, signals, session) {
    const hasBatch = entities.batches.length > 0;
    const hasAgent = entities.agents.length > 0;
    const explicitTopRequest = hasAny(query, ["top", "best"]);
    const hasStudent = Boolean(
        entities.student
        || entities.phone
        || (
            entities.nameHint
            && !hasBatch
            && !hasAgent
            && (signals.wantsStudents || signals.asksDetail || signals.wantsPending || signals.wantsPaid)
        )
    );
    const amountOnly = signals.asksAmount && !signals.wantsPending && !signals.wantsPaid && !signals.wantsRevenue;

    if (session?.pendingConfirmation && signals.isAffirmative) {
        return { intent: "confirm_action", confidence: 0.99 };
    }

    if (session?.pendingConfirmation && signals.isNegative) {
        return { intent: "cancel_action", confidence: 0.99 };
    }

    // --- Reasoning intents (highest priority — context-dependent follow-ups) ---
    if (signals.asksWhy) {
        return { intent: "explain_previous", confidence: session?.lastIntent ? 0.95 : 0.4 };
    }

    if (signals.asksHow && !signals.wantsPending && !signals.wantsPaid && !signals.wantsRevenue) {
        return { intent: "explain_how", confidence: session?.lastIntent ? 0.9 : 0.4 };
    }

    if (signals.asksAction) {
        return { intent: "suggest_action", confidence: session?.lastIntent ? 0.9 : 0.5 };
    }

    if (signals.asksWhen && !signals.wantsSchedule && session?.lastStudent) {
        return { intent: "explain_when", confidence: 0.85 };
    }

    // --- Follow-up intents ---
    if (signals.asksMore && LIST_INTENTS.has(session?.lastIntent)) {
        return { intent: "list_continue", confidence: 0.95 };
    }

    if (signals.wantsFollowUp && session?.lastStudent) {
        return { intent: "suggest_action", confidence: 0.85 };
    }

    if (signals.asksNameOnly && session?.lastBatch && session?.lastIntent === "batch_pending") {
        return { intent: "pending_list", confidence: 0.9 };
    }

    if (signals.asksNameOnly && session?.lastBatch && session?.lastIntent === "batch_paid") {
        return { intent: "paid_list", confidence: 0.9 };
    }

    // --- EMI intents ---
    if (signals.wantsSchedule) {
        return { intent: "emi_schedule", confidence: hasStudent || session?.lastStudent ? 0.95 : 0.7 };
    }

    if (signals.asksExistence && signals.wantsPending && !signals.asksWhose) {
        return { intent: "emi_exists", confidence: 0.9 };
    }

    if (signals.wantsPending && signals.wantsList && query.includes("kis_kis")) {
        return { intent: "pending_list", confidence: 0.95 };
    }

    if (signals.wantsHighest && signals.wantsPending && signals.topCount === 0) {
        if (signals.asksDetail) {
            return { intent: "emi_highest_detail", confidence: 0.95 };
        }
        return { intent: "emi_highest", confidence: 0.9 };
    }

    if (signals.wantsPending && signals.asksWhose) {
        if (signals.asksDetail) {
            return { intent: "emi_highest_detail", confidence: 0.9 };
        }
        return { intent: "emi_highest", confidence: 0.85 };
    }

    if ((signals.topCount > 0 || explicitTopRequest) && signals.wantsPending && signals.wantsStudents) {
        return { intent: "top_pending_students", confidence: 0.95 };
    }

    if ((signals.topCount > 0 || explicitTopRequest) && signals.wantsStudents) {
        return { intent: "top_students", confidence: 0.9 };
    }

    if (signals.wantsUpcoming) {
        return { intent: "emi_upcoming", confidence: 0.9 };
    }

    if (signals.wantsDefaulters) {
        return { intent: "emi_defaulters", confidence: 0.9 };
    }

    if (signals.wantsUpgrade && signals.wantsCount) {
        return { intent: "upgrade_count", confidence: 0.9 };
    }

    if (signals.wantsUpgrade && (signals.wantsUpgradeList || signals.wantsList || signals.asksPhone || hasAny(query, ["who"]))) {
        return { intent: "upgrade_list", confidence: 0.9 };
    }

    if (signals.wantsWhatsapp || signals.wantsSend || signals.wantsOffer || signals.wantsCustomMessage) {
        if (hasStudent) {
            return { intent: "send_whatsapp_single", confidence: 0.96 };
        }

        if (signals.wantsOffer) {
            return { intent: "send_offer", confidence: 0.95 };
        }

        if (entities.customMessage) {
            return { intent: "broadcast_message", confidence: 0.95 };
        }

        if (signals.wantsAll || signals.wantsPending || signals.wantsPaid || hasBatch || hasAgent || signals.wantsDefaulters) {
            return { intent: "send_whatsapp_bulk", confidence: 0.95 };
        }
    }

    // --- Student intents ---
    if (hasStudent) {
        if (signals.wantsRisk) {
            return { intent: "emi_risk", confidence: 0.9 };
        }
        if (signals.wantsPending) {
            return { intent: "student_pending", confidence: 0.95 };
        }
        if (signals.wantsPaid) {
            return { intent: "student_payment", confidence: 0.95 };
        }
        if (amountOnly && session?.lastIntent === "student_pending") {
            return { intent: "student_pending", confidence: 0.8 };
        }
        if (amountOnly && session?.lastIntent === "student_payment") {
            return { intent: "student_payment", confidence: 0.8 };
        }
        return { intent: "student_lookup", confidence: entities.student ? 0.9 : 0.6 };
    }

    // --- Comparison intents ---
    if (signals.wantsComparison) {
        if (entities.agents.length >= 2 || (hasAgent && signals.wantsAgent)) {
            return { intent: "agent_comparison", confidence: 0.9 };
        }
        return { intent: "batch_comparison", confidence: hasBatch ? 0.9 : 0.6 };
    }

    // --- Batch intents ---
    if (hasBatch) {
        if (signals.wantsPending) {
            if (signals.wantsList || signals.asksWhose || signals.asksNameOnly) {
                return { intent: "pending_list", confidence: 0.9 };
            }
            return { intent: "batch_pending", confidence: 0.9 };
        }
        if (signals.wantsPaid) {
            if (signals.wantsList || signals.asksWhose || signals.asksNameOnly) {
                return { intent: "paid_list", confidence: 0.9 };
            }
            return { intent: "batch_paid", confidence: 0.9 };
        }
        if (signals.wantsHighest) {
            return { intent: "batch_top", confidence: 0.85 };
        }
        return { intent: "batch_query", confidence: 0.85 };
    }

    // --- Agent intents ---
    if (hasAgent) {
        if (signals.wantsHighest) {
            return { intent: "agent_top", confidence: 0.85 };
        }
        return { intent: "agent_query", confidence: 0.85 };
    }

    if (signals.wantsRisk) {
        return { intent: "emi_risk", confidence: 0.8 };
    }

    if (signals.wantsHighest && signals.wantsBatch) {
        return { intent: "batch_top", confidence: 0.85 };
    }

    if (signals.wantsHighest && signals.wantsAgent) {
        return { intent: "agent_top", confidence: 0.85 };
    }

    if (signals.wantsCount && signals.wantsStudents && (signals.wantsPaid || signals.wantsBatch || Boolean(signals.time))) {
        return { intent: "student_count", confidence: 0.85 };
    }

    if (signals.wantsPending) {
        if (signals.topCount > 0) {
            return { intent: "emi_top_list", confidence: 0.9 };
        }
        if (signals.wantsLowest) {
            return { intent: "emi_lowest", confidence: 0.85 };
        }
        if (signals.wantsList || hasAny(query, ["kis kis", "nahi de raha", "nahi de rahe"])) {
            return { intent: "pending_list", confidence: 0.85 };
        }
        return { intent: "emi_total", confidence: 0.8 };
    }

    if (signals.wantsPaid) {
        if (signals.wantsList || signals.wantsStudents) {
            return { intent: "paid_list", confidence: 0.8 };
        }
    }

    if (signals.wantsStudentList) {
        return { intent: "student_list", confidence: 0.85 };
    }

    if (signals.wantsStudents && (signals.asksNameOnly || signals.wantsList)) {
        return { intent: "student_list", confidence: 0.85 };
    }

    if (signals.wantsRecent && signals.wantsStudents) {
        return { intent: "recent_students", confidence: 0.85 };
    }

    if (signals.wantsCount && signals.wantsStudents) {
        return { intent: "student_count", confidence: 0.85 };
    }

    if (signals.wantsRevenue) {
        if (signals.wantsHighest && signals.wantsBatch) {
            return { intent: "batch_top", confidence: 0.85 };
        }
        if (signals.wantsHighest && signals.wantsAgent) {
            return { intent: "agent_top", confidence: 0.85 };
        }
        if (signals.wantsBatch && (signals.wantsList || query.includes("wise"))) {
            return { intent: "batch_revenue", confidence: 0.85 };
        }
        if (signals.time === "today") {
            return { intent: "sales_today", confidence: 0.9 };
        }
        if (signals.time === "this_week") {
            return { intent: "sales_week", confidence: 0.9 };
        }
        if (signals.time === "this_month") {
            return { intent: "sales_month", confidence: 0.9 };
        }
        if (signals.wantsBatch) {
            return { intent: "batch_ranking", confidence: 0.75 };
        }
        if (signals.wantsAgent) {
            return { intent: "agent_performance", confidence: 0.75 };
        }
        return { intent: "total_revenue", confidence: 0.8 };
    }

    if (signals.wantsBatch && signals.wantsHighest) {
        return { intent: "batch_top", confidence: 0.8 };
    }

    if (signals.wantsBatch) {
        return { intent: "batch_ranking", confidence: 0.7 };
    }

    if (signals.wantsAgent && signals.wantsHighest) {
        return { intent: "agent_top", confidence: 0.8 };
    }

    if (signals.wantsAgent) {
        return { intent: "agent_performance", confidence: 0.7 };
    }

    // --- Memory-based follow-ups ---
    if (amountOnly && session?.lastStudent && STUDENT_FOLLOW_UP_INTENTS.has(session.lastIntent)) {
        return { intent: session.lastIntent === "student_payment" ? "student_payment" : "student_pending", confidence: 0.75 };
    }

    if (amountOnly && session?.lastBatch && BATCH_FOLLOW_UP_INTENTS.has(session.lastIntent)) {
        return { intent: "batch_query", confidence: 0.7 };
    }

    if (amountOnly && session?.lastAgent && AGENT_FOLLOW_UP_INTENTS.has(session.lastIntent)) {
        return { intent: "agent_query", confidence: 0.7 };
    }

    if (signals.wantsHighest && hasAny(query, ["batch", "bika", "sold"])) {
        return { intent: "batch_top", confidence: 0.75 };
    }

    if (signals.wantsHighest && hasAny(query, ["agent", "sale karta"])) {
        return { intent: "agent_top", confidence: 0.75 };
    }

    if (signals.time === "today" && signals.asksAmount) {
        return { intent: "sales_today", confidence: 0.7 };
    }

    return { intent: "unknown", confidence: 0.0 };
}

function applyMemory(entities, session, query, signals) {
    const nextEntities = {
        ...entities,
        batches: [...entities.batches],
        agents: [...entities.agents]
    };

    if (!session || !entities.followUp) {
        return nextEntities;
    }

    nextEntities.fromMemory = true;

    if (!nextEntities.student && signals.asksThat && session.lastStudent) {
        nextEntities.student = session.lastStudent;
        nextEntities.phone = session.lastStudent.phone || nextEntities.phone;
        nextEntities.nameHint = session.lastStudent.name || nextEntities.nameHint;
    }

    if (!nextEntities.student && signals.asksNameOnly && session.lastStudent) {
        nextEntities.student = session.lastStudent;
        nextEntities.phone = session.lastStudent.phone || nextEntities.phone;
        nextEntities.nameHint = session.lastStudent.name || nextEntities.nameHint;
    }

    if (!nextEntities.batch && (query.includes("us_batch") || (signals.asksThat && session.lastBatch))) {
        nextEntities.batch = session.lastBatch || "";
        if (nextEntities.batch && nextEntities.batches.length === 0) {
            nextEntities.batches = [nextEntities.batch];
        }
    }

    if (!nextEntities.agent && signals.asksThat && session.lastAgent) {
        nextEntities.agent = session.lastAgent;
        if (nextEntities.agent && nextEntities.agents.length === 0) {
            nextEntities.agents = [nextEntities.agent];
        }
    }

    if (!nextEntities.time && session.lastTime) {
        nextEntities.time = session.lastTime;
    }

    return nextEntities;
}

function validateData(intent, entities, signals) {
    if (intent === "unknown") {
        return null; // Handled by processIntentQuery confidence check
    }

    if (entities.studentLookup?.status === "ambiguous") {
        const matchNames = (entities.studentLookup.matches || []).map((s) => s.name).slice(0, 3).join(", ");
        return `Multiple students mile: ${matchNames}. Please full name ya phone number dijiye`;
    }

    if (
        intent === "student_lookup"
        || intent === "student_payment"
        || intent === "student_pending"
        || intent === "send_whatsapp_single"
    ) {
        if (!entities.student) {
            if (entities.nameHint) {
                return `"${entities.nameHint}" naam ka student nahi mila. Kya correct name ya phone number de sakte hain?`;
            }
            if (entities.phone) {
                return `Is phone number se koi student nahi mila. Please check karein`;
            }
            return "Please student ka naam ya phone number batayein";
        }
    }

    if ((intent === "broadcast_message" || intent === "send_offer") && !entities.customMessage && intent === "broadcast_message") {
        return "Custom broadcast ke liye message likhiye. Example: sabko message bhejo: kal class nahi hogi";
    }

    if (intent === "batch_query" || intent === "batch_pending" || intent === "batch_paid") {
        if (!entities.batch) {
            return "Please batch name clear likhiye";
        }
    }

    if (intent === "batch_comparison" && entities.batches.length < 2) {
        return "Please 2 batch names clear likhiye";
    }

    if ((intent === "agent_query" && !entities.agent) || (intent === "agent_comparison" && entities.agents.length < 2)) {
        if (intent === "agent_comparison") {
            return "Please 2 agent names clear likhiye";
        }
        return "Please agent name clear likhiye";
    }

    if ((intent === "sales_today" || intent === "sales_week" || intent === "sales_month") && !signals.time) {
        return null;
    }

    return null;
}

async function resolveIntent({ intent, rawQuery, query, signals, entities, data, metrics, indexes, session, confidence }) {
    switch (intent) {
        case "confirm_action":
            return resolveConfirmedAction(session);
        case "cancel_action":
            return resolveCancelledAction(session);
        case "explain_previous":
            return resolveWhy(session);
        case "explain_how":
            return resolveHow(session);
        case "explain_when":
            return resolveWhen(session, entities, indexes);
        case "suggest_action":
            return resolveAction(session, entities, indexes);
        case "send_whatsapp_single":
            return resolveSingleWhatsAppDraft(entities, session, signals);
        case "send_whatsapp_bulk":
        case "broadcast_message":
        case "send_offer":
            return resolveBulkWhatsAppDraft({ intent, rawQuery, entities, indexes, signals, session });
        case "student_lookup":
            return resolveStudentLookup(entities.student, intent);
        case "student_payment":
            return resolveStudentPayment(entities.student);
        case "student_pending":
            return resolveStudentPending(entities.student, signals);
        case "student_count":
            return resolveStudentCount(entities, metrics, indexes, signals, data);
        case "student_list":
            return buildStudentListResolution(indexes.students, "student_list", session);
        case "recent_students":
            return buildRecentStudentsResolution(indexes.students, session);
        case "top_students":
            return buildTopStudentsResolution(indexes.students, session, entities.topCount || 3);
        case "top_pending_students":
            return buildTopPendingStudentsResolution(getPendingList(indexes), session, entities.topCount || 3);
        case "emi_highest_detail":
            return resolveHighestPendingDetail(indexes);
        case "emi_schedule":
            return resolveEMISchedule(entities, session);
        case "emi_exists":
            return resolvePendingExists(indexes);
        case "emi_total":
            return resolvePendingTotals(indexes);
        case "pending_list":
            return buildPendingListResolution(
                getPendingList(indexes, {
                    batch: entities.batch || (session?.lastIntent === "batch_pending" ? session.lastBatch : ""),
                    agent: entities.agent || ""
                }),
                "pending_list",
                session
            );
        case "paid_list":
            return buildPaidListResolution(
                getPaidList(indexes, {
                    batch: entities.batch || (session?.lastIntent === "batch_paid" ? session.lastBatch : ""),
                    agent: entities.agent || ""
                }),
                session
            );
        case "emi_highest":
            return resolvePendingExtreme(getHighestPending(indexes), "emi_highest", "highest");
        case "emi_lowest":
            return resolvePendingExtreme(getLowestPending(indexes), "emi_lowest", "lowest");
        case "emi_top_list":
            return buildTopPendingStudentsResolution(getTopPendingStudents(indexes, entities.topCount || 3), session, entities.topCount || 3);
        case "emi_upcoming":
            return resolveUpcomingEMI(indexes, session);
        case "emi_defaulters":
            return resolveDefaulters(indexes, session);
        case "emi_risk":
            return resolveRiskQuery(entities, indexes, session);
        case "sales_today":
        case "sales_week":
        case "sales_month":
            return resolveSalesByTime(intent, metrics, data);
        case "total_revenue":
            return buildResolution(`Total revenue ${formatCurrency(getMetricValue(metrics, "totalRevenue", sumAmount(data)))} hai`, {
                lastIntent: "total_revenue",
                lastTime: "till_now",
                lastResult: { amount: getMetricValue(metrics, "totalRevenue", sumAmount(data)) }
            });
        case "batch_query":
            return resolveBatchQuery(entities.batch, indexes);
        case "batch_top":
            return resolveTopBatch(indexes);
        case "batch_revenue":
            return buildBatchRevenueResolution(indexes, session);
        case "batch_pending":
            return resolveBatchPending(entities.batch, indexes);
        case "batch_paid":
            return resolveBatchPaid(entities.batch, indexes);
        case "batch_comparison":
            return resolveBatchComparison(entities.batches, indexes);
        case "batch_ranking":
            return buildBatchRankingResolution(indexes, session);
        case "agent_query":
            return resolveAgentQuery(entities.agent, indexes);
        case "agent_top":
            return resolveTopAgent(indexes);
        case "agent_comparison":
            return resolveAgentComparison(entities.agents, indexes);
        case "agent_performance":
            return buildAgentPerformanceResolution(indexes, session);
        case "upgrade_count":
            return resolveUpgradeCount(indexes);
        case "upgrade_list":
            return resolveUpgradeList(indexes, session, signals);
        case "list_continue":
            return continueLastList(session);
        default: {
            const fallback = buildSmartFallback(query, entities, signals, session);
            return buildResolution(fallback.reply, buildMemoryState({ session, intent, entities }), {
                intent,
                confidence: confidence || 0,
                suggestions: fallback.suggestions
            });
        }
    }
}

function getStudentByPhone(phone, indexes) {
    if (!phone) {
        return null;
    }

    return indexes.studentsByPhone.get(normalizePhone(phone)) || null;
}

function getStudentByName(name, indexes) {
    const normalizedName = normalizeQuery(name);
    if (!normalizedName) {
        return { status: "none", student: null, matches: [] };
    }

    const exactMatches = indexes.students.filter((student) => student.normalizedName === normalizedName);
    if (exactMatches.length === 1) {
        return { status: "found", student: exactMatches[0], matches: exactMatches };
    }
    if (exactMatches.length > 1) {
        return { status: "ambiguous", student: null, matches: exactMatches };
    }

    const tokens = normalizedName.split(" ").filter((token) => token.length >= 2);
    const partialMatches = indexes.students.filter((student) => (
        student.normalizedName.includes(normalizedName)
        || tokens.every((token) => student.normalizedName.includes(token))
    ));

    if (partialMatches.length === 1) {
        return { status: "found", student: partialMatches[0], matches: partialMatches };
    }
    if (partialMatches.length > 1) {
        return { status: "ambiguous", student: null, matches: partialMatches };
    }

    return { status: "none", student: null, matches: [] };
}

function extractCustomMessage(rawQuery) {
    const raw = normalizeMessage(rawQuery);
    if (!raw) {
        return "";
    }

    const colonMatch = raw.match(/:\s*([\s\S]+)$/);
    if (colonMatch?.[1]) {
        return colonMatch[1].trim();
    }

    const quotedMatch = raw.match(/["']([\s\S]+?)["']/);
    if (quotedMatch?.[1]) {
        return quotedMatch[1].trim();
    }

    return "";
}

function resolveSingleWhatsAppDraft(entities, session, signals = {}) {
    const student = entities?.student || null;
    if (!student) {
        return buildResolution("Please student ka naam ya phone number batayein", emptyMemory("send_whatsapp_single"));
    }

    const draft = createCampaignDraft({
        intent: "send_whatsapp_single",
        audienceType: "single",
        student,
        students: [student],
        customMessage: entities?.customMessage || "",
        messageType: signals.wantsOffer ? "offer" : (entities?.customMessage ? "custom" : "emi_reminder")
    });

    if (!draft.count) {
        return buildResolution(
            `${student.name} ke liye valid WhatsApp number available nahi hai.`,
            {
                ...emptyMemory("send_whatsapp_single"),
                lastStudent: student,
                lastBatch: student.batch || "",
                lastAgent: student.agent || ""
            },
            {
                ...buildStudentMeta(student, "send_whatsapp_single"),
                whatsappReady: false,
                suggestions: ["Phone number update karein", "Student details dekhein"]
            }
        );
    }

    return buildResolution(
        [
            `${student.name} ke liye WhatsApp preview ready hai.`,
            "",
            draft.preview,
            "",
            `Kya aap ${student.name} ko ye message bhejna chahte hain?`
        ].join("\n"),
        buildWhatsAppDraftMemory(session, draft, student),
        buildWhatsAppDraftMeta(draft, student),
        [buildStudentTableRow(student)]
    );
}

function resolveBulkWhatsAppDraft({ intent, rawQuery, entities, indexes, signals, session }) {
    const audienceType = resolveWhatsAppAudienceType(intent, entities, signals);
    const customMessage = entities.customMessage || extractCustomMessage(rawQuery);
    const draft = createCampaignDraft({
        intent,
        audienceType,
        batch: entities.batch || "",
        agent: entities.agent || "",
        customMessage,
        messageType: intent === "send_offer"
            ? "offer"
            : (intent === "broadcast_message" ? "custom" : "emi_reminder"),
        students: indexes.students
    });

    if (!draft.count) {
        return buildResolution(
            "Is audience ke liye valid WhatsApp recipients nahi mile.",
            {
                ...buildMemoryState({ session, intent, entities }),
                pendingConfirmation: null
            },
            {
                intent,
                whatsappReady: false,
                suggestions: ["Batch filter badliye", "Student phone numbers check karein"]
            }
        );
    }

    const intro = intent === "send_offer"
        ? `${formatNumber(draft.count)} ${draft.audienceLabel} ko offer message bhejne ke liye ready hain.`
        : draft.messageType === "custom"
            ? `${formatNumber(draft.count)} ${draft.audienceLabel} ke liye custom broadcast ready hai.`
            : `${formatNumber(draft.count)} ${draft.audienceLabel} select hue hain.`;
    const warning = draft.messageType === "emi_reminder" ? "EMI follow-up before sending confirm kar lijiye." : "Preview check karke confirm kariye.";
    const skippedLine = draft.skipped.length
        ? `\nSkipped: ${formatNumber(draft.skipped.length)} invalid/duplicate recipients.`
        : "";

    return buildResolution(
        [
            intro,
            warning + skippedLine,
            "",
            "Message preview:",
            draft.preview,
            "",
            `Kya aap ${formatNumber(draft.count)} students ko message bhejna chahte hain?`
        ].join("\n"),
        buildWhatsAppDraftMemory(session, draft, null),
        buildWhatsAppDraftMeta(draft),
        draft.students.slice(0, 5).map((student) => buildStudentTableRow(student))
    );
}

async function resolveConfirmedAction(session) {
    const pendingConfirmation = session?.pendingConfirmation || null;

    if (!pendingConfirmation) {
        return buildResolution(
            "Koi pending WhatsApp action confirm karne ke liye nahi hai.",
            {
                ...emptyMemory("confirm_action"),
                lastBroadcast: session?.lastBroadcast || null
            }
        );
    }

    const students = Array.isArray(pendingConfirmation.students) ? pendingConfirmation.students : [];
    let executionResult;

    if (students.length === 1) {
        const student = students[0];
        const message = renderMessageTemplate(student, pendingConfirmation.template);
        const singleResult = await sendWhatsAppMessage(student.phone, message, {
            type: pendingConfirmation.type
        });

        executionResult = {
            ok: singleResult.ok,
            mode: singleResult.mode,
            summary: {
                total: 1,
                successCount: singleResult.ok ? 1 : 0,
                failedCount: singleResult.ok ? 0 : 1,
                duplicateCount: singleResult.status === "duplicate_skipped" ? 1 : 0,
                invalidCount: singleResult.status === "invalid_phone" ? 1 : 0
            },
            results: [singleResult],
            campaign: null
        };
    } else {
        executionResult = await sendBulkWhatsApp(students, pendingConfirmation.template, {
            type: pendingConfirmation.type,
            campaignId: pendingConfirmation.id
        });
    }

    const lastBroadcast = {
        type: pendingConfirmation.type,
        count: pendingConfirmation.count,
        message: pendingConfirmation.preview,
        time: new Date().toISOString(),
        mode: executionResult.mode,
        summary: executionResult.summary
    };

    return buildResolution(
        buildWhatsAppExecutionReply(pendingConfirmation, executionResult),
        {
            ...session,
            lastIntent: pendingConfirmation.type,
            lastStudent: students.length === 1 ? students[0] : (session?.lastStudent || null),
            lastBatch: pendingConfirmation.filters?.batch || session?.lastBatch || "",
            lastAgent: pendingConfirmation.filters?.agent || session?.lastAgent || "",
            lastResult: {
                count: executionResult.summary.total,
                amount: summarizePendingAmount(students),
                pending: summarizePendingAmount(students)
            },
            pendingConfirmation: null,
            lastBroadcast
        },
        {
            intent: "confirm_action",
            whatsappReady: executionResult.mode === "live",
            lastBroadcast,
            actions: executionResult.summary.failedCount > 0 ? ["Retry failed numbers", "WhatsApp status dekho"] : ["Pending list dekho", "Batch report dekho"],
            suggestions: executionResult.summary.failedCount > 0 ? ["Phone numbers update karein", "Campaign dubara preview karein"] : ["Defaulters list dekho", "New campaign banao"]
        },
        students.slice(0, 5).map((student) => buildStudentTableRow(student))
    );
}

function resolveCancelledAction(session) {
    const pendingConfirmation = session?.pendingConfirmation || null;
    const message = pendingConfirmation
        ? `WhatsApp send cancel kar diya gaya hai. ${formatNumber(pendingConfirmation.count)} recipients ko koi message nahi bheja gaya.`
        : "Koi pending action cancel karne ke liye nahi tha.";

    return buildResolution(
        message,
        {
            ...session,
            lastIntent: "cancel_action",
            pendingConfirmation: null
        },
        {
            intent: "cancel_action",
            actions: [],
            suggestions: ["Preview dobara banao", "Student list dekho"]
        }
    );
}

function resolveWhatsAppAudienceType(intent, entities, signals) {
    if (intent === "send_offer" && !signals.wantsPending && !signals.wantsPaid && !entities.batch && !entities.agent) {
        return "all";
    }

    if (signals.wantsPaid) {
        return "paid";
    }

    if (signals.wantsAll && !signals.wantsPending) {
        return "all";
    }

    return "pending";
}

function buildWhatsAppDraftMemory(session, draft, student) {
    const selectedStudent = student || (draft.students.length === 1 ? draft.students[0] : null);

    return {
        lastIntent: draft.type,
        lastStudent: selectedStudent || session?.lastStudent || null,
        lastBatch: draft.filters?.batch || selectedStudent?.batch || session?.lastBatch || "",
        lastAgent: draft.filters?.agent || selectedStudent?.agent || session?.lastAgent || "",
        lastList: draft.count > LIST_PAGE_SIZE
            ? {
                intent: draft.type,
                items: draft.students,
                offset: LIST_PAGE_SIZE
            }
            : null,
        lastTime: session?.lastTime || "",
        lastResult: {
            count: draft.count,
            amount: summarizePendingAmount(draft.students),
            pending: summarizePendingAmount(draft.students)
        },
        lastReason: session?.lastReason || "",
        lastQueryType: "whatsapp",
        lastFailedQuery: "",
        pendingConfirmation: {
            id: draft.id,
            type: draft.type,
            count: draft.count,
            students: draft.students,
            template: draft.template,
            preview: draft.preview,
            filters: draft.filters,
            messageType: draft.messageType,
            audienceType: draft.audienceType,
            audienceLabel: draft.audienceLabel
        },
        lastBroadcast: session?.lastBroadcast || null
    };
}

function buildWhatsAppDraftMeta(draft, student = null) {
    const sampleStudent = student || draft.students[0] || null;
    return {
        ...buildStudentMeta(sampleStudent, draft.type),
        students: draft.students.map((item) => item.name).filter(Boolean),
        audienceLabel: draft.audienceLabel,
        confirmationRequired: true,
        whatsappReady: true,
        whatsappPreview: draft.preview,
        actions: ["haan", "nahi"],
        suggestions: ["Preview theek hai to haan bolein", "Cancel karna ho to nahi bolein"],
        lastBroadcast: null
    };
}

function buildWhatsAppExecutionReply(pendingConfirmation, executionResult) {
    const summary = executionResult.summary || {};
    const modeNote = executionResult.mode === "live"
        ? ""
        : "\nNote: WhatsApp service mock mode me hai, actual send ke liye `WHATSAPP_ENABLED=true` aur Baileys login required hai.";

    if (summary.failedCount === 0 && summary.duplicateCount === 0 && summary.invalidCount === 0) {
        return `${formatNumber(summary.successCount)} students ko message bhej diya gaya hai ✅${modeNote}`;
    }

    return [
        `WhatsApp campaign process ho gaya.`,
        `Success: ${formatNumber(summary.successCount)}`,
        `Failed: ${formatNumber(summary.failedCount)}`,
        `Duplicate skipped: ${formatNumber(summary.duplicateCount)}`,
        `Invalid numbers: ${formatNumber(summary.invalidCount)}`,
        modeNote.trim()
    ].filter(Boolean).join("\n");
}

function summarizePendingAmount(students) {
    return (Array.isArray(students) ? students : []).reduce((sum, student) => sum + safeNumber(student?.pending), 0);
}

function buildStudentTableRow(student) {
    return {
        name: student?.name || "-",
        phone: student?.phone || "-",
        batch: student?.batch || "-",
        pending: formatCurrency(student?.pending || 0),
        status: student?.status || "-"
    };
}

function getHighestPending(indexes, filters = {}) {
    const items = getPendingList(indexes, filters);
    return items[0] || null;
}

function getHighestPendingStudent(indexes, filters = {}) {
    return getHighestPending(indexes, filters);
}

function getLowestPending(indexes, filters = {}) {
    const items = getPendingList(indexes, filters);
    return items.length ? items[items.length - 1] : null;
}

function getPendingList(indexes, filters = {}) {
    return indexes.students
        .filter((student) => student.pending > 0 && matchesStudentFilters(student, filters))
        .slice()
        .sort((left, right) => safeNumber(right.pending) - safeNumber(left.pending) || left.name.localeCompare(right.name));
}

function getPaidList(indexes, filters = {}) {
    return indexes.students
        .filter((student) => student.pending <= 0 && matchesStudentFilters(student, filters))
        .slice()
        .sort((left, right) => safeNumber(right.totalPaid) - safeNumber(left.totalPaid) || left.name.localeCompare(right.name));
}

function getTopPendingStudents(indexes, limit = 3, filters = {}) {
    return getPendingList(indexes, filters).slice(0, Math.max(safeNumber(limit), 0));
}

function getStudentsByUpcomingEMI(indexes, limit = LIST_PAGE_SIZE, filters = {}) {
    return indexes.students
        .filter((student) => student.pending > 0 && matchesStudentFilters(student, filters))
        .slice()
        .sort((left, right) => (
            safeNumber(left.lastPaymentDate || left.lastDate) - safeNumber(right.lastPaymentDate || right.lastDate)
            || safeNumber(right.pending) - safeNumber(left.pending)
            || left.name.localeCompare(right.name)
        ))
        .slice(0, Math.max(safeNumber(limit), 0));
}

function getBatchStats(batchName, indexes) {
    if (!batchName) {
        return null;
    }

    return indexes.batches.get(batchName) || null;
}

function getTopBatch(indexes) {
    const items = Array.from(indexes.batches.values());
    if (!items.length) {
        return null;
    }

    return items.slice().sort((left, right) => (
        safeNumber(right.revenue) - safeNumber(left.revenue)
        || safeNumber(right.count) - safeNumber(left.count)
        || left.name.localeCompare(right.name)
    ))[0] || null;
}

function getAgentStats(agentName, indexes) {
    if (!agentName) {
        return null;
    }

    return indexes.agents.get(agentName) || null;
}

function getTopAgent(indexes) {
    const items = Array.from(indexes.agents.values());
    if (!items.length) {
        return null;
    }

    return items.slice().sort((left, right) => (
        safeNumber(right.totalSales) - safeNumber(left.totalSales)
        || safeNumber(right.studentsHandled) - safeNumber(left.studentsHandled)
        || left.name.localeCompare(right.name)
    ))[0] || null;
}

function resolveStudentLookup(student, intent) {
    if (!student) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory(intent));
    }

    return buildResolution(
        formatStudentDetail(student),
        {
            lastIntent: intent,
            lastStudent: student,
            lastBatch: student.batch || "",
            lastAgent: student.agent || "",
            lastResult: {
                amount: student.totalPaid,
                pending: student.pending,
                count: 1
            }
        },
        buildStudentMeta(student, intent)
    );
}

function resolveStudentPayment(student) {
    if (!student) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("student_payment"));
    }

    return buildResolution(
        `${student.name} | Amount ${formatCurrency(student.totalPaid)}`,
        {
            lastIntent: "student_payment",
            lastStudent: student,
            lastBatch: student.batch || "",
            lastAgent: student.agent || "",
            lastResult: {
                amount: student.totalPaid,
                count: 1
            }
        },
        buildStudentMeta(student, "student_payment")
    );
}

function resolveStudentPending(student, signals = {}) {
    if (!student) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("student_pending"));
    }

    const emiStatus = classifyEMIStatus(student);
    const actions = safeNumber(student.pending) > 0 ? ["Reminder bhejna", "Follow-up schedule karein"] : [];
    const suggestions = safeNumber(student.pending) > 0
        ? [`${student.name} ko reminder bhejo`, `${student.name} ki EMI date batao`]
        : [];
    const proactiveLine = emiStatus.status === "overdue"
        ? `\nSuggestion: ${student.name} ko reminder bhejna useful rahega.`
        : "";

    return buildResolution(
        `${student.name} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"} | Risk ${student.riskLevel}${proactiveLine}`,
        {
            lastIntent: "student_pending",
            lastStudent: student,
            lastBatch: student.batch || "",
            lastAgent: student.agent || "",
            lastResult: {
                pending: student.pending,
                amount: student.pending,
                count: 1
            }
        },
        {
            ...buildStudentMeta(student, "student_pending"),
            whatsappMessage: buildWhatsAppMessage(student),
            actions,
            suggestions,
            whatsappReady: safeNumber(student.pending) > 0
        }
    );
}

function resolveHighestPendingDetail(indexes) {
    const student = getHighestPendingStudent(indexes);
    if (!student) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("emi_highest_detail"));
    }

    return buildResolution(
        `${student.name} has highest EMI pending: ${formatCurrency(student.pending)}\n\nDetails:\nPhone: ${student.phone || "-"}\nBatch: ${student.batch || "-"}\nAgent: ${student.agent || "-"}\nStatus: ${student.status || "-"}\nRisk: ${student.riskLevel}\nLast Payment Date: ${formatDate(student.lastPaymentDate || student.lastDate)}`,
        {
            lastIntent: "emi_highest_detail",
            lastStudent: student,
            lastBatch: student.batch || "",
            lastAgent: student.agent || "",
            lastResult: {
                pending: student.pending,
                amount: student.pending,
                count: 1
            }
        },
        buildStudentMeta(student, "emi_highest_detail"),
        [{
            name: student.name,
            phone: student.phone,
            batch: student.batch,
            pending: student.pending,
            status: student.status
        }]
    );
}

function resolveStudentCount(entities, metrics, indexes, signals = {}, data = []) {
    const count = countStudentsForQuery(entities, metrics, indexes, signals, data);

    return buildResolution(`${buildStudentCountLabel(signals)} ${formatNumber(count)} hai`, {
        lastIntent: "student_count",
        lastBatch: entities.batch || "",
        lastAgent: entities.agent || "",
        lastTime: signals.time || "",
        lastResult: {
            count
        }
    });
}

function resolvePendingTotals(indexes) {
    const pendingList = getPendingList(indexes);
    const pendingAmount = pendingList.reduce((sum, student) => sum + safeNumber(student.pending), 0);

    return buildResolution(
        `EMI pending ${formatNumber(pendingList.length)} students ka hai | Total ${formatCurrency(pendingAmount)}`,
        {
            lastIntent: "emi_total",
            lastResult: {
                count: pendingList.length,
                pending: pendingAmount,
                amount: pendingAmount
            }
        }
    );
}

function resolvePendingExists(indexes) {
    const pendingList = getPendingList(indexes);
    if (!pendingList.length) {
        return buildResolution("Kisi ka EMI pending nahi hai", {
            lastIntent: "emi_exists",
            lastResult: {
                count: 0,
                pending: 0,
                amount: 0
            }
        }, {
            intent: "emi_exists",
            students: []
        });
    }

    const firstStudent = pendingList[0];
    return buildResolution(
        `${formatNumber(pendingList.length)} students ka EMI pending hai`,
        {
            lastIntent: "emi_exists",
            lastStudent: firstStudent,
            lastBatch: firstStudent.batch || "",
            lastAgent: firstStudent.agent || "",
            lastResult: {
                count: pendingList.length,
                pending: pendingList.reduce((sum, student) => sum + safeNumber(student.pending), 0),
                amount: pendingList.reduce((sum, student) => sum + safeNumber(student.pending), 0)
            }
        },
        buildStudentMeta(firstStudent, "emi_exists")
    );
}

function resolveEMISchedule(entities, session) {
    const student = entities?.student || session?.lastStudent || null;

    if (!student) {
        return buildResolution("EMI schedule ke liye student ka naam ya phone number batayein", {
            lastIntent: "emi_schedule",
            lastResult: null
        }, {
            intent: "emi_schedule",
            students: []
        });
    }

    const emiStatus = classifyEMIStatus(student);
    const predictedDate = predictNextEMIDate(student);

    let reply = "";
    const suggestions = [];

    if (emiStatus.status === "completed") {
        reply = `✅ ${student.name} ki EMI already complete ho chuki hai — next EMI date applicable nahi hai`;
    } else if (predictedDate) {
        reply = `${student.name} ki estimated next EMI date: ${formatDate(predictedDate)} | Pending: ${formatCurrency(student.pending)}`;
        suggestions.push("Send reminder", "Follow-up needed");
    } else if (emiStatus.status === "overdue") {
        reply = `⚠️ ${student.name} ka EMI overdue hai (${emiStatus.reason}) | Pending: ${formatCurrency(student.pending)}`;
        suggestions.push("Send reminder", "Mark high risk", "Follow-up needed");
    } else if (emiStatus.status === "no_schedule") {
        reply = `${student.name} ka next EMI date available nahi hai (${emiStatus.reason})`;
    } else {
        reply = `${student.name} ka next EMI date available nahi hai (${emiStatus.reason}) | Pending: ${formatCurrency(student.pending)}`;
        suggestions.push("Follow-up needed");
    }

    return buildResolution(reply, {
        lastIntent: "emi_schedule",
        lastStudent: student,
        lastReason: emiStatus.reason,
        lastQueryType: "emi",
        lastBatch: student.batch || "",
        lastAgent: student.agent || "",
        lastResult: {
            pending: student.pending,
            status: emiStatus.status,
            predictedDate: predictedDate ? predictedDate.toISOString() : null
        }
    }, {
        ...buildStudentMeta(student, "emi_schedule"),
        emiStatus: emiStatus.status,
        actions: suggestions,
        suggestions: suggestions.map((item) => item === "Send reminder" ? `${student.name} ko reminder bhejo` : item),
        whatsappReady: suggestions.some((item) => /reminder/i.test(item))
    });
}

function classifyEMIStatus(student) {
    if (!student) {
        return { status: "no_schedule", reason: "Student data available nahi hai", nextEstimate: null, suggestion: "" };
    }

    if (safeNumber(student.pending) <= 0) {
        return { status: "completed", reason: "EMI already complete ho chuki hai", nextEstimate: null, suggestion: "No action needed" };
    }

    if (!student.history || student.history.length === 0) {
        return { status: "no_schedule", reason: "Payment history available nahi hai", nextEstimate: null, suggestion: "Data update karein" };
    }

    const lastPaymentTs = safeNumber(student.lastPaymentDate || student.lastDate);
    const now = Date.now();
    const daysSinceLastPayment = lastPaymentTs > 0 ? Math.floor((now - lastPaymentTs) / 86400000) : 999;

    if (daysSinceLastPayment > 45) {
        return {
            status: "overdue",
            reason: `Last payment ${daysSinceLastPayment} din pehle tha`,
            nextEstimate: null,
            suggestion: "Immediate follow-up needed"
        };
    }

    if (daysSinceLastPayment > 30) {
        return {
            status: "overdue",
            reason: `Last payment ${daysSinceLastPayment} din pehle tha — overdue`,
            nextEstimate: null,
            suggestion: "Send reminder"
        };
    }

    return {
        status: "upcoming",
        reason: "EMI pending hai, upcoming payment expected",
        nextEstimate: null,
        suggestion: "Follow-up recommended"
    };
}

function predictNextEMIDate(student) {
    if (!student || safeNumber(student.pending) <= 0) {
        return null;
    }

    const history = student.history || [];
    const paymentDates = history
        .filter((h) => safeNumber(h.amount) > 0 && getTimeValue(h.date) > 0)
        .map((h) => getTimeValue(h.date))
        .sort((a, b) => a - b);

    if (paymentDates.length < 2) {
        return null;
    }

    // Calculate average interval between payments
    let totalInterval = 0;
    for (let i = 1; i < paymentDates.length; i++) {
        totalInterval += paymentDates[i] - paymentDates[i - 1];
    }
    const avgInterval = totalInterval / (paymentDates.length - 1);

    // Only predict if interval is reasonable (7-90 days)
    const avgDays = avgInterval / 86400000;
    if (avgDays < 7 || avgDays > 90) {
        return null;
    }

    const lastDate = paymentDates[paymentDates.length - 1];
    const predicted = new Date(lastDate + avgInterval);

    // Don't return dates too far in the past
    if (predicted.getTime() < Date.now() - 30 * 86400000) {
        return null;
    }

    return predicted;
}

function resolvePendingExtreme(student, intent, label) {
    if (!student) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory(intent));
    }

    return buildResolution(
        `${label === "highest" ? "Highest" : "Lowest"} pending | ${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"}`,
        {
            lastIntent: intent,
            lastStudent: student,
            lastBatch: student.batch || "",
            lastAgent: student.agent || "",
            lastResult: {
                pending: student.pending,
                amount: student.pending,
                count: 1
            }
        },
        buildStudentMeta(student, intent)
    );
}

function resolveUpcomingEMI(indexes, session) {
    const items = getStudentsByUpcomingEMI(indexes);

    return buildListResolution({
        items,
        session,
        intent: "emi_upcoming",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Last Payment ${formatDate(student.lastPaymentDate || student.lastDate)}`
    });
}

function resolveDefaulters(indexes, session) {
    const items = indexes.students
        .filter((student) => student.pending > 0 && (isDueStatus(student.status) || student.pendingHistoryCount > 1))
        .slice()
        .sort((left, right) => safeNumber(right.pending) - safeNumber(left.pending) || left.name.localeCompare(right.name));

    return buildListResolution({
        items,
        session,
        intent: "emi_defaulters",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"} | Risk ${student.riskLevel}`
    });
}

function resolveRiskQuery(entities, indexes, session) {
    if (entities.student) {
        const student = entities.student;
        return buildResolution(
            `${student.name} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"} | Risk ${student.riskLevel}`,
            {
                lastIntent: "emi_risk",
                lastStudent: student,
                lastBatch: student.batch || "",
                lastAgent: student.agent || "",
                lastResult: {
                    pending: student.pending,
                    amount: student.pending,
                    count: 1
                }
            }
        );
    }

    const items = getPendingList(indexes)
        .filter((student) => student.riskLevel === "HIGH")
        .slice()
        .sort((left, right) => safeNumber(right.pending) - safeNumber(left.pending) || left.name.localeCompare(right.name));

    return buildListResolution({
        items,
        session,
        intent: "emi_risk",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Risk ${student.riskLevel}`
    });
}

function resolveSalesByTime(intent, metrics, data) {
    if (intent === "sales_today") {
        const amount = getMetricValue(metrics, "totalSalesToday", sumAmountByTime(data, "today"));
        return buildResolution(`Today revenue ${formatCurrency(amount)} hai`, {
            lastIntent: "sales_today",
            lastTime: "today",
            lastResult: { amount }
        });
    }

    if (intent === "sales_week") {
        const amount = getMetricValue(metrics, "totalSalesThisWeek", sumAmountByTime(data, "this_week"), "weeklySales");
        return buildResolution(`Weekly sales ${formatCurrency(amount)} hai`, {
            lastIntent: "sales_week",
            lastTime: "this_week",
            lastResult: { amount }
        });
    }

    const amount = getMetricValue(metrics, "totalSalesThisMonth", sumAmountByTime(data, "this_month"), "monthlySales");
    return buildResolution(`Monthly sales ${formatCurrency(amount)} hai`, {
        lastIntent: "sales_month",
        lastTime: "this_month",
        lastResult: { amount }
    });
}

function resolveBatchQuery(batchName, indexes) {
    const batch = getBatchStats(batchName, indexes);
    if (!batch) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("batch_query"));
    }

    return buildResolution(
        `${batch.name} | Students ${formatNumber(batch.count)} | Revenue ${formatCurrency(batch.revenue)} | Pending ${formatCurrency(batch.pendingAmount)}`,
        {
            lastIntent: "batch_query",
            lastBatch: batch.name,
            lastResult: {
                count: batch.count,
                amount: batch.revenue,
                pending: batch.pendingAmount
            }
        }
    );
}

function resolveTopBatch(indexes) {
    const batch = getTopBatch(indexes);
    if (!batch) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("batch_top"));
    }

    return buildResolution(
        `Top batch | ${batch.name} | Students ${formatNumber(batch.count)} | Revenue ${formatCurrency(batch.revenue)}`,
        {
            lastIntent: "batch_top",
            lastBatch: batch.name,
            lastResult: {
                count: batch.count,
                amount: batch.revenue
            }
        }
    );
}

function resolveBatchPending(batchName, indexes) {
    const batch = getBatchStats(batchName, indexes);
    if (!batch) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("batch_pending"));
    }

    return buildResolution(
        `${batch.name} | Pending students ${formatNumber(batch.pendingCount)} | Pending ${formatCurrency(batch.pendingAmount)}`,
        {
            lastIntent: "batch_pending",
            lastBatch: batch.name,
            lastResult: {
                count: batch.pendingCount,
                amount: batch.pendingAmount,
                pending: batch.pendingAmount
            }
        }
    );
}

function resolveBatchPaid(batchName, indexes) {
    const batch = getBatchStats(batchName, indexes);
    if (!batch) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("batch_paid"));
    }

    return buildResolution(
        `${batch.name} | Paid students ${formatNumber(batch.paidCount)} | Revenue ${formatCurrency(batch.revenue)}`,
        {
            lastIntent: "batch_paid",
            lastBatch: batch.name,
            lastResult: {
                count: batch.paidCount,
                amount: batch.revenue
            }
        }
    );
}

function resolveBatchComparison(batchNames, indexes) {
    const uniqueBatches = Array.from(new Set((batchNames || []).filter(Boolean)));
    if (uniqueBatches.length < 2) {
        return buildResolution("Please 2 batch names clear likhiye", emptyMemory("batch_comparison"));
    }

    const left = getBatchStats(uniqueBatches[0], indexes);
    const right = getBatchStats(uniqueBatches[1], indexes);
    if (!left || !right) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("batch_comparison"));
    }

    const revenueWinner = left.revenue === right.revenue ? "Tie" : (left.revenue > right.revenue ? left.name : right.name);
    const countWinner = left.count === right.count ? "Tie" : (left.count > right.count ? left.name : right.name);

    return buildResolution(
        `${left.name} | Students ${formatNumber(left.count)} | Revenue ${formatCurrency(left.revenue)} || ${right.name} | Students ${formatNumber(right.count)} | Revenue ${formatCurrency(right.revenue)} || Revenue winner ${revenueWinner} | Student winner ${countWinner}`,
        {
            lastIntent: "batch_comparison",
            lastBatch: left.name,
            lastResult: {
                count: left.count + right.count,
                amount: left.revenue + right.revenue
            }
        }
    );
}

function resolveAgentQuery(agentName, indexes) {
    const agent = getAgentStats(agentName, indexes);
    if (!agent) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("agent_query"));
    }

    return buildResolution(
        `${agent.name} | Students ${formatNumber(agent.studentsHandled)} | Revenue ${formatCurrency(agent.totalSales)} | Pending ${formatCurrency(agent.pendingAmount)}`,
        {
            lastIntent: "agent_query",
            lastAgent: agent.name,
            lastResult: {
                count: agent.studentsHandled,
                amount: agent.totalSales,
                pending: agent.pendingAmount
            }
        }
    );
}

function resolveTopAgent(indexes) {
    const agent = getTopAgent(indexes);
    if (!agent) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("agent_top"));
    }

    return buildResolution(
        `Best agent | ${agent.name} | Students ${formatNumber(agent.studentsHandled)} | Revenue ${formatCurrency(agent.totalSales)}`,
        {
            lastIntent: "agent_top",
            lastAgent: agent.name,
            lastResult: {
                count: agent.studentsHandled,
                amount: agent.totalSales
            }
        }
    );
}

function resolveAgentComparison(agentNames, indexes) {
    const uniqueAgents = Array.from(new Set((agentNames || []).filter(Boolean)));
    if (uniqueAgents.length < 2) {
        return buildResolution("Please 2 agent names clear likhiye", emptyMemory("agent_comparison"));
    }

    const left = getAgentStats(uniqueAgents[0], indexes);
    const right = getAgentStats(uniqueAgents[1], indexes);
    if (!left || !right) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("agent_comparison"));
    }

    const revenueWinner = left.totalSales === right.totalSales ? "Tie" : (left.totalSales > right.totalSales ? left.name : right.name);
    const studentWinner = left.studentsHandled === right.studentsHandled ? "Tie" : (left.studentsHandled > right.studentsHandled ? left.name : right.name);

    return buildResolution(
        `${left.name} | Students ${formatNumber(left.studentsHandled)} | Revenue ${formatCurrency(left.totalSales)} || ${right.name} | Students ${formatNumber(right.studentsHandled)} | Revenue ${formatCurrency(right.totalSales)} || Revenue winner ${revenueWinner} | Student winner ${studentWinner}`,
        {
            lastIntent: "agent_comparison",
            lastAgent: left.name,
            lastResult: {
                count: left.studentsHandled + right.studentsHandled,
                amount: left.totalSales + right.totalSales
            }
        },
        {
            intent: "agent_comparison",
            agent: left.name,
            agents: uniqueAgents.slice(0, 2)
        }
    );
}

function resolveUpgradeCount(indexes) {
    return buildResolution(
        `Upgrade count ${formatNumber(indexes.upgradeCount)} hai`,
        {
            lastIntent: "upgrade_count",
            lastResult: {
                count: indexes.upgradeCount
            }
        },
        {
            intent: "upgrade_count",
            students: indexes.upgradedStudents.map((student) => student.name)
        }
    );
}

function resolveUpgradeList(indexes, session, signals = {}) {
    const items = indexes.upgradeEntries
        .slice()
        .sort((left, right) => getTimeValue(right.date) - getTimeValue(left.date));

    return buildListResolution({
        items,
        session,
        intent: "upgrade_list",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (item) => formatUpgradeEntry(item, signals)
    });
}

function buildStudentListResolution(students, intent, session) {
    const items = students
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name));

    return buildListResolution({
        items,
        session,
        intent,
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: formatStudentDetail
    });
}

function buildRecentStudentsResolution(students, session) {
    const items = students
        .filter((student) => student.joinedDate > 0 || student.lastDate > 0)
        .slice()
        .sort((left, right) => (right.joinedDate || right.lastDate) - (left.joinedDate || left.lastDate));

    return buildListResolution({
        items,
        session,
        intent: "recent_students",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Joined ${formatDate(student.joinedDate || student.lastDate)}`
    });
}

function buildTopStudentsResolution(students, session, count) {
    const items = students
        .slice()
        .sort((left, right) => safeNumber(right.totalPaid) - safeNumber(left.totalPaid) || left.name.localeCompare(right.name))
        .slice(0, count);

    return buildListResolution({
        items,
        session,
        intent: "top_students",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Amount ${formatCurrency(student.totalPaid)}`
    });
}

function buildTopPendingStudentsResolution(items, session, count) {
    return buildListResolution({
        items: items.slice(0, count),
        session,
        intent: "top_pending_students",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"}`
    });
}

function buildPendingListResolution(items, intent, session) {
    return buildListResolution({
        items,
        session,
        intent,
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"}`
    });
}

function buildPaidListResolution(items, session) {
    return buildListResolution({
        items,
        session,
        intent: "paid_list",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (student) => `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Amount ${formatCurrency(student.totalPaid)} | Status ${student.status || "-"}`
    });
}

function buildBatchRankingResolution(indexes, session, intent = "batch_ranking") {
    const items = Array.from(indexes.batches.values())
        .slice()
        .sort((left, right) => safeNumber(right.revenue) - safeNumber(left.revenue) || left.name.localeCompare(right.name));

    return buildListResolution({
        items,
        session,
        intent,
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (batch) => `${batch.name} | Students ${formatNumber(batch.count)} | Revenue ${formatCurrency(batch.revenue)}`,
        tableBuilder: (batch) => ({
            name: batch.name,
            students: batch.count,
            revenue: batch.revenue,
            pending: batch.pendingAmount
        })
    });
}

function buildBatchRevenueResolution(indexes, session) {
    return buildBatchRankingResolution(indexes, session, "batch_revenue");
}

function buildAgentPerformanceResolution(indexes, session) {
    const items = Array.from(indexes.agents.values())
        .slice()
        .sort((left, right) => safeNumber(right.totalSales) - safeNumber(left.totalSales) || left.name.localeCompare(right.name));

    return buildListResolution({
        items,
        session,
        intent: "agent_performance",
        emptyReply: DATA_NOT_AVAILABLE,
        formatter: (agent) => `${agent.name} | Students ${formatNumber(agent.studentsHandled)} | Revenue ${formatCurrency(agent.totalSales)}`
    });
}

function continueLastList(session) {
    const stored = session?.lastList;
    if (!stored || !Array.isArray(stored.items) || !stored.items.length) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("list_continue"));
    }

    const nextItems = stored.items.slice(stored.offset, stored.offset + LIST_PAGE_SIZE);
    if (!nextItems.length) {
        return buildResolution(DATA_NOT_AVAILABLE, {
            ...session,
            updatedAt: Date.now()
        });
    }

    const rendered = nextItems.map((item) => formatStoredListItem(stored.intent, item)).join(" || ");
    return buildResolution(rendered, {
        lastIntent: stored.intent,
        lastBatch: session?.lastBatch || "",
        lastAgent: session?.lastAgent || "",
        lastStudent: null,
        lastList: {
            ...stored,
            offset: stored.offset + nextItems.length
        },
        lastTime: session?.lastTime || "",
        lastResult: session?.lastResult || null
    });
}

function buildListResolution({ items, session, intent, emptyReply, formatter, tableBuilder }) {
    if (!Array.isArray(items) || !items.length) {
        return buildResolution(emptyReply, emptyMemory(intent));
    }

    const pageItems = items.slice(0, LIST_PAGE_SIZE);
    const reply = pageItems.map((item) => formatter(item)).join(" || ");
    const hasMore = items.length > pageItems.length;
    const table = tableBuilder
        ? pageItems.map((item) => tableBuilder(item))
        : pageItems.map((student) => ({
            name: student.name,
            phone: student.phone,
            batch: student.batch,
            pending: student.pending
        }));

    return buildResolution(
        hasMore ? `${reply} || Aur dekhne ke liye "aur kaun" poochiye` : reply,
        {
            lastIntent: intent,
            lastStudent: pageItems.length === 1 ? pageItems[0] : null,
            lastBatch: getMemoryBatch(intent, pageItems[0], session),
            lastAgent: getMemoryAgent(intent, pageItems[0], session),
            lastList: hasMore
                ? {
                    intent,
                    items,
                    offset: pageItems.length
                }
                : null,
            lastTime: session?.lastTime || "",
            lastResult: {
                count: items.length,
                amount: summarizeListAmount(intent, items),
                pending: summarizeListPending(intent, items)
            }
        },
        {},
        table
    );
}

function buildDataIndexes(data, batchStats, agentStats) {
    const records = Array.isArray(data) ? data : [];
    const studentsByKey = new Map();
    const studentsByPhone = new Map();
    let upgradeCount = 0;
    const batchRevenueByName = new Map();
    const agentRevenueByName = new Map();
    const upgradeEntries = [];

    records.forEach((record, index) => {
        const key = buildStudentKey(record, index);
        if (!key) {
            return;
        }

        const amount = safeNumber(record?.amount);
        const pending = safeNumber(record?.pending);
        const timestamp = getTimeValue(record?.date);
        const recordBatch = normalizeMessage(record?.batch);
        const recordAgent = normalizeMessage(record?.agent);

        if (recordBatch) {
            batchRevenueByName.set(recordBatch, safeNumber(batchRevenueByName.get(recordBatch)) + amount);
        }
        if (recordAgent) {
            agentRevenueByName.set(recordAgent, safeNumber(agentRevenueByName.get(recordAgent)) + amount);
        }

        const existing = studentsByKey.get(key) || {
            key,
            name: normalizeMessage(record?.name),
            normalizedName: normalizeQuery(record?.name),
            phone: normalizePhone(record?.phone),
            batch: normalizeMessage(record?.batch),
            agent: normalizeMessage(record?.agent),
            totalPaid: 0,
            pending: 0,
            status: normalizeMessage(record?.status),
            joinedDate: 0,
            firstDate: 0,
            lastDate: 0,
            lastPaymentDate: 0,
            pendingHistoryCount: 0,
            recordCount: 0,
            history: []
        };

        existing.totalPaid += amount;
        existing.recordCount += 1;
        if (normalizeQuery(record?.type) === "upgrade") {
            upgradeCount += 1;
            upgradeEntries.push({
                name: normalizeMessage(record?.name),
                phone: normalizePhone(record?.phone),
                batch: recordBatch,
                date: record?.date
            });
        }
        if (pending > 0) {
            existing.pendingHistoryCount += 1;
        }
        if (amount > 0 && timestamp >= existing.lastPaymentDate) {
            existing.lastPaymentDate = timestamp;
        }
        existing.history.push({
            date: record?.date,
            amount,
            pending,
            status: normalizeMessage(record?.status),
            batch: normalizeMessage(record?.batch),
            agent: normalizeMessage(record?.agent),
            type: normalizeMessage(record?.type),
            emi1: safeNumber(record?.emi1),
            emi2: safeNumber(record?.emi2)
        });

        if (!existing.firstDate || (timestamp > 0 && timestamp < existing.firstDate)) {
            existing.firstDate = timestamp;
        }

        if (normalizeQuery(record?.type) === "new" && timestamp > 0 && (!existing.joinedDate || timestamp < existing.joinedDate)) {
            existing.joinedDate = timestamp;
        }

        if (timestamp >= existing.lastDate) {
            existing.name = normalizeMessage(record?.name) || existing.name;
            existing.normalizedName = normalizeQuery(record?.name) || existing.normalizedName;
            existing.phone = normalizePhone(record?.phone) || existing.phone;
            existing.batch = normalizeMessage(record?.batch) || existing.batch;
            existing.agent = normalizeMessage(record?.agent) || existing.agent;
            existing.status = normalizeMessage(record?.status) || existing.status;
            existing.pending = pending;
            existing.lastDate = timestamp;
        }

        studentsByKey.set(key, existing);
    });

    const students = Array.from(studentsByKey.values())
        .map((student) => ({
            ...student,
            history: student.history
                .slice()
                .sort((left, right) => getTimeValue(right.date) - getTimeValue(left.date)),
            riskLevel: getRiskLevel(student)
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

    const upgradedStudents = students.filter((student) => student.history.some((item) => normalizeQuery(item.type) === "upgrade"));

    students.forEach((student) => {
        if (student.phone) {
            studentsByPhone.set(student.phone, student);
        }
    });

    const batches = new Map();
    Object.keys(batchStats || {}).forEach((name) => {
        if (!normalizeMessage(name)) {
            return;
        }

        batches.set(name, {
            name,
            count: 0,
            revenue: safeNumber(batchRevenueByName.get(name)),
            pendingCount: 0,
            pendingAmount: 0,
            paidCount: 0
        });
    });

    const agents = new Map();
    Object.keys(agentStats || {}).forEach((name) => {
        if (!normalizeMessage(name)) {
            return;
        }

        agents.set(name, {
            name,
            studentsHandled: 0,
            totalSales: safeNumber(agentRevenueByName.get(name)),
            pendingCount: 0,
            pendingAmount: 0
        });
    });

    students.forEach((student) => {
        if (student.batch) {
            const batch = batches.get(student.batch) || {
                name: student.batch,
                count: 0,
                revenue: safeNumber(batchRevenueByName.get(student.batch)),
                pendingCount: 0,
                pendingAmount: 0,
                paidCount: 0
            };

            batch.count += 1;
            if (student.pending > 0) {
                batch.pendingCount += 1;
                batch.pendingAmount += safeNumber(student.pending);
            } else {
                batch.paidCount += 1;
            }

            batches.set(student.batch, batch);
        }

        if (student.agent) {
            const agent = agents.get(student.agent) || {
                name: student.agent,
                studentsHandled: 0,
                totalSales: safeNumber(agentRevenueByName.get(student.agent)),
                pendingCount: 0,
                pendingAmount: 0
            };

            agent.studentsHandled += 1;
            if (student.pending > 0) {
                agent.pendingCount += 1;
                agent.pendingAmount += safeNumber(student.pending);
            }

            agents.set(student.agent, agent);
        }
    });

    return {
        students,
        studentsByPhone,
        batches,
        agents,
        upgradeCount,
        upgradedStudents,
        upgradeEntries,
        batchEntries: Array.from(batches.keys())
            .map((name) => ({ name, normalized: normalizeQuery(name) }))
            .sort((left, right) => right.normalized.length - left.normalized.length),
        agentEntries: Array.from(agents.keys())
            .map((name) => ({ name, normalized: normalizeQuery(name) }))
            .sort((left, right) => right.normalized.length - left.normalized.length)
    };
}

function normalizeMessage(value) {
    return String(value || "").trim();
}

function normalizeQuery(value) {
    let query = normalizeMessage(value)
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    PHRASE_NORMALIZATION_MAP.forEach(([from, to]) => {
        query = query.replaceAll(from, to);
    });

    Object.entries(SEMANTIC_MAP).forEach(([target, synonyms]) => {
        (synonyms || []).forEach((synonym) => {
            const pattern = new RegExp(`\\b${escapeRegExp(synonym)}\\b`, "g");
            query = query.replace(pattern, target);
        });
    });

    query = query
        .split(" ")
        .map((word) => WORD_NORMALIZATION_MAP[word] || word)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    return query;
}

function detectTimeContext(query) {
    if (hasAny(query, ["today"])) {
        return "today";
    }
    if (hasAny(query, ["yesterday"])) {
        return "yesterday";
    }
    if (hasAny(query, ["week"])) {
        return "this_week";
    }
    if (hasAny(query, ["month"])) {
        return "this_month";
    }
    return "";
}

function detectComparison(query) {
    if (hasAny(query, ["vs", "compare", "comparison"])) {
        return "compare";
    }
    if (hasAny(query, ["sabse zyada", "highest", "most", "top", "best"])) {
        return "highest";
    }
    if (hasAny(query, ["sabse kam", "lowest", "least"])) {
        return "lowest";
    }
    return "";
}

function detectComparativeWords(query) {
    return detectComparison(query);
}

function extractTopCount(query) {
    const match = query.match(/\btop\s+(\d+)\b/);
    return match ? safeNumber(match[1]) : 0;
}

function detectTopCount(query) {
    return extractTopCount(query);
}

function detectPhoneStrict(query) {
    const phoneMatch = normalizeMessage(query).match(/\b\d{10,12}\b/);
    return phoneMatch ? normalizePhone(phoneMatch[0]) : "";
}

function detectFollowUpContext(query) {
    if (hasAny(query, ["uska", "uski", "uske", "that"])) {
        return "student";
    }
    if (hasAny(query, ["us_batch"])) {
        return "batch";
    }
    if (hasAny(query, ["us agent"])) {
        return "agent";
    }
    return "";
}

function splitIntents(query) {
    return normalizeMessage(query)
        .split(INTENT_SPLIT_PATTERN)
        .map((part) => normalizeMessage(part))
        .filter(Boolean);
}

function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNameHint(query, batches, agents) {
    let candidate = query;

    (batches || []).forEach((batch) => {
        candidate = candidate.replaceAll(normalizeQuery(batch), " ");
    });

    (agents || []).forEach((agent) => {
        candidate = candidate.replaceAll(normalizeQuery(agent), " ");
    });

    return candidate
        .split(" ")
        .filter((word) => word && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
        .join(" ")
        .trim();
}

function countStudentsForQuery(entities, metrics, indexes, signals = {}, data = []) {
    const hasSpecificFilters = Boolean(
        entities.batch
        || entities.agent
        || signals.time
        || signals.wantsPaid
        || signals.wantsPending
        || signals.wantsBatch
    );

    if (!hasSpecificFilters) {
        if (entities.batch) {
            return safeNumber(getBatchStats(entities.batch, indexes)?.count);
        }
        if (entities.agent) {
            return indexes.students.filter((student) => student.agent === entities.agent).length;
        }
        return getMetricValue(metrics, "totalStudents", indexes.students.length);
    }

    const filteredRecords = (Array.isArray(data) ? data : []).filter((record) => {
        if (entities.batch && normalizeMessage(record?.batch) !== entities.batch) {
            return false;
        }

        if (entities.agent && normalizeMessage(record?.agent) !== entities.agent) {
            return false;
        }

        if (signals.time && !isWithinTime(record?.date, signals.time)) {
            return false;
        }

        if (signals.wantsPending && safeNumber(record?.pending) <= 0) {
            return false;
        }

        if (signals.wantsPaid) {
            const hasPaidAmount = safeNumber(record?.amount) > 0;
            const statusLooksPaid = isClearedPaymentStatus(normalizeMessage(record?.status));
            const isClearedEmi = statusLooksPaid || safeNumber(record?.pending) <= 0;
            const matchesPaidQuery = signals.wantsBatch ? hasPaidAmount : isClearedEmi;
            if (!matchesPaidQuery) {
                return false;
            }
        }

        if (signals.wantsBatch && normalizeQuery(record?.type) !== "new") {
            return false;
        }

        return true;
    });

    if (!filteredRecords.length) {
        if (signals.time === "today" && signals.wantsBatch && !entities.batch && !entities.agent) {
            return getMetricValue(metrics, "studentsJoinedToday", 0, "studentsToday");
        }
        return 0;
    }

    return countUniqueStudentsFromRecords(filteredRecords);
}

function countUniqueStudentsFromRecords(records) {
    const uniqueStudents = new Set();

    (Array.isArray(records) ? records : []).forEach((record) => {
        const phone = normalizePhone(record?.phone);
        const name = normalizeQuery(record?.name);
        const key = phone ? `phone:${phone}` : (name ? `name:${name}` : "");
        if (key) {
            uniqueStudents.add(key);
        }
    });

    return uniqueStudents.size;
}

function buildStudentCountLabel(signals = {}) {
    if (signals.wantsPending) {
        return signals.time === "today" ? "Aaj pending students" : "Pending students";
    }

    if (signals.wantsPaid && queryMentionsBatchPurchase(signals)) {
        return signals.time === "today" ? "Aaj batch khareedne wale students" : "Batch khareedne wale students";
    }

    if (signals.wantsPaid) {
        return signals.time === "today" ? "Aaj payment clear karne wale students" : "Payment clear karne wale students";
    }

    if (signals.time === "today") {
        return "Aaj students";
    }

    return "Total students";
}

function queryMentionsBatchPurchase(signals = {}) {
    return Boolean(signals.wantsBatch);
}

function findNamedMatches(query, entries) {
    const matches = [];

    (entries || []).forEach((entry) => {
        if (!entry?.normalized) {
            return;
        }

        if (query.includes(entry.normalized) && !matches.includes(entry.name)) {
            matches.push(entry.name);
        }
    });

    return matches;
}

function expandBatchComparisonMatches(query, matches, entries, signals) {
    const uniqueMatches = Array.from(new Set((matches || []).filter(Boolean)));
    if (!signals?.wantsComparison || uniqueMatches.length >= 2) {
        return uniqueMatches;
    }

    const years = Array.from(new Set(query.match(/\b20\d{2}\b/g) || []));
    if (uniqueMatches.length !== 1 || years.length < 2) {
        return uniqueMatches;
    }

    const firstMatch = uniqueMatches[0];
    const base = normalizeQuery(firstMatch).replace(/\b20\d{2}\b/g, "").trim();

    years.forEach((year) => {
        const found = (entries || []).find((entry) => (
            entry.normalized.includes(year)
            && (!base || entry.normalized.includes(base))
        ));

        if (found && !uniqueMatches.includes(found.name)) {
            uniqueMatches.push(found.name);
        }
    });

    return uniqueMatches;
}

function matchesStudentFilters(student, filters) {
    if (filters.batch && student.batch !== filters.batch) {
        return false;
    }
    if (filters.agent && student.agent !== filters.agent) {
        return false;
    }
    return true;
}

function formatStudentDetail(student) {
    return `${student.name} | Phone ${student.phone || "-"} | Batch ${student.batch || "-"} | Agent ${student.agent || "-"} | Total Paid ${formatCurrency(student.totalPaid)} | Pending ${formatCurrency(student.pending)} | Status ${student.status || "-"} | Risk ${student.riskLevel} | Last Payment ${formatDate(student.lastPaymentDate || student.lastDate)}`;
}

function formatStoredListItem(intent, item) {
    switch (intent) {
    case "student_list":
        return formatStudentDetail(item);
    case "recent_students":
        return `${item.name} | Phone ${item.phone || "-"} | Batch ${item.batch || "-"} | Joined ${formatDate(item.joinedDate || item.lastDate)}`;
    case "top_students":
        return `${item.name} | Phone ${item.phone || "-"} | Batch ${item.batch || "-"} | Amount ${formatCurrency(item.totalPaid)}`;
    case "top_pending_students":
    case "pending_list":
    case "emi_risk":
    case "emi_defaulters":
    case "emi_upcoming":
        return `${item.name} | Phone ${item.phone || "-"} | Batch ${item.batch || "-"} | Pending ${formatCurrency(item.pending)} | Status ${item.status || "-"}${item.riskLevel ? ` | Risk ${item.riskLevel}` : ""}`;
    case "paid_list":
        return `${item.name} | Phone ${item.phone || "-"} | Batch ${item.batch || "-"} | Amount ${formatCurrency(item.totalPaid)} | Status ${item.status || "-"}`;
    case "batch_ranking":
    case "batch_revenue":
        return `${item.name} | Students ${formatNumber(item.count)} | Revenue ${formatCurrency(item.revenue)}`;
    case "agent_performance":
        return `${item.name} | Students ${formatNumber(item.studentsHandled)} | Revenue ${formatCurrency(item.totalSales)}`;
    case "upgrade_list":
        return formatUpgradeEntry(item, { asksPhone: true });
    default:
        return normalizeMessage(item?.name || DATA_NOT_AVAILABLE);
    }
}

function formatUpgradeEntry(item, signals = {}) {
    const base = `${item.name || "-"} | ${item.batch || "-"} | ${formatDate(item.date)}`;
    if (signals.asksPhone || normalizeMessage(item?.phone)) {
        return `${item.name || "-"} | Phone ${item.phone || "-"} | ${item.batch || "-"} | ${formatDate(item.date)}`;
    }
    return base;
}

function buildStudentMeta(student, intent) {
    if (!student) {
        return {
            intent,
            student: "",
            students: [],
            phone: "",
            pending: 0,
            batch: "",
            agent: "",
            whatsapp: {
                phone: "",
                message: ""
            },
            whatsappMessage: ""
        };
    }

    return {
        intent,
        student: student.name || "",
        students: [student.name || ""].filter(Boolean),
        phone: student.phone || "",
        pending: safeNumber(student.pending),
        batch: student.batch || "",
        agent: student.agent || "",
        whatsapp: {
            phone: student.phone || "",
            message: buildWhatsAppMessage(student)
        },
        whatsappMessage: buildWhatsAppMessage(student)
    };
}

function buildStudentKey(record, index) {
    const phone = normalizePhone(record?.phone);
    if (phone) {
        return `phone:${phone}`;
    }

    const name = normalizeQuery(record?.name);
    if (name) {
        return `name:${name}`;
    }

    const batch = normalizeQuery(record?.batch);
    return batch ? `fallback:${batch}:${index}` : "";
}

function buildResolution(reply, memoryState, meta = {}, table = []) {
    const normalizedMeta = buildMeta(memoryState, meta);

    return {
        reply: String(reply || DATA_NOT_AVAILABLE),
        table: Array.isArray(table) ? table : [],
        meta: {
            ...normalizedMeta,
            ...meta,
            actions: meta.actions || [],
            confidence: meta.confidence !== undefined ? meta.confidence : 1.0,
            suggestions: meta.suggestions || [],
            emiStatus: meta.emiStatus || "",
            reminderReady: Boolean(meta.actions && meta.actions.length > 0),
            whatsappReady: meta.whatsappReady !== undefined ? Boolean(meta.whatsappReady) : Boolean(normalizedMeta.whatsapp?.phone),
            confirmationRequired: Boolean(meta.confirmationRequired)
        },
        memoryState: {
            lastIntent: memoryState?.lastIntent || "",
            lastStudent: memoryState?.lastStudent || null,
            lastBatch: memoryState?.lastBatch || "",
            lastAgent: memoryState?.lastAgent || "",
            lastList: memoryState?.lastList || null,
            lastTime: memoryState?.lastTime || "",
            lastResult: memoryState?.lastResult || null,
            lastReason: memoryState?.lastReason || "",
            lastQueryType: memoryState?.lastQueryType || "",
            lastFailedQuery: memoryState?.lastFailedQuery || "",
            lastMeta: normalizedMeta,
            pendingConfirmation: memoryState?.pendingConfirmation || null,
            lastBroadcast: memoryState?.lastBroadcast || null,
            updatedAt: Date.now()
        }
    };
}

function combineReplies(results) {
    const usableResults = (Array.isArray(results) ? results : []).filter((result) => normalizeMessage(result?.reply));
    if (!usableResults.length) {
        return buildResolution(DATA_NOT_AVAILABLE, emptyMemory("combined"));
    }

    if (usableResults.length === 1) {
        return usableResults[0];
    }

    const seenReplies = new Set();
    const replyParts = [];
    const primaryStudentResult = usableResults.find((item) => normalizeMessage(item?.meta?.student));

    usableResults.forEach((result) => {
        if (!normalizeMessage(result?.meta?.student) && normalizeMessage(primaryStudentResult?.meta?.student)) {
            result.meta = {
                ...result.meta,
                student: primaryStudentResult.meta.student,
                phone: result.meta?.phone || primaryStudentResult.meta.phone,
                pending: result.meta?.pending !== undefined ? result.meta.pending : primaryStudentResult.meta.pending,
                batch: result.meta?.batch || primaryStudentResult.meta.batch,
                agent: result.meta?.agent || primaryStudentResult.meta.agent,
                whatsapp: result.meta?.whatsapp || primaryStudentResult.meta.whatsapp,
                whatsappMessage: result.meta?.whatsappMessage || primaryStudentResult.meta.whatsappMessage
            };
        }
    });
    
    usableResults.forEach((result) => {
        const key = normalizeQuery(result.reply);
        if (!key || seenReplies.has(key)) {
            return;
        }

        seenReplies.add(key);
        replyParts.push(result.reply);
    });

    const lastResult = usableResults[usableResults.length - 1];
    const metaSource = lastResult.meta?.student ? lastResult : (primaryStudentResult || lastResult);
    const combinedTable = usableResults.flatMap((item) => (Array.isArray(item.table) ? item.table : []));
    const combinedMeta = {
        intent: usableResults.map((item) => item.meta?.intent || item.memoryState?.lastIntent || "").filter(Boolean).join(", "),
        student: metaSource.meta?.student || "",
        students: Array.from(new Set(usableResults.flatMap((item) => item.meta?.students || []).filter(Boolean))),
        phone: metaSource.meta?.phone || "",
        pending: safeNumber(metaSource.meta?.pending),
        batch: metaSource.meta?.batch || "",
        agent: metaSource.meta?.agent || "",
        whatsapp: metaSource.meta?.whatsapp || { phone: "", message: "" },
        whatsappMessage: metaSource.meta?.whatsappMessage || "",
        audienceLabel: metaSource.meta?.audienceLabel || "",
        whatsappPreview: metaSource.meta?.whatsappPreview || "",
        lastBroadcast: metaSource.meta?.lastBroadcast || null
    };

    return buildResolution(replyParts.join("\n\n"), lastResult.memoryState, combinedMeta, combinedTable);
}

function buildMeta(memoryState, overrideMeta = {}) {
    const student = memoryState?.lastStudent || null;
    const listItems = Array.isArray(memoryState?.lastList?.items) ? memoryState.lastList.items : [];
    const firstListStudent = listItems.find((item) => normalizeMessage(item?.name)) || null;
    const students = overrideMeta.students
        || (student
            ? [student.name].filter(Boolean)
            : listItems.slice(0, LIST_PAGE_SIZE).map((item) => item?.name).filter(Boolean));
    const baseStudent = student || firstListStudent;
    const whatsapp = overrideMeta.whatsapp || (baseStudent
        ? {
            phone: baseStudent.phone || "",
            message: buildWhatsAppMessage(baseStudent)
        }
        : { phone: "", message: "" });

    return {
        intent: overrideMeta.intent || memoryState?.lastIntent || "",
        student: overrideMeta.student || baseStudent?.name || "",
        students,
        phone: overrideMeta.phone || baseStudent?.phone || "",
        pending: overrideMeta.pending !== undefined ? safeNumber(overrideMeta.pending) : safeNumber(memoryState?.lastResult?.pending),
        batch: overrideMeta.batch || memoryState?.lastBatch || baseStudent?.batch || "",
        agent: overrideMeta.agent || memoryState?.lastAgent || baseStudent?.agent || "",
        whatsapp,
        whatsappMessage: overrideMeta.whatsappMessage || whatsapp.message || "",
        audienceLabel: overrideMeta.audienceLabel || "",
        whatsappPreview: overrideMeta.whatsappPreview || "",
        lastBroadcast: overrideMeta.lastBroadcast || memoryState?.lastBroadcast || null
    };
}

function buildWhatsAppMessage(student) {
    if (!student) {
        return "";
    }

    return `Namaste ${student.name || "Student"},\nAapka ${formatCurrency(student.pending)} EMI pending hai.\nKripya payment jaldi complete karein.`;
}

function emptyMemory(intent) {
    return {
        lastIntent: intent,
        lastStudent: null,
        lastBatch: "",
        lastAgent: "",
        lastList: null,
        lastTime: "",
        lastResult: null,
        lastReason: "",
        lastQueryType: "",
        lastFailedQuery: "",
        pendingConfirmation: null,
        lastBroadcast: null
    };
}

function buildMemoryState({ session, intent, entities }) {
    return {
        lastIntent: intent || session?.lastIntent || "",
        lastStudent: entities?.student || session?.lastStudent || null,
        lastBatch: entities?.batch || session?.lastBatch || "",
        lastAgent: entities?.agent || session?.lastAgent || "",
        lastList: session?.lastList || null,
        lastTime: entities?.time || session?.lastTime || "",
        lastResult: session?.lastResult || null,
        lastReason: session?.lastReason || "",
        lastQueryType: session?.lastQueryType || "",
        lastFailedQuery: session?.lastFailedQuery || "",
        lastMeta: session?.lastMeta || null,
        pendingConfirmation: session?.pendingConfirmation || null,
        lastBroadcast: session?.lastBroadcast || null
    };
}

function getMemoryBatch(intent, item, session) {
    if (intent.startsWith("batch")) {
        return item?.name || session?.lastBatch || "";
    }
    return item?.batch || session?.lastBatch || "";
}

function getMemoryAgent(intent, item, session) {
    if (intent.startsWith("agent")) {
        return item?.name || session?.lastAgent || "";
    }
    return item?.agent || session?.lastAgent || "";
}

function summarizeListAmount(intent, items) {
    if (intent === "paid_list" || intent === "top_students") {
        return items.reduce((sum, item) => sum + safeNumber(item.totalPaid), 0);
    }
    if (intent === "batch_ranking" || intent === "batch_revenue") {
        return items.reduce((sum, item) => sum + safeNumber(item.revenue), 0);
    }
    if (intent === "agent_performance") {
        return items.reduce((sum, item) => sum + safeNumber(item.totalSales), 0);
    }
    return items.reduce((sum, item) => sum + safeNumber(item.pending), 0);
}

function summarizeListPending(intent, items) {
    if (intent === "batch_ranking" || intent === "batch_revenue" || intent === "agent_performance") {
        return 0;
    }
    return items.reduce((sum, item) => sum + safeNumber(item.pending), 0);
}

function getSessionState(sessionId) {
    return sessionMemory.get(String(sessionId || "default-session")) || null;
}

function updateSessionMemory(sessionId, state) {
    sessionMemory.set(String(sessionId || "default-session"), {
        lastIntent: state?.lastIntent || "",
        lastStudent: state?.lastStudent || null,
        lastBatch: state?.lastBatch || "",
        lastAgent: state?.lastAgent || "",
        lastList: state?.lastList || null,
        lastTime: state?.lastTime || "",
        lastResult: state?.lastResult || null,
        lastReason: state?.lastReason || "",
        lastQueryType: state?.lastQueryType || "",
        lastFailedQuery: state?.lastFailedQuery || "",
        lastMeta: state?.lastMeta || null,
        pendingConfirmation: state?.pendingConfirmation || null,
        lastBroadcast: state?.lastBroadcast || null,
        updatedAt: Date.now()
    });
}

function pruneSessionMemory() {
    const now = Date.now();
    for (const [key, value] of sessionMemory.entries()) {
        if (!value?.updatedAt || now - value.updatedAt > MEMORY_TTL_MS) {
            sessionMemory.delete(key);
        }
    }
}

function normalizePhone(value) {
    return normalizeMessage(value).replace(/\D/g, "");
}

function getMetricValue(metrics, primaryKey, fallbackValue, secondaryKey = "") {
    const primaryRaw = metrics?.[primaryKey];
    if (primaryRaw !== undefined && primaryRaw !== null && primaryRaw !== "") {
        return safeNumber(primaryRaw);
    }

    if (secondaryKey) {
        const secondaryRaw = metrics?.[secondaryKey];
        if (secondaryRaw !== undefined && secondaryRaw !== null && secondaryRaw !== "") {
            return safeNumber(secondaryRaw);
        }
    }

    return safeNumber(fallbackValue);
}

function sumAmount(records) {
    return (Array.isArray(records) ? records : []).reduce((sum, record) => sum + safeNumber(record?.amount), 0);
}

function sumAmountByTime(records, time) {
    return (Array.isArray(records) ? records : []).reduce((sum, record) => (
        isWithinTime(record?.date, time) ? sum + safeNumber(record?.amount) : sum
    ), 0);
}

function isWithinTime(value, time) {
    const recordSerial = getDaySerial(value);
    const todaySerial = getDaySerial(new Date());
    if (!recordSerial || !todaySerial) {
        return false;
    }

    if (time === "today") {
        return recordSerial === todaySerial;
    }
    if (time === "yesterday") {
        return recordSerial === todaySerial - 1;
    }
    if (time === "this_week") {
        const todayParts = getDateParts(new Date());
        const weekday = todayParts
            ? new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day)).getUTCDay()
            : 0;
        const weekStart = todaySerial - ((weekday + 6) % 7);
        return recordSerial >= weekStart && recordSerial <= todaySerial;
    }
    if (time === "this_month") {
        const recordParts = getDateParts(value);
        const todayParts = getDateParts(new Date());
        return Boolean(
            recordParts
            && todayParts
            && recordParts.year === todayParts.year
            && recordParts.month === todayParts.month
        );
    }

    return false;
}

function getRiskLevel(student) {
    if (safeNumber(student?.pending) <= 0 && !isDueStatus(student?.status)) {
        return "CLEAR";
    }

    let score = 0;

    if (safeNumber(student?.pending) > 1000) {
        score += 50;
    }
    if (isDueStatus(student?.status)) {
        score += 30;
    }
    if (safeNumber(student?.pendingHistoryCount) > 1) {
        score += 20;
    }

    if (score >= 80) {
        return "HIGH";
    }
    if (score >= 30) {
        return "MEDIUM";
    }
    return "LOW";
}

function getTimeValue(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getDateParts(value) {
    const timeValue = getTimeValue(value);
    if (!timeValue) {
        return null;
    }

    const parts = CACHED_DATE_PARTS_FORMATTER.formatToParts(new Date(timeValue));
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    if (!year || !month || !day) {
        return null;
    }

    return { year, month, day };
}

function getDaySerial(value) {
    const parts = getDateParts(value);
    return parts ? Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000) : 0;
}

function formatDate(value) {
    const timeValue = getTimeValue(value);
    if (!timeValue) {
        return "-";
    }

    return CACHED_DATE_DISPLAY_FORMATTER.format(new Date(timeValue));
}

function formatCurrency(value) {
    return CACHED_CURRENCY_FORMATTER.format(safeNumber(value));
}

function formatNumber(value) {
    return CACHED_NUMBER_FORMATTER.format(safeNumber(value));
}

function safeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isDueStatus(value) {
    return isPendingPaymentStatus(normalizeMessage(value));
}

function hasAny(query, phrases) {
    return (phrases || []).some((phrase) => query.includes(phrase));
}

// =============================================
// REASONING ENGINE (WHY / HOW / WHEN / ACTION)
// =============================================

function resolveWhy(session) {
    if (!session?.lastIntent) {
        return buildResolution(
            "Kis cheez ka reason chahiye? Pehle koi query poochiye, phir \"kyu?\" poochiye",
            emptyMemory("explain_previous")
        );
    }

    const student = session.lastStudent;
    const reason = session.lastReason || "";

    // EMI schedule explanation
    if (session.lastIntent === "emi_schedule") {
        if (reason) {
            const reply = student
                ? `Kyuki ${student.name} ki ${reason}`
                : reason;
            return buildResolution(reply, { ...session, updatedAt: Date.now() });
        }
        return buildResolution("EMI schedule data available nahi hai sheet me", { ...session, updatedAt: Date.now() });
    }

    // Student pending explanation
    if (session.lastIntent === "student_pending" && student) {
        const emiStatus = classifyEMIStatus(student);
        const parts = [`${student.name} ka pending ${formatCurrency(student.pending)} hai`];
        if (student.riskLevel === "HIGH") {
            parts.push("Risk HIGH hai kyuki pending amount zyada hai aur status due hai");
        }
        if (emiStatus.status === "overdue") {
            parts.push(emiStatus.reason);
        }
        return buildResolution(parts.join(" | "), { ...session, updatedAt: Date.now() });
    }

    // Student payment explanation
    if (session.lastIntent === "student_payment" && student) {
        return buildResolution(
            `${student.name} ne total ${formatCurrency(student.totalPaid)} pay kiya hai | Status: ${student.status || "-"}`,
            { ...session, updatedAt: Date.now() }
        );
    }

    // EMI highest/risk explanation
    if ((session.lastIntent === "emi_highest" || session.lastIntent === "emi_risk") && student) {
        const parts = [`${student.name} ka pending sabse zyada hai: ${formatCurrency(student.pending)}`];
        if (student.riskLevel === "HIGH") {
            parts.push("Risk HIGH hai");
        }
        if (isDueStatus(student.status)) {
            parts.push("Status: Due");
        }
        return buildResolution(parts.join(" | "), { ...session, updatedAt: Date.now() });
    }

    // Batch query explanation
    if (session.lastIntent?.startsWith("batch_") && session.lastBatch) {
        return buildResolution(
            `${session.lastBatch} batch ka data based on Google Sheets se aaya hai`,
            { ...session, updatedAt: Date.now() }
        );
    }

    // Generic with reason
    if (reason) {
        return buildResolution(reason, { ...session, updatedAt: Date.now() });
    }

    return buildResolution(
        "Iska specific reason available nahi hai. Koi specific student ya batch ke baare me poochiye",
        { ...session, updatedAt: Date.now() }
    );
}

function resolveHow(session) {
    if (!session?.lastIntent) {
        return buildResolution(
            "Kya kaise karna hai? Pehle koi query poochiye",
            emptyMemory("explain_how")
        );
    }

    const student = session.lastStudent;
    const actions = [];

    if (session.lastIntent === "student_pending" && student) {
        if (safeNumber(student.pending) > 0) {
            actions.push(`${student.name} ko WhatsApp reminder bhejein`);
            actions.push("Payment link share karein");
            if (student.riskLevel === "HIGH") {
                actions.push("Agent ko follow-up ke liye inform karein");
            }
        } else {
            actions.push("EMI complete hai, koi action needed nahi hai");
        }
    } else if (session.lastIntent === "emi_schedule") {
        actions.push("Student se next payment date confirm karein");
        actions.push("Agent se follow-up schedule karwayein");
    } else if (session.lastIntent?.startsWith("batch_")) {
        actions.push("Batch wise report download karein");
        actions.push("Pending students ko bulk reminder bhejein");
    } else {
        actions.push("Specific student ka naam poochke detail dekhein");
        actions.push("Batch wise ya agent wise report check karein");
    }

    return buildResolution(
        actions.join(" | "),
        { ...session, lastIntent: "explain_how", updatedAt: Date.now() },
        { intent: "explain_how", actions }
    );
}

function resolveWhen(session, entities, indexes) {
    const student = entities?.student || session?.lastStudent || null;

    if (!student) {
        return buildResolution(
            "Kab ka answer dene ke liye student ka naam batayein",
            emptyMemory("explain_when")
        );
    }

    if (safeNumber(student.pending) <= 0) {
        return buildResolution(
            `✅ ${student.name} ki EMI already complete hai — koi upcoming date nahi hai`,
            { ...session, lastIntent: "explain_when", lastStudent: student, lastReason: "EMI complete hai", updatedAt: Date.now() }
        );
    }

    const predictedDate = predictNextEMIDate(student);
    if (predictedDate) {
        return buildResolution(
            `${student.name} ki estimated next EMI date: ${formatDate(predictedDate)} | Pending: ${formatCurrency(student.pending)}`,
            { ...session, lastIntent: "explain_when", lastStudent: student, updatedAt: Date.now() },
            { ...buildStudentMeta(student, "explain_when"), actions: ["Send reminder", "Follow-up needed"] }
        );
    }

    const emiStatus = classifyEMIStatus(student);
    return buildResolution(
        `${student.name} ki exact date available nahi hai (${emiStatus.reason}) | Follow-up recommended`,
        { ...session, lastIntent: "explain_when", lastStudent: student, lastReason: emiStatus.reason, updatedAt: Date.now() },
        { ...buildStudentMeta(student, "explain_when"), actions: ["Follow-up needed"] }
    );
}

function resolveAction(session, entities, indexes) {
    const student = entities?.student || session?.lastStudent || null;
    const actions = [];
    const parts = [];

    if (student) {
        const emiStatus = classifyEMIStatus(student);

        if (emiStatus.status === "completed") {
            parts.push(`✅ ${student.name} ki EMI complete hai`);
            actions.push("No action needed");
        } else if (emiStatus.status === "overdue") {
            parts.push(`🔴 ${student.name} ka EMI overdue hai (${emiStatus.reason})`);
            actions.push("Send WhatsApp reminder");
            actions.push("Mark as high risk");
            actions.push("Agent ko inform karein");
            if (student.phone) {
                actions.push(`Call: ${student.phone}`);
            }
        } else if (emiStatus.status === "upcoming") {
            parts.push(`⚠️ ${student.name} ka EMI upcoming hai | Pending: ${formatCurrency(student.pending)}`);
            actions.push("Send reminder");
            actions.push("Follow-up schedule karein");
        } else {
            parts.push(`${student.name} ka pending: ${formatCurrency(student.pending)}`);
            actions.push("Data update karein");
            actions.push("Student se contact karein");
        }
    } else if (session?.lastBatch) {
        parts.push(`${session.lastBatch} batch ke liye suggestions:`);
        actions.push("Pending students ko bulk reminder bhejein");
        actions.push("Batch performance report dekhein");
        actions.push("High risk students identify karein");
    } else {
        parts.push("Suggestions:");
        actions.push("Student ka pending check karein");
        actions.push("Batch wise report dekhein");
        actions.push("High risk students ki list dekhein");
        actions.push("Today ki sales check karein");
    }

    parts.push("Actions: " + actions.join(", "));

    return buildResolution(
        parts.join(" | "),
        {
            ...session,
            lastIntent: "suggest_action",
            lastStudent: student || session?.lastStudent || null,
            updatedAt: Date.now()
        },
        {
            intent: "suggest_action",
            actions,
            student: student?.name || "",
            reminderReady: actions.some((a) => a.toLowerCase().includes("reminder"))
        }
    );
}

// =============================================
// SMART FALLBACK & LOGGING
// =============================================

function buildSmartFallback(query, entities, signals, session) {
    const suggestions = [];
    let reply = "";

    // If there's a name hint that didn't match
    if (entities.nameHint && !entities.student) {
        reply = `"${entities.nameHint}" se match nahi mila. Kya correct name ya phone number de sakte hain?`;
        suggestions.push("Student list dekhein", "Phone number se search karein");
        return { reply, suggestions };
    }

    // If we have a failed query from retry context
    if (session?.lastFailedQuery) {
        reply = "Pichli query bhi samajh nahi aayi thi. Kya aap in me se kuch poochna chahte hain?";
    } else {
        reply = "Ye query samajh nahi aayi. Kya aap in me se kuch poochna chahte hain?";
    }

    // Context-aware suggestions based on signals
    if (signals.wantsPending || signals.wantsPaid) {
        suggestions.push("Kiska pending hai?", "Top pending students", "Batch wise pending");
    } else if (signals.wantsBatch || signals.wantsAgent) {
        suggestions.push("Batch wise report", "Agent performance", "Top batch");
    } else if (signals.wantsStudents) {
        suggestions.push("Student list", "Recent students", "Student ka pending");
    } else {
        // Generic suggestions
        suggestions.push(
            "Student ka pending check karein (e.g. 'Rahul ka pending')",
            "Batch report (e.g. 'Batch 2026 ka data')",
            "Today ki sales",
            "Pending list"
        );
    }

    return { reply, suggestions };
}

function logQuery(query, intent, confidence) {
    const timestamp = new Date().toISOString();
    const level = confidence >= 0.7 ? "INFO" : (confidence >= 0.4 ? "WARN" : "ERROR");
    conversationHistory.unshift({
        query: normalizeMessage(query),
        intent: normalizeMessage(intent),
        confidence: safeNumber(confidence),
        time: timestamp
    });
    if (conversationHistory.length > CONVERSATION_LOG_LIMIT) {
        conversationHistory.length = CONVERSATION_LOG_LIMIT;
    }
    console.log(`[CHAT ${level}] ${timestamp} | intent=${intent} | confidence=${confidence.toFixed(2)} | query="${query}"`);
}

function getConversationInsights() {
    const entries = conversationHistory.slice();
    const commonQueries = aggregateConversationEntries(entries, (item) => normalizeQuery(item.query));
    const commonIntents = aggregateConversationEntries(entries, (item) => item.intent || "unknown");
    const failedQueries = aggregateConversationEntries(
        entries.filter((item) => item.intent === "unknown" || item.confidence < 0.4),
        (item) => normalizeQuery(item.query)
    );
    const improvements = [];

    if (failedQueries.length) {
        improvements.push("Low-confidence queries ko phrase training me add karein.");
    }
    if (failedQueries.some((item) => /\b(reminder|whatsapp|message|broadcast)\b/i.test(item.label))) {
        improvements.push("WhatsApp broadcast aur offer ke extra Hinglish synonyms add karein.");
    }
    if (failedQueries.some((item) => /\b(rahul|student|naam)\b/i.test(item.label))) {
        improvements.push("Ambiguous student names ke liye phone-first fallback aur stronger disambiguation dikhayein.");
    }
    if (!improvements.length) {
        improvements.push("Recent chat quality stable hai. More admin examples add karke coverage aur badhaya ja sakta hai.");
    }

    return {
        totalQueries: entries.length,
        commonQueries: commonQueries.slice(0, 5),
        commonIntents: commonIntents.slice(0, 5),
        failedQueries: failedQueries.slice(0, 5),
        improvements: improvements.slice(0, 4)
    };
}

function aggregateConversationEntries(entries, getLabel) {
    const counts = new Map();

    (Array.isArray(entries) ? entries : []).forEach((entry) => {
        const label = normalizeMessage(getLabel(entry));
        if (!label) {
            return;
        }

        const current = counts.get(label) || {
            label,
            count: 0,
            lastSeen: entry.time || ""
        };
        current.count += 1;
        current.lastSeen = entry.time || current.lastSeen;
        counts.set(label, current);
    });

    return Array.from(counts.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

module.exports = {
    applyMemory,
    buildDataIndexes,
    buildSmartFallback,
    buildWhatsAppMessage,
    classifyEMIStatus,
    combineReplies,
    detectIntent,
    detectIntentWithConfidence,
    detectPhoneStrict,
    detectTopCount,
    extractEntities,
    getAgentStats,
    getBatchStats,
    getChatReply,
    getHighestPending,
    getHighestPendingStudent,
    getLowestPending,
    getPaidList,
    getPendingList,
    getConversationInsights,
    getStudentsByUpcomingEMI,
    getStudentByName,
    getStudentByPhone,
    getTopAgent,
    getTopBatch,
    getTopPendingStudents,
    handleChat,
    logQuery,
    normalizeQuery,
    predictNextEMIDate,
    resolveIntent,
    splitIntents,
    sessionMemory,
    validateData
};
