const express = require("express");
const { getChatReply } = require("../services/chatService");

const router = express.Router();

const MAX_CHAT_MESSAGE_LENGTH = 500;

router.post("/chat", async (req, res) => {
    try {
        const rawMessage = String(req.body?.message || "").trim();
        if (!rawMessage) {
            res.status(400).json({
                reply: "Please enter a message."
            });
            return;
        }

        if (rawMessage.length > MAX_CHAT_MESSAGE_LENGTH) {
            res.status(400).json({
                reply: "Query bahut lambi hai. Please 500 characters ke andar poochein."
            });
            return;
        }

        const memoryKey = getMemoryKey(req);
        const chatResult = await getChatReply(rawMessage, memoryKey);

        if (typeof chatResult === "string") {
            res.json({ reply: chatResult });
            return;
        }

        res.json({
            reply: String(chatResult?.reply || ""),
            table: Array.isArray(chatResult?.table) ? chatResult.table : [],
            meta: chatResult?.meta || {}
        });
    } catch (error) {
        console.error("Failed to process /api/chat:", error);
        res.status(500).json({
            reply: "Data available nahi hai ya system busy hai.",
            table: [],
            meta: {}
        });
    }
});

function getMemoryKey(req) {
    const sessionId = String(req.get("x-chat-session") || "").trim();
    if (sessionId) {
        return `session:${sessionId}`;
    }

    const forwardedFor = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
    const ip = forwardedFor || req.ip || "unknown-ip";
    const userAgent = String(req.get("user-agent") || "unknown-agent").slice(0, 120);
    return `client:${ip}:${userAgent}`;
}

module.exports = router;
