const express = require("express");

const {
    isWhatsAppReady,
    sendWhatsAppMessage,
    sendBulkWhatsApp
} = require("../services/whatsappService");

const router = express.Router();

router.post("/whatsapp/send", async (req, res) => {
    try {
        const { phone, message } = req.body || {};

        if (!isWhatsAppReady()) {
            res.status(503).json({ error: "WhatsApp not connected" });
            return;
        }

        const result = await sendWhatsAppMessage(phone, message, {
            type: "send_whatsapp_single"
        });

        if (!result.ok) {
            throw new Error(result.reason || "Unable to send WhatsApp message.");
        }

        res.json({
            success: true,
            result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/whatsapp/bulk", async (req, res) => {
    try {
        const { students, message } = req.body || {};

        if (!isWhatsAppReady()) {
            res.status(503).json({ error: "WhatsApp not connected" });
            return;
        }

        const result = await sendBulkWhatsApp(
            students,
            (student) => String(message || "")
                .replace(/\{name\}/g, String(student?.name || ""))
                .replace(/\{pending\}/g, String(student?.pending ?? ""))
                .replace(/\{batch\}/g, String(student?.batch || ""))
                .replace(/\{phone\}/g, String(student?.phone || "")),
            {
                type: "send_whatsapp_bulk",
                rateLimitMs: 800
            }
        );

        res.json({
            success: result.ok,
            ...result.summary,
            result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
