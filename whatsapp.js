const express = require("express");
const { getDashboardPayload } = require("../services/sheetsService");
const {
    buildDataIndexes,
    getStudentByName,
    getStudentByPhone
} = require("../services/chatService");
const {
    createCampaignDraft,
    ensureWhatsAppConnection,
    getWhatsAppLogs,
    getWhatsAppStatus,
    renderMessageTemplate,
    sendBulkWhatsApp,
    sendWhatsAppMessage
} = require("../services/whatsappService");

const router = express.Router();

router.get("/whatsapp/status", async (_req, res) => {
    await ensureWhatsAppConnection();
    res.json({
        ok: true,
        status: getWhatsAppStatus()
    });
});

router.get("/whatsapp/logs", (req, res) => {
    const limit = Number(req.query.limit || 50);
    res.json({
        ok: true,
        logs: getWhatsAppLogs(limit)
    });
});

router.post("/whatsapp/campaign/preview", async (req, res) => {
    try {
        const draft = await buildCampaignDraftFromRequest(req.body);
        if (!draft.count) {
            res.status(400).json({
                ok: false,
                message: "No valid recipients found for this audience.",
                draft
            });
            return;
        }

        res.json({
            ok: true,
            draft
        });
    } catch (error) {
        console.error("WhatsApp preview failed:", error);
        res.status(500).json({
            ok: false,
            message: error?.message || "Unable to preview WhatsApp campaign."
        });
    }
});

router.post("/whatsapp/campaign/send", async (req, res) => {
    try {
        if (req.body?.confirmed !== true) {
            res.status(400).json({
                ok: false,
                message: "Confirmation is required before sending WhatsApp messages."
            });
            return;
        }

        const draft = await buildCampaignDraftFromRequest(req.body);
        if (!draft.count) {
            res.status(400).json({
                ok: false,
                message: "No valid recipients found for this audience.",
                draft
            });
            return;
        }

        let result;

        if (draft.count === 1) {
            const student = draft.students[0];
            const message = renderMessageTemplate(student, draft.template);
            const single = await sendWhatsAppMessage(student.phone, message, {
                type: draft.type
            });
            result = {
                ok: single.ok,
                mode: single.mode,
                summary: {
                    total: 1,
                    successCount: single.ok ? 1 : 0,
                    failedCount: single.ok ? 0 : 1,
                    duplicateCount: single.status === "duplicate_skipped" ? 1 : 0,
                    invalidCount: single.status === "invalid_phone" ? 1 : 0
                },
                results: [single]
            };
        } else {
            result = await sendBulkWhatsApp(draft.students, draft.template, {
                type: draft.type,
                campaignId: draft.id
            });
        }

        res.json({
            ok: true,
            draft,
            result
        });
    } catch (error) {
        console.error("WhatsApp send failed:", error);
        res.status(500).json({
            ok: false,
            message: error?.message || "Unable to send WhatsApp campaign."
        });
    }
});

async function buildCampaignDraftFromRequest(body = {}) {
    const rawAudience = String(body.audience || body.audienceType || "").trim().toLowerCase();
    if (rawAudience === "batch" && !String(body.batch || "").trim()) {
        throw new Error("Please select a batch before sending a batch-specific campaign.");
    }

    if (rawAudience === "agent" && !String(body.agent || "").trim()) {
        throw new Error("Please select an agent before sending an agent-specific campaign.");
    }

    const dashboard = await getDashboardPayload({
        maxAgeMs: 20 * 1000
    });
    const indexes = buildDataIndexes(dashboard.data, dashboard.batchStats, dashboard.agentStats);
    const student = resolveStudentSelection(body, indexes);

    return createCampaignDraft({
        intent: String(body.intent || "").trim().toLowerCase() || (student ? "send_whatsapp_single" : "send_whatsapp_bulk"),
        audience: rawAudience,
        audienceType: String(body.audienceType || body.audience || "").trim().toLowerCase() || (student ? "single" : "pending"),
        batch: String(body.batch || "").trim(),
        agent: String(body.agent || "").trim(),
        customMessage: String(body.customMessage || "").trim(),
        messageType: String(body.messageType || "").trim().toLowerCase(),
        student,
        students: indexes.students
    });
}

function resolveStudentSelection(body, indexes) {
    const phone = String(body.phone || "").trim();
    const studentName = String(body.studentName || body.name || "").trim();

    if (phone) {
        return getStudentByPhone(phone, indexes);
    }

    if (studentName) {
        return getStudentByName(studentName, indexes)?.student || null;
    }

    return null;
}

module.exports = router;
