const express = require("express");
const {
    getDashboardPayload,
    getChatContextPayload
} = require("../services/sheetsService");
const {
    buildDataIndexes,
    getConversationInsights,
    getPendingList,
    getStudentsByUpcomingEMI
} = require("../services/chatService");
const { ensureWhatsAppConnection, getWhatsAppStatus } = require("../services/whatsappService");
const { isPendingPaymentStatus } = require("./paymentStatus");

const router = express.Router();

router.get("/dashboard", async (req, res) => {
    try {
        const payload = await getDashboardPayload({
            forceRefresh: req.query.refresh === "1"
        });
        await ensureWhatsAppConnection();
        const indexes = buildDataIndexes(payload.data, payload.batchStats, payload.agentStats);

        res.json({
            ...payload,
            students: buildStudentSummary(indexes, payload.data),
            emiAnalytics: buildEmiAnalytics(indexes),
            conversationInsights: getConversationInsights(),
            whatsapp: getWhatsAppStatus()
        });
    } catch (error) {
        console.error("Failed to build dashboard payload:", error);
        res.status(error.statusCode || 500).json({
            message: error.message || "Unable to load dashboard data."
        });
    }
});

router.get("/chat-context", async (req, res) => {
    try {
        const payload = await getChatContextPayload({
            forceRefresh: req.query.refresh === "1"
        });

        res.json(payload);
    } catch (error) {
        console.error("Failed to build chat context payload:", error);
        res.status(error.statusCode || 500).json({
            message: error.message || "Unable to load chatbot context."
        });
    }
});

function buildStudentSummary(indexes, records = []) {
    const students = Array.isArray(indexes?.students) && indexes.students.length
        ? indexes.students
        : buildFallbackStudentsFromRecords(records);

    return students
        .map((student) => ({
            key: student.key || `${student.phone || student.name}`,
            name: student.name || "",
            phone: student.phone || "",
            batch: student.batch || "",
            agent: student.agent || "",
            pending: Number(student.pending || 0),
            totalPaid: Number(student.totalPaid || 0),
            status: student.status || "",
            risk: student.riskLevel || "CLEAR",
            lastPaymentDate: student.lastPaymentDate || 0,
            joinedDate: student.joinedDate || student.firstDate || 0
        }))
        .sort((left, right) => right.pending - left.pending || left.name.localeCompare(right.name));
}

function buildFallbackStudentsFromRecords(records) {
    const map = new Map();

    (Array.isArray(records) ? records : []).forEach((record, index) => {
        const name = String(record?.name || "").trim();
        const phone = String(record?.phone || "").trim();
        const batch = String(record?.batch || "").trim();
        const agent = String(record?.agent || "").trim();
        const key = phone || name || `${batch}-${index}`;
        if (!key) {
            return;
        }

        const existing = map.get(key) || {
            key,
            name,
            phone,
            batch,
            agent,
            pending: 0,
            totalPaid: 0,
            status: String(record?.status || "").trim(),
            riskLevel: "CLEAR",
            lastPaymentDate: 0,
            joinedDate: 0
        };

        existing.name = name || existing.name;
        existing.phone = phone || existing.phone;
        existing.batch = batch || existing.batch;
        existing.agent = agent || existing.agent;
        existing.totalPaid += Number(record?.amount || 0);
        existing.pending = Math.max(existing.pending, Number(record?.pending || 0));
        existing.status = String(record?.status || "").trim() || existing.status;
        map.set(key, existing);
    });

    return Array.from(map.values());
}

function buildEmiAnalytics(indexes) {
    const pendingStudents = getPendingList(indexes);
    const riskStudents = pendingStudents.filter((student) => student.riskLevel === "HIGH").slice(0, 5);
    const defaulters = pendingStudents
        .filter((student) => isPendingPaymentStatus(student.status || "") || Number(student.pendingHistoryCount || 0) > 1)
        .slice(0, 5);
    const upcoming = getStudentsByUpcomingEMI(indexes, 5);

    return {
        highestPending: pendingStudents.slice(0, 5).map(mapAnalyticsStudent),
        defaulters: defaulters.map(mapAnalyticsStudent),
        upcoming: upcoming.map(mapAnalyticsStudent),
        riskStudents: riskStudents.map(mapAnalyticsStudent)
    };
}

function mapAnalyticsStudent(student) {
    return {
        name: student?.name || "",
        phone: student?.phone || "",
        batch: student?.batch || "",
        pending: Number(student?.pending || 0),
        status: student?.status || "",
        risk: student?.riskLevel || "CLEAR"
    };
}

module.exports = router;
