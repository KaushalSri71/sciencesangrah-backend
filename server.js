const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const dashboardRouter = require("./routes/dashboard");
const chatRouter = require("./routes/chat");
const whatsappCompatRouter = require("./routes/whatsappRoutes");
const whatsappRouter = require("./routes/whatsapp");
const { initWhatsApp } = require("./services/whatsappService");
const khazanaLibraryService = require("./services/khazanaLibraryService");
const dotenv = require("dotenv");

[
    path.join(__dirname, "..", "sciencesangrah-backend.env"),
    path.join(__dirname, ".env"),
    path.join(__dirname, "..", ".env")
].forEach((envPath) => {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
    }
});

const DEFAULT_ALLOWED_ORIGINS = [
    "https://sciencesangrah.live",
    "https://www.sciencesangrah.live"
];
const PORT = process.env.PORT || 8800;
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || DEFAULT_ALLOWED_ORIGINS[0]).replace(/\/+$/, "");
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const FIREBASE_PROJECT_ID = String(process.env.FIREBASE_PROJECT_ID || "science-sangrah-5067f").trim();
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
const ADMIN_ROLE_ALLOWLIST = new Set(["admin", "superadmin", "manager", "editor"]);
const ADMIN_AUTH_CACHE_TTL_MS = 10 * 60 * 1000;
const adminAuthorizationCache = new Map();

initializeFirebaseAdmin();

const firestore = admin.firestore();
const storageBucket = admin.storage().bucket();
const app = express();
let classConfigRefreshPromise = null;
const BOOK_FILE_RESOLUTION_CACHE_TTL_MS = 10 * 60 * 1000;
const bookFileResolutionCache = new Map();
const KHAZANA_METRICS_DOC_ID = "downloads";

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

app.get("/api/khazana/list", async (req, res) => {
    try {
        const requestedClass = normalizeClassLevel(req.query?.classLevel || req.query?.class);
        if (requestedClass) {
            const tree = await khazanaLibraryService.getLibraryTree(requestedClass);
            res.json({
                success: true,
                ...tree
            });
            return;
        }

        const tree = await khazanaLibraryService.getAllLibraries();
        res.json({
            success: true,
            ...tree
        });
    } catch (error) {
        console.error("Failed to load Khazana folder structure:", error);
        res.status(500).json({
            message: error?.message || "Unable to load the Khazana folders."
        });
    }
});

app.get("/api/khazana/library", async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.query?.classLevel);
        if (!classLevel) {
            res.status(400).json({ message: "Class level is required." });
            return;
        }

        const tree = await khazanaLibraryService.getLibraryTree(classLevel);
        res.json({
            success: true,
            ...tree
        });
    } catch (error) {
        console.error("Failed to load Khazana library tree:", error);
        res.status(500).json({
            message: error?.message || "Unable to load the Khazana library."
        });
    }
});

app.get("/api/khazana/library-cover", async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.query?.classLevel);
        const relativePath = String(req.query?.relativePath || "").trim();
        if (!classLevel || !relativePath) {
            res.status(400).json({ message: "Class level and cover path are required." });
            return;
        }

        const coverRecord = await khazanaLibraryService.getSubjectCoverRecord(classLevel, relativePath);
        if (!coverRecord?.file) {
            res.status(404).json({ message: "Subject cover was not found." });
            return;
        }

        const absoluteFilePath = await khazanaLibraryService.resolveAbsoluteFilePath(classLevel, relativePath);
        const stats = await fs.promises.stat(absoluteFilePath);
        res.setHeader("Content-Type", khazanaLibraryService.getMimeType(coverRecord.file.name));
        res.setHeader("Content-Length", String(Number(stats.size || 0)));
        res.setHeader("Cache-Control", "public, max-age=300");
        fs.createReadStream(absoluteFilePath)
            .on("error", (error) => {
                if (!res.headersSent) {
                    res.status(500).end("Unable to stream the requested subject cover.");
                    return;
                }
                res.destroy(error);
            })
            .pipe(res);
    } catch (error) {
        console.error("Failed to stream Khazana subject cover:", error);
        res.status(500).json({
            message: error?.message || "Unable to load the requested subject cover."
        });
    }
});

app.post("/api/khazana/upload", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const formData = await parseMultipartFormData(req);
        const classLevel = normalizeClassLevel(
            formData.get("classLevel")
            || formData.get("class")
            || formData.get("className")
        );
        const subject = String(formData.get("subject") || formData.get("folder") || "").trim();
        const subfolder = String(formData.get("subfolder") || "").trim();
        const files = await readFilesFromFormData(formData);

        if (!classLevel) {
            res.status(400).json({ message: "Class level is required." });
            return;
        }

        if (!subject) {
            res.status(400).json({ message: "Subject is required." });
            return;
        }

        if (!files.length) {
            res.status(400).json({ message: "Choose at least one file to upload." });
            return;
        }

        const uploaded = await khazanaLibraryService.uploadFiles({
            classLevel,
            subject,
            subfolder,
            files
        });

        res.json({
            success: true,
            ...uploaded
        });
    } catch (error) {
        console.error("Failed to upload Khazana files:", error);
        res.status(500).json({
            message: error?.message || "Unable to upload the requested files."
        });
    }
});

app.delete("/api/khazana/delete", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel || req.body?.class || req.query?.classLevel || req.query?.class);
        const filePath = String(req.body?.filePath || req.body?.relativePath || req.query?.filePath || req.query?.relativePath || "").trim();
        if (!filePath) {
            res.status(400).json({ message: "File path is required." });
            return;
        }

        const deleted = await khazanaLibraryService.deleteFileByAnyPath(filePath, classLevel);
        res.json({
            success: true,
            ...deleted
        });
    } catch (error) {
        console.error("Failed to delete Khazana file:", error);
        const statusCode = /does not exist|not found/i.test(String(error?.message || "")) ? 404 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to delete the requested file."
        });
    }
});

app.get("/api/admin/khazana/library/tree", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.query?.classLevel);
        if (!classLevel) {
            res.status(400).json({ message: "Class level is required." });
            return;
        }

        const tree = await khazanaLibraryService.getLibraryTree(classLevel);
        res.json({
            success: true,
            ...tree
        });
    } catch (error) {
        console.error("Failed to load admin Khazana library tree:", error);
        res.status(500).json({
            message: error?.message || "Unable to load the Khazana library."
        });
    }
});

app.post(
    "/api/admin/khazana/library/upload",
    verifyFirebaseUser,
    requireAdminUser,
    express.raw({ type: () => true, limit: "110mb" }),
    async (req, res) => {
        try {
            const classLevel = normalizeClassLevel(req.headers["x-class-level"]);
            const folderPath = decodeHeaderValue(req.headers["x-folder-path"]);
            const originalFileName = decodeHeaderValue(req.headers["x-file-name"]);
            const fileBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

            if (!classLevel) {
                res.status(400).json({ message: "Class level is required." });
                return;
            }

            if (!folderPath) {
                res.status(400).json({ message: "Folder path is required." });
                return;
            }

            if (!originalFileName) {
                res.status(400).json({ message: "File name is required." });
                return;
            }

            const uploaded = await khazanaLibraryService.uploadFile({
                classLevel,
                folderPath,
                fileName: originalFileName,
                fileBuffer
            });

            res.json({
                success: true,
                ...uploaded
            });
        } catch (error) {
            console.error("Failed to upload Khazana library file:", error);
            res.status(500).json({
                message: error?.message || "Unable to upload the requested file."
            });
        }
    }
);

app.post("/api/admin/khazana/library/folder/create", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const folderPath = String(req.body?.folderPath || "").trim();
        if (!classLevel || !folderPath) {
            res.status(400).json({ message: "Class level and folder path are required." });
            return;
        }

        const created = await khazanaLibraryService.createFolder({
            classLevel,
            folderPath
        });

        res.json({
            success: true,
            ...created
        });
    } catch (error) {
        console.error("Failed to create Khazana folder:", error);
        res.status(500).json({
            message: error?.message || "Unable to create the requested folder."
        });
    }
});

app.post("/api/admin/khazana/library/folder/rename", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const folderPath = String(req.body?.folderPath || "").trim();
        const nextName = String(req.body?.nextName || "").trim();
        const allowRoot = Boolean(req.body?.allowRoot);
        if (!classLevel || !folderPath || !nextName) {
            res.status(400).json({ message: "Class level, folder path, and next folder name are required." });
            return;
        }

        const renamed = await khazanaLibraryService.renameFolder({
            classLevel,
            folderPath,
            nextName,
            allowRoot
        });

        res.json({
            success: true,
            ...renamed
        });
    } catch (error) {
        console.error("Failed to rename Khazana folder:", error);
        const statusCode = /already exists|invalid|does not exist|not found/i.test(String(error?.message || "")) ? 400 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to rename the requested folder."
        });
    }
});

app.post("/api/admin/khazana/library/delete", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const relativePath = String(req.body?.relativePath || "").trim();
        if (!classLevel || !relativePath) {
            res.status(400).json({ message: "Class level and file path are required." });
            return;
        }

        const deleted = await khazanaLibraryService.deleteFile({
            classLevel,
            relativePath
        });

        res.json({
            success: true,
            ...deleted
        });
    } catch (error) {
        console.error("Failed to delete Khazana library file:", error);
        const statusCode = /does not exist|not found/i.test(String(error?.message || "")) ? 404 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to delete the requested file."
        });
    }
});

app.post("/api/admin/khazana/library/file/rename", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const relativePath = String(req.body?.relativePath || "").trim();
        const nextName = String(req.body?.nextName || "").trim();
        if (!classLevel || !relativePath || !nextName) {
            res.status(400).json({ message: "Class level, file path, and next file name are required." });
            return;
        }

        const renamed = await khazanaLibraryService.renameFile({
            classLevel,
            relativePath,
            nextName
        });

        res.json({
            success: true,
            ...renamed
        });
    } catch (error) {
        console.error("Failed to rename Khazana library file:", error);
        const statusCode = /already exists|invalid|does not exist|not found/i.test(String(error?.message || "")) ? 400 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to rename the requested file."
        });
    }
});

app.post("/api/admin/khazana/library/folder/delete", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const folderPath = String(req.body?.folderPath || "").trim();
        if (!classLevel || !folderPath) {
            res.status(400).json({ message: "Class level and folder path are required." });
            return;
        }

        const deleted = await khazanaLibraryService.deleteFolder({
            classLevel,
            folderPath
        });

        res.json({
            success: true,
            ...deleted
        });
    } catch (error) {
        console.error("Failed to delete Khazana folder:", error);
        const statusCode = /does not exist|not found/i.test(String(error?.message || "")) ? 404 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to delete the requested folder."
        });
    }
});

app.post("/api/admin/khazana/library/subject/delete", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const folderPath = String(req.body?.folderPath || "").trim();
        if (!classLevel || !folderPath) {
            res.status(400).json({ message: "Class level and subject path are required." });
            return;
        }

        const deleted = await khazanaLibraryService.deleteFolder({
            classLevel,
            folderPath,
            allowRoot: true
        });

        res.json({
            success: true,
            ...deleted
        });
    } catch (error) {
        console.error("Failed to delete Khazana subject:", error);
        const statusCode = /does not exist|not found/i.test(String(error?.message || "")) ? 404 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to delete the requested subject."
        });
    }
});

app.post("/api/admin/khazana/library/file-link", verifyFirebaseUser, requireAdminUser, async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const relativePath = String(req.body?.relativePath || "").trim();
        const requestedDisposition = String(req.body?.disposition || "inline").trim().toLowerCase();
        const disposition = requestedDisposition === "attachment" ? "attachment" : "inline";

        if (!classLevel || !relativePath) {
            res.status(400).json({ message: "Class level and file path are required." });
            return;
        }

        const fileRecord = await khazanaLibraryService.getFileRecord(classLevel, relativePath);
        if (!fileRecord?.file) {
            res.status(404).json({ message: "Requested Khazana file was not found." });
            return;
        }

        const token = createLibraryFileAccessToken({
            classLevel,
            relativePath: fileRecord.file.relativePath,
            fileName: fileRecord.file.name
        });

        res.json({
            success: true,
            classLevel,
            relativePath: fileRecord.file.relativePath,
            fileName: fileRecord.file.name,
            isFreePreview: Boolean(fileRecord.file.isFreePreview),
            url: buildLibraryFileUrl(req, token, disposition)
        });
    } catch (error) {
        console.error("Failed to create admin Khazana library file link:", error);
        const statusCode = /not found/i.test(String(error?.message || "")) ? 404 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to prepare the requested admin file link."
        });
    }
});

app.get("/api/admin/khazana/analytics", verifyFirebaseUser, requireAdminUser, async (_req, res) => {
    try {
        const analytics = await buildAdminKhazanaAnalyticsPayload();
        res.json({
            success: true,
            ...analytics
        });
    } catch (error) {
        console.error("Failed to load Khazana analytics:", error);
        res.status(500).json({
            message: error?.message || "Unable to load Khazana analytics."
        });
    }
});

app.post("/api/khazana/library/file-link", async (req, res) => {
    try {
        const classLevel = normalizeClassLevel(req.body?.classLevel);
        const relativePath = String(req.body?.relativePath || "").trim();
        const requestedDisposition = String(req.body?.disposition || "inline").trim().toLowerCase();
        const disposition = requestedDisposition === "attachment" ? "attachment" : "inline";

        if (!classLevel || !relativePath) {
            res.status(400).json({ message: "Class level and file path are required." });
            return;
        }

        const fileRecord = await khazanaLibraryService.getFileRecord(classLevel, relativePath);
        if (!fileRecord?.file) {
            res.status(404).json({ message: "Requested Khazana file was not found." });
            return;
        }

        const isFreePreview = Boolean(fileRecord.file.isFreePreview);
        let verifiedUser = null;

        try {
            verifiedUser = await readVerifiedFirebaseUserFromRequest(req);
        } catch (_) {
            verifiedUser = null;
        }

        if (!isFreePreview) {
            if (!verifiedUser) {
                res.status(403).json({ message: "Purchase is required to unlock this file." });
                return;
            }

            await refreshKhazanaClassConfig();
            const accessSummary = await ensureUserAccessForVerifiedUser(verifiedUser);
            const normalizedAccess = normalizeAccessSummary(accessSummary);
            if (!hasCompletedClassAccess(normalizedAccess[classLevel])) {
                res.status(403).json({ message: "Purchase is required to unlock this file." });
                return;
            }
        }

        const token = createLibraryFileAccessToken({
            classLevel,
            relativePath: fileRecord.file.relativePath,
            fileName: fileRecord.file.name
        });

        res.json({
            success: true,
            classLevel,
            relativePath: fileRecord.file.relativePath,
            fileName: fileRecord.file.name,
            isFreePreview,
            url: buildLibraryFileUrl(req, token, disposition)
        });
    } catch (error) {
        console.error("Failed to create Khazana library file link:", error);
        const statusCode = /purchase is required/i.test(String(error?.message || "")) ? 403 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to prepare the requested file."
        });
    }
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

app.post("/api/khazana/class-bundle-access", verifyFirebaseUser, async (req, res) => {
    try {
        await refreshKhazanaClassConfig();
        await ensureUserAccessForVerifiedUser(req.user);

        const classLevel = normalizeClassLevel(req.body?.classLevel);
        if (!classLevel) {
            res.status(400).json({ message: "Class bundle payload is incomplete." });
            return;
        }

        await assertPurchasedKhazanaClass(req.user.uid, classLevel);
        const bundleEntries = await buildKhazanaClassBundleEntries(req.user.uid, classLevel);
        if (!bundleEntries.entries.length) {
            res.status(404).json({ message: "No PDFs are available yet for this class bundle." });
            return;
        }

        const fileName = sanitizeDownloadFileName(`${classLevel} Khazana Notes Bundle.zip`);
        const token = createClassBundleAccessToken({
            uid: req.user.uid,
            classLevel,
            fileName
        });

        res.json({
            success: true,
            classLevel,
            fileName,
            entryCount: bundleEntries.entries.length,
            url: buildClassBundleUrl(req, token)
        });
    } catch (error) {
        console.error("Failed to create Khazana class bundle link:", error);
        const statusCode = /purchase|not purchased|not unlocked/i.test(String(error?.message || "")) ? 403 : 500;
        res.status(statusCode).json({
            message: error?.message || "Unable to prepare the class bundle."
        });
    }
});

app.post(
    "/api/admin/khazana/book-pdf",
    verifyFirebaseUser,
    requireAdminUser,
    express.raw({ type: "application/pdf", limit: "110mb" }),
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

            clearKhazanaBookResolutionCache(classLevel, bookId);

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

        clearKhazanaBookResolutionCacheByStoragePath(storagePath);
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

app.post("/api/admin/khazana/reconcile-payments", verifyFirebaseUser, requireAdminUser, async (_req, res) => {
    try {
        await refreshKhazanaClassConfig();
        const summary = await reconcilePendingPaidPaymentLinkAttempts({ limit: 50 });
        res.json({
            success: true,
            ...summary
        });
    } catch (error) {
        console.error("Failed to reconcile Khazana payment links:", error);
        res.status(500).json({
            message: error?.message || "Unable to reconcile Khazana payment links."
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

app.get("/api/khazana/class-bundle", async (req, res) => {
    try {
        const token = String(req.query?.token || "").trim();
        if (!token) {
            res.status(400).json({ message: "Missing class bundle token." });
            return;
        }

        const accessPayload = verifyClassBundleAccessToken(token);
        await streamKhazanaClassBundle(req, res, accessPayload);
    } catch (error) {
        const message = String(error?.message || "");
        const statusCode = /expired|invalid|tampered|token/i.test(message)
            ? 401
            : (/purchase|not found|missing|available/i.test(message) ? 404 : 500);
        console.error("Failed to stream Khazana class bundle:", error);
        res.status(statusCode).send(message || "Unable to stream the requested class bundle.");
    }
});

app.get("/api/khazana/library-file", async (req, res) => {
    try {
        const token = String(req.query?.token || "").trim();
        if (!token) {
            res.status(400).json({ message: "Missing library access token." });
            return;
        }

        const accessPayload = verifyLibraryFileAccessToken(token);
        await streamKhazanaLibraryFile(req, res, accessPayload);
    } catch (error) {
        const message = String(error?.message || "");
        const statusCode = /expired|invalid|tampered|token/i.test(message)
            ? 401
            : (/not found|missing|does not exist/i.test(message) ? 404 : 500);
        console.error("Failed to stream Khazana library file:", error);
        res.status(statusCode).send(message || "Unable to stream the requested file.");
    }
});

app.head("/api/khazana/library-file", async (req, res) => {
    try {
        const token = String(req.query?.token || "").trim();
        if (!token) {
            res.status(400).end();
            return;
        }

        const accessPayload = verifyLibraryFileAccessToken(token);
        await streamKhazanaLibraryFile(req, res, accessPayload, { headOnly: true });
    } catch (error) {
        const message = String(error?.message || "");
        const statusCode = /expired|invalid|tampered|token/i.test(message)
            ? 401
            : (/not found|missing|does not exist/i.test(message) ? 404 : 500);
        console.error("Failed to prepare Khazana library HEAD response:", error);
        res.status(statusCode).end();
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
    const projectId = FIREBASE_PROJECT_ID;

    const rawServiceAccount = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (rawServiceAccount) {
        const serviceAccount = parseFirebaseServiceAccount(rawServiceAccount);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: String(serviceAccount.project_id || projectId).trim() || projectId,
            storageBucket
        });
        return;
    }

    const localServiceAccountPath = path.join(__dirname, "serviceAccount.json");
    if (fs.existsSync(localServiceAccountPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(localServiceAccountPath, "utf8"));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: String(serviceAccount.project_id || projectId).trim() || projectId,
            storageBucket
        });
        console.log(`Firebase Admin initialized with local service account: ${localServiceAccountPath}`);
        return;
    }

    admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
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
        req.user = await readVerifiedFirebaseUserFromRequest(req);
        next();
    } catch (error) {
        console.error("Firebase auth verification failed:", error);
        res.status(401).json({ message: "Invalid Firebase ID token." });
    }
}

async function readVerifiedFirebaseUserFromRequest(req) {
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) {
        throw new Error("Missing Firebase ID token.");
    }

    return admin.auth().verifyIdToken(token);
}

async function requireAdminUser(req, res, next) {
    const authUid = resolveVerifiedUserUid(req.user);
    const authEmail = resolveVerifiedUserEmail(req.user);
    const tokenRole = normalizeAdminRole(
        req.user?.role
        || req.user?.adminRole
        || (req.user?.admin === true || req.user?.isAdmin === true ? "admin" : "")
    );

    if (isAllowedAdminRole(tokenRole)) {
        cacheAdminAuthorization({ uid: authUid, email: authEmail, role: tokenRole });
        req.adminRole = tokenRole;
        req.adminRoleSource = "token";
        next();
        return;
    }

    const cachedRole = readCachedAdminAuthorization({ uid: authUid, email: authEmail });
    if (cachedRole) {
        req.adminRole = cachedRole;
        req.adminRoleSource = "cache";
        next();
        return;
    }

    try {
        let adminData = null;

        if (authUid) {
            const adminSnapshot = await firestore.collection("admins").doc(authUid).get();
            if (adminSnapshot.exists) {
                adminData = adminSnapshot.data() || {};
            }
        }

        if (!adminData && authEmail) {
            const adminQuerySnapshot = await firestore.collection("admins")
                .where("email", "==", authEmail)
                .limit(1)
                .get();
            if (!adminQuerySnapshot.empty) {
                adminData = adminQuerySnapshot.docs[0].data() || {};
            }
        }

        const role = normalizeAdminRole(adminData?.role);
        if (!isAllowedAdminRole(role)) {
            res.status(403).json({ message: "Admin access is required for this action." });
            return;
        }

        cacheAdminAuthorization({ uid: authUid, email: authEmail, role });
        req.adminRole = role;
        req.adminRoleSource = authUid ? "firestore-uid" : "firestore-email";
        next();
    } catch (error) {
        console.error("Admin authorization failed:", error);
        const localFallbackRole = readLocalDevAdminFallbackRole(req, { uid: authUid, email: authEmail });
        if (localFallbackRole) {
            cacheAdminAuthorization({ uid: authUid, email: authEmail, role: localFallbackRole });
            req.adminRole = localFallbackRole;
            req.adminRoleSource = "localhost-header";
            next();
            return;
        }
        res.status(500).json({ message: "Unable to verify admin access." });
    }
}

function normalizeAdminRole(value) {
    return String(value || "").trim().toLowerCase();
}

function isAllowedAdminRole(value) {
    return ADMIN_ROLE_ALLOWLIST.has(normalizeAdminRole(value));
}

function resolveVerifiedUserUid(user) {
    return String(user?.uid || user?.user_id || user?.sub || "").trim();
}

function resolveVerifiedUserEmail(user) {
    return String(user?.email || "").trim().toLowerCase();
}

function getAdminAuthorizationCacheKeys({ uid = "", email = "" } = {}) {
    const keys = [];
    const normalizedUid = String(uid || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (normalizedUid) {
        keys.push(`uid:${normalizedUid}`);
    }
    if (normalizedEmail) {
        keys.push(`email:${normalizedEmail}`);
    }
    return keys;
}

function readCachedAdminAuthorization(identity = {}) {
    const keys = getAdminAuthorizationCacheKeys(identity);
    const now = Date.now();

    for (const key of keys) {
        const cached = adminAuthorizationCache.get(key);
        if (!cached) {
            continue;
        }

        if (cached.expiresAt <= now || !isAllowedAdminRole(cached.role)) {
            adminAuthorizationCache.delete(key);
            continue;
        }

        return cached.role;
    }

    return "";
}

function cacheAdminAuthorization({ uid = "", email = "", role = "" } = {}) {
    const normalizedRole = normalizeAdminRole(role);
    if (!isAllowedAdminRole(normalizedRole)) {
        return;
    }

    const entry = {
        role: normalizedRole,
        expiresAt: Date.now() + ADMIN_AUTH_CACHE_TTL_MS
    };

    getAdminAuthorizationCacheKeys({ uid, email }).forEach((key) => {
        adminAuthorizationCache.set(key, entry);
    });
}

function isLoopbackRequest(req) {
    const hostCandidates = [
        req.hostname,
        req.ip,
        req.socket?.remoteAddress
    ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);

    const loopbackValues = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
    if (hostCandidates.some((value) => loopbackValues.has(value))) {
        return true;
    }

    const originHeader = String(req.headers.origin || "").trim();
    if (!originHeader) {
        return false;
    }

    try {
        const originUrl = new URL(originHeader);
        return loopbackValues.has(String(originUrl.hostname || "").trim().toLowerCase());
    } catch (_) {
        return false;
    }
}

function readLocalDevAdminFallbackRole(req, identity = {}) {
    if (!isLoopbackRequest(req)) {
        return "";
    }

    const headerRole = normalizeAdminRole(req.headers["x-admin-role"]);
    if (!isAllowedAdminRole(headerRole)) {
        return "";
    }

    const headerUid = String(req.headers["x-admin-uid"] || "").trim();
    const headerEmail = String(req.headers["x-admin-email"] || "").trim().toLowerCase();

    if (identity.uid && headerUid && identity.uid !== headerUid) {
        return "";
    }

    if (identity.email && headerEmail && identity.email !== headerEmail) {
        return "";
    }

    return headerRole;
}

function requireRazorpayCredentials() {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        throw new Error("Razorpay credentials are missing. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    }
}

function normalizeClassLevel(value) {
    const raw = String(value || "").trim();
    const compact = raw.toLowerCase().replace(/\s+/g, "");
    if (["10", "10th", "class10", "class10th", "10thclass", "classx", "x", "std10"].includes(compact)) return "10th";
    if (["12", "12th", "class12", "class12th", "12thclass", "classxii", "xii", "std12"].includes(compact)) return "12th";
    return "";
}

async function parseMultipartFormData(req) {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.includes("multipart/form-data")) {
        throw new Error("Upload request must use multipart form data.");
    }

    const request = new Request(`http://localhost${req.originalUrl || req.url || "/"}`, {
        method: req.method || "POST",
        headers: req.headers,
        body: req,
        duplex: "half"
    });

    return request.formData();
}

function isFormDataFile(value) {
    return Boolean(value)
        && typeof value === "object"
        && typeof value.name === "string"
        && typeof value.arrayBuffer === "function";
}

async function readFilesFromFormData(formData) {
    const files = [];

    for (const [, value] of formData.entries()) {
        if (!isFormDataFile(value)) {
            continue;
        }

        files.push({
            name: String(value.name || "file").trim() || "file",
            type: String(value.type || "").trim(),
            buffer: Buffer.from(await value.arrayBuffer())
        });
    }

    return files;
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
            const parsed = parseFirebaseServiceAccount(rawServiceAccount);
            if (parsed?.project_id) {
                return `${String(parsed.project_id).trim()}.firebasestorage.app`;
            }
        } catch (_) {
        }
    }

    return "science-sangrah-5067f.firebasestorage.app";
}

function parseFirebaseServiceAccount(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is empty.");
    }

    const unquoted = (
        (raw.startsWith('"') && raw.endsWith('"'))
        || (raw.startsWith("'") && raw.endsWith("'"))
    )
        ? raw.slice(1, -1)
        : raw;

    const candidates = [
        raw,
        unquoted,
        raw.replace(/\\"/g, '"').replace(/\\\r?\n/g, "\\n"),
        unquoted.replace(/\\"/g, '"').replace(/\\\r?\n/g, "\\n")
    ];

    for (const candidate of candidates) {
        try {
            let parsed = JSON.parse(candidate);
            if (typeof parsed === "string") {
                parsed = JSON.parse(parsed);
            }

            if (parsed && typeof parsed === "object") {
                if (typeof parsed.private_key === "string") {
                    parsed.private_key = parsed.private_key.replace(/\r\n/g, "\n").replace(/\\n/g, "\n");
                }
                return parsed;
            }
        } catch (_) {
        }
    }

    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON could not be parsed. Check the JSON formatting in sciencesangrah-backend.env.");
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
        .filter(([, value]) => hasCompletedClassAccess(value))
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

    const cached = readKhazanaBookResolutionCache(classLevel, bookId);
    if (cached) {
        return cached;
    }

    const bookConfig = await getKhazanaBookDefinition(classLevel, bookId);
    if (!bookConfig) {
        const legacyResource = await resolveLegacyKhazanaResource(classLevel, {
            id: bookId,
            name: inferSubjectLabelFromBookId(bookId),
            titleLabel: inferSubjectLabelFromBookId(bookId),
            subjectKey: inferSubjectLabelFromBookId(bookId)
        });
        if (legacyResource?.storagePath) {
            writeKhazanaBookResolutionCache(classLevel, bookId, legacyResource);
            return legacyResource;
        }

        const fallbackStoredBook = await resolveStoredKhazanaBookFileByPrefix(classLevel, bookId);
        if (fallbackStoredBook) {
            writeKhazanaBookResolutionCache(classLevel, bookId, fallbackStoredBook);
            return fallbackStoredBook;
        }

        const fallbackLegacyStoredBook = await resolveStoredKhazanaBookFileByLegacyPrefixes(classLevel, {
            id: bookId,
            name: inferSubjectLabelFromBookId(bookId),
            titleLabel: inferSubjectLabelFromBookId(bookId),
            subjectKey: inferSubjectLabelFromBookId(bookId)
        });
        if (fallbackLegacyStoredBook) {
            writeKhazanaBookResolutionCache(classLevel, bookId, fallbackLegacyStoredBook);
            return fallbackLegacyStoredBook;
        }

        throw new Error("Requested Khazana book is not configured.");
    }

    const directStoragePath = extractStoragePathFromKhazanaBook(bookConfig);
    if (directStoragePath) {
        const resolved = {
            storagePath: directStoragePath,
            fileName: buildKhazanaBookFileName(classLevel, bookConfig)
        };
        writeKhazanaBookResolutionCache(classLevel, bookId, resolved);
        return resolved;
    }

    const legacyResource = await resolveLegacyKhazanaResource(classLevel, bookConfig);
    if (legacyResource?.storagePath) {
        const resolved = {
            storagePath: legacyResource.storagePath,
            fileName: legacyResource.fileName || buildKhazanaBookFileName(classLevel, bookConfig)
        };
        writeKhazanaBookResolutionCache(classLevel, bookId, resolved);
        void persistKhazanaBookStorageMapping(classLevel, bookId, resolved).catch((error) => {
            console.warn(`Unable to persist recovered Khazana mapping for ${classLevel}/${bookId}:`, error?.message || error);
        });
        return resolved;
    }

    const storedBook = await resolveStoredKhazanaBookFileByPrefix(classLevel, bookId);
    if (storedBook) {
        writeKhazanaBookResolutionCache(classLevel, bookId, storedBook);
        void persistKhazanaBookStorageMapping(classLevel, bookId, storedBook).catch((error) => {
            console.warn(`Unable to persist recovered Khazana mapping for ${classLevel}/${bookId}:`, error?.message || error);
        });
        return storedBook;
    }

    const classFolderBook = await resolveStoredKhazanaBookFileByClassFolder(classLevel, bookConfig);
    if (classFolderBook) {
        writeKhazanaBookResolutionCache(classLevel, bookId, classFolderBook);
        void persistKhazanaBookStorageMapping(classLevel, bookId, classFolderBook).catch((error) => {
            console.warn(`Unable to persist recovered Khazana mapping for ${classLevel}/${bookId}:`, error?.message || error);
        });
        return classFolderBook;
    }

    const legacyStoredBook = await resolveStoredKhazanaBookFileByLegacyPrefixes(classLevel, bookConfig);
    if (legacyStoredBook) {
        writeKhazanaBookResolutionCache(classLevel, bookId, legacyStoredBook);
        void persistKhazanaBookStorageMapping(classLevel, bookId, legacyStoredBook).catch((error) => {
            console.warn(`Unable to persist recovered Khazana mapping for ${classLevel}/${bookId}:`, error?.message || error);
        });
        return legacyStoredBook;
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

async function resolveStoredKhazanaBookFileByPrefix(classLevel, bookId) {
    const prefix = `paid-notes/${classLevel}/${bookId}/`;

    try {
        const [files] = await storageBucket.getFiles({ prefix });
        const pdfFiles = files
            .filter((file) => String(file?.name || "").trim().toLowerCase().endsWith(".pdf"))
            .sort((left, right) => String(right.name || "").localeCompare(String(left.name || "")));

        const latestFile = pdfFiles[0];
        if (!latestFile?.name) {
            return null;
        }

        return {
            storagePath: String(latestFile.name || "").trim(),
            fileName: sanitizeDownloadFileName(path.basename(String(latestFile.name || "").trim()))
        };
    } catch (error) {
        console.warn(`Unable to scan Khazana storage fallback for ${classLevel}/${bookId}:`, error?.message || error);
        return null;
    }
}

async function resolveStoredKhazanaBookFileByClassFolder(classLevel, bookConfig = {}) {
    const prefix = `paid-notes/${classLevel}/`;
    const subjectCandidates = buildKhazanaSubjectCandidates(bookConfig);

    if (!subjectCandidates.size) {
        return null;
    }

    try {
        const [files] = await storageBucket.getFiles({ prefix });
        const pdfFiles = files.filter((file) => {
            const name = String(file?.name || "").trim().toLowerCase();
            return name.endsWith(".pdf");
        });

        const matches = pdfFiles
            .map((file) => ({
                file,
                name: String(file?.name || "").trim(),
                updatedAt: getMillis(file?.metadata?.updated || file?.metadata?.timeCreated || 0)
            }))
            .filter(({ name }) => {
                const normalized = normalizeSubjectLookupKey(name);
                if (!normalized) return false;

                for (const candidate of subjectCandidates) {
                    if (!candidate) continue;
                    if (normalized.includes(candidate) || candidate.includes(normalized)) {
                        return true;
                    }
                }

                return false;
            })
            .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

        const latestMatch = matches[0];
        if (!latestMatch?.name) {
            return null;
        }

        return {
            storagePath: latestMatch.name,
            fileName: sanitizeDownloadFileName(path.basename(latestMatch.name))
        };
    } catch (error) {
        console.warn(`Unable to scan class-folder Khazana storage fallback for ${classLevel}:`, error?.message || error);
        return null;
    }
}

async function resolveStoredKhazanaBookFileByLegacyPrefixes(classLevel, bookConfig = {}) {
    const subjectCandidates = buildKhazanaSubjectCandidates(bookConfig);
    const prefixes = buildLegacyStoragePrefixes(classLevel, bookConfig);

    if (!subjectCandidates.size || !prefixes.length) {
        return null;
    }

    for (const prefix of prefixes) {
        try {
            const [files] = await storageBucket.getFiles({ prefix });
            const match = pickBestMatchingStoredPdf(files, classLevel, bookConfig, subjectCandidates);
            if (match) {
                return match;
            }
        } catch (error) {
            console.warn(`Unable to scan legacy Khazana storage prefix ${prefix}:`, error?.message || error);
        }
    }

    return null;
}

function extractStoragePathFromKhazanaBook(book = {}) {
    const configuredPath = firstNonEmptyValue(
        book.storagePath,
        book.filePath,
        book.pdfPath,
        book.pdfStoragePath,
        book.path
    );
    if (configuredPath) {
        return configuredPath;
    }

    return extractStoragePathFromFileUrl(
        firstNonEmptyValue(book.fileUrl, book.url, book.downloadUrl, book.pdfUrl)
    );
}

async function resolveLegacyKhazanaResource(classLevel, bookConfig = {}) {
    const subjectCandidates = buildKhazanaSubjectCandidates(bookConfig);

    if (!subjectCandidates.size) {
        return null;
    }

    const snapshot = await firestore.collection("resources").get();
    const matches = [];

    for (const docSnapshot of snapshot.docs) {
        const resource = docSnapshot.data() || {};
        const relevanceScore = getLegacyKhazanaResourceScore(resource);
        if (relevanceScore <= 0) {
            continue;
        }

        if (resolveKhazanaResourceClassLevel(resource) !== classLevel) {
            continue;
        }

        if (!doesResourceMatchKhazanaSubject(resource, subjectCandidates)) {
            continue;
        }

        const storagePath = firstNonEmptyValue(
            resource.storagePath,
            resource.filePath,
            resource.pdfPath,
            resource.pdfStoragePath,
            resource.downloadPath,
            resource.path
        ) || extractStoragePathFromFileUrl(
            firstNonEmptyValue(resource.fileUrl, resource.url, resource.downloadUrl, resource.pdfUrl, resource.link)
        );
        if (!storagePath) {
            continue;
        }

        matches.push({
            storagePath,
            fileName: firstNonEmptyValue(resource.fileName, resource.name, resource.title),
            score: relevanceScore,
            updatedAt: getMillis(resource.updatedAt || resource.updated_at || resource.createdAt || resource.timestamp)
        });
    }

    matches.sort((left, right) => {
        if (Number(right.score || 0) !== Number(left.score || 0)) {
            return Number(right.score || 0) - Number(left.score || 0);
        }

        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });

    if (matches[0]) {
        return {
            storagePath: matches[0].storagePath,
            fileName: matches[0].fileName
        };
    }

    return null;
}

function buildKhazanaSubjectCandidates(bookConfig = {}) {
    const rawValues = [
        bookConfig.subjectKey,
        bookConfig.name,
        bookConfig.titleLabel,
        bookConfig.id,
        inferSubjectLabelFromBookId(bookConfig.id)
    ];

    const normalizedValues = new Set(
        rawValues
            .map((value) => normalizeSubjectLookupKey(value))
            .filter(Boolean)
    );

    const expanded = new Set();
    normalizedValues.forEach((value) => {
        expanded.add(value);
        getSubjectAliases(value).forEach((alias) => expanded.add(alias));
    });

    return expanded;
}

function doesResourceMatchKhazanaSubject(resource = {}, subjectCandidates = new Set()) {
    const directValues = [
        resource.subject,
        resource.title,
        resource.name,
        resource.fileName,
        resource.storagePath,
        resource.filePath,
        resource.downloadPath,
        resource.fileUrl,
        resource.url,
        resource.link
    ];

    const normalizedValues = new Set();
    directValues.forEach((value) => {
        const normalized = normalizeSubjectLookupKey(value);
        if (normalized) {
            normalizedValues.add(normalized);
            getSubjectAliases(normalized).forEach((alias) => normalizedValues.add(alias));
        }
    });

    for (const candidate of subjectCandidates) {
        if (!candidate) continue;
        if (normalizedValues.has(candidate)) {
            return true;
        }

        for (const value of normalizedValues) {
            if (value.includes(candidate) || candidate.includes(value)) {
                return true;
            }
        }
    }

    return false;
}

function inferSubjectLabelFromBookId(bookId) {
    const raw = String(bookId || "").trim().toLowerCase();
    if (!raw) {
        return "";
    }

    const parts = raw.split("-").filter(Boolean);
    if (parts.length >= 2) {
        return parts.slice(1).join(" ");
    }

    return raw;
}

function getSubjectAliases(value) {
    const normalized = normalizeSubjectLookupKey(value);
    if (!normalized) {
        return [];
    }

    const aliasMap = {
        HINDI: ["HINDI", "HIN"],
        ENGLISH: ["ENGLISH", "ENG"],
        MATHS: ["MATHS", "MATH", "MATHEMATICS"],
        MATHEMATICS: ["MATHS", "MATH", "MATHEMATICS"],
        SCIENCE: ["SCIENCE", "SCIE"],
        SCIE: ["SCIENCE", "SCIE"],
        SST: ["SST", "SOCIALSCIENCE", "SOCIALSTUDIES", "SOCIAL"],
        SOCIALSCIENCE: ["SST", "SOCIALSCIENCE", "SOCIALSTUDIES", "SOCIAL"],
        SOCIALSTUDIES: ["SST", "SOCIALSCIENCE", "SOCIALSTUDIES", "SOCIAL"],
        SOCIAL: ["SST", "SOCIALSCIENCE", "SOCIALSTUDIES", "SOCIAL"],
        PHYSICS: ["PHYSICS", "PHY"],
        PHY: ["PHYSICS", "PHY"],
        CHEMISTRY: ["CHEMISTRY", "CHEM"],
        CHEM: ["CHEMISTRY", "CHEM"],
        BIOLOGY: ["BIOLOGY", "BIO"],
        BIO: ["BIOLOGY", "BIO"]
    };

    return aliasMap[normalized] || [normalized];
}

function resolveKhazanaResourceClassLevel(resource = {}) {
    return normalizeClassLevel(
        firstNonEmptyValue(
            resource.classLevel,
            resource.class,
            resource.standard,
            resource.className,
            resource.class_name
        )
    );
}

function getLegacyKhazanaResourceScore(resource = {}) {
    const resourceType = String(resource.resourceType || resource.type || "").trim().toLowerCase();
    if (!resourceType) {
        return 4;
    }

    if (["notes", "topper"].includes(resourceType)) {
        return 7;
    }

    if (["ncert", "book", "pdf", "ebook"].includes(resourceType)) {
        return 5;
    }

    return 0;
}

function getClassLevelAliases(classLevel) {
    const normalized = normalizeClassLevel(classLevel);
    if (normalized === "10th") return ["10th", "10"];
    if (normalized === "12th") return ["12th", "12"];
    return normalized ? [normalized] : [];
}

function buildLegacyStoragePrefixes(classLevel, bookConfig = {}) {
    const classAliases = getClassLevelAliases(classLevel);
    const subjectStem = inferSubjectLabelFromBookId(bookConfig.id);
    const rawSubjectValues = [
        subjectStem,
        bookConfig.subjectKey,
        bookConfig.name,
        bookConfig.titleLabel
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase().replace(/\s+/g, "-"));

    const prefixes = new Set();
    classAliases.forEach((alias) => {
        prefixes.add(`paid-notes/${alias}/`);
        prefixes.add(`resources/khazana-pdfs/${alias}/`);
        prefixes.add(`resources/${alias}/`);
    });

    rawSubjectValues.forEach((value) => {
        if (!value) return;
        prefixes.add(`paid-notes/${value}/`);
        classAliases.forEach((alias) => {
            prefixes.add(`paid-notes/${alias}/${value}/`);
            prefixes.add(`resources/khazana-pdfs/${alias}/${value}/`);
        });
        prefixes.add(`resources/khazana-pdfs/${value}/`);
    });

    prefixes.add("paid-notes/");
    prefixes.add("resources/khazana-pdfs/");
    prefixes.add("resources/");
    return Array.from(prefixes);
}

function pickBestMatchingStoredPdf(files = [], classLevel, bookConfig = {}, subjectCandidates = new Set()) {
    const classCandidates = new Set(
        getClassLevelAliases(classLevel).map((value) => normalizeSubjectLookupKey(value)).filter(Boolean)
    );
    const bookIdCandidate = normalizeSubjectLookupKey(bookConfig.id);

    const matches = (Array.isArray(files) ? files : [])
        .map((file) => {
            const name = String(file?.name || "").trim();
            const normalizedName = normalizeSubjectLookupKey(name);
            const updatedAt = getMillis(file?.metadata?.updated || file?.metadata?.timeCreated || 0);
            if (!name || !/\.pdf$/i.test(name) || !normalizedName) {
                return null;
            }

            let score = 0;

            if (bookIdCandidate && normalizedName.includes(bookIdCandidate)) {
                score += 8;
            }

            for (const candidate of classCandidates) {
                if (candidate && normalizedName.includes(candidate)) {
                    score += 3;
                    break;
                }
            }

            for (const candidate of subjectCandidates) {
                if (!candidate) continue;
                if (normalizedName.includes(candidate)) {
                    score += 5;
                } else if (candidate.includes(normalizedName) || normalizedName.includes(candidate.slice(0, Math.max(3, candidate.length - 2)))) {
                    score += 2;
                }
            }

            return score > 0
                ? {
                    storagePath: name,
                    fileName: sanitizeDownloadFileName(path.basename(name)),
                    score,
                    updatedAt
                }
                : null;
        })
        .filter(Boolean)
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
        });

    return matches[0] ? {
        storagePath: matches[0].storagePath,
        fileName: matches[0].fileName
    } : null;
}

function buildKhazanaBookResolutionCacheKey(classLevel, bookId) {
    return `${normalizeClassLevel(classLevel)}::${String(bookId || "").trim()}`;
}

async function persistKhazanaBookStorageMapping(classLevel, bookId, resolvedBook = {}) {
    const normalizedClass = normalizeClassLevel(classLevel);
    const normalizedBookId = String(bookId || "").trim();
    const storagePath = String(resolvedBook?.storagePath || "").trim();
    const fileName = String(resolvedBook?.fileName || "").trim();

    if (!normalizedClass || !normalizedBookId || !storagePath) {
        return;
    }

    const configRef = firestore.collection("khazana_config").doc("main");
    await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(configRef);
        if (!snapshot.exists) {
            return;
        }

        const config = snapshot.data() || {};
        const classConfig = config.classes?.[normalizedClass];
        const books = Array.isArray(classConfig?.books) ? classConfig.books.slice() : [];
        const index = books.findIndex((book) => String(book?.id || "").trim() === normalizedBookId);
        if (index < 0) {
            return;
        }

        const currentBook = books[index] || {};
        const currentPath = extractStoragePathFromKhazanaBook(currentBook);
        const currentFileName = String(currentBook.fileName || "").trim();
        if (currentPath === storagePath && (!fileName || currentFileName === fileName)) {
            return;
        }

        books[index] = {
            ...currentBook,
            storagePath,
            fileName: fileName || currentFileName
        };

        transaction.set(configRef, {
            classes: {
                [normalizedClass]: {
                    books
                }
            }
        }, { merge: true });
    });
}

function readKhazanaBookResolutionCache(classLevel, bookId) {
    const key = buildKhazanaBookResolutionCacheKey(classLevel, bookId);
    const entry = bookFileResolutionCache.get(key);
    if (!entry || typeof entry !== "object") {
        return null;
    }

    if (!Number.isFinite(Number(entry.exp)) || Number(entry.exp) <= Date.now()) {
        bookFileResolutionCache.delete(key);
        return null;
    }

    return {
        storagePath: String(entry.storagePath || "").trim(),
        fileName: String(entry.fileName || "").trim()
    };
}

function writeKhazanaBookResolutionCache(classLevel, bookId, resolvedBook = {}) {
    const key = buildKhazanaBookResolutionCacheKey(classLevel, bookId);
    const storagePath = String(resolvedBook?.storagePath || "").trim();
    if (!key.trim() || !storagePath) {
        return;
    }

    bookFileResolutionCache.set(key, {
        storagePath,
        fileName: String(resolvedBook?.fileName || "").trim(),
        exp: Date.now() + BOOK_FILE_RESOLUTION_CACHE_TTL_MS
    });
}

function clearKhazanaBookResolutionCache(classLevel, bookId) {
    const key = buildKhazanaBookResolutionCacheKey(classLevel, bookId);
    if (!key.trim()) return;
    bookFileResolutionCache.delete(key);
}

function clearKhazanaBookResolutionCacheByStoragePath(storagePath) {
    const normalized = String(storagePath || "").trim();
    const match = /^paid-notes\/(10th|12th|10|12)\/([^/]+)\//i.exec(normalized);
    if (!match) {
        return;
    }

    const classLevel = normalizeClassLevel(match[1]);
    const bookId = String(match[2] || "").trim();
    if (classLevel && bookId) {
        clearKhazanaBookResolutionCache(classLevel, bookId);
    }
}

function firstNonEmptyValue(...values) {
    for (const value of values) {
        const normalized = String(value || "").trim();
        if (normalized) {
            return normalized;
        }
    }

    return "";
}

function extractStoragePathFromFileUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    if (/^gs:\/\//i.test(raw)) {
        return raw.replace(/^gs:\/\/[^/]+\//i, "").trim();
    }

    try {
        const url = new URL(raw);
        const objectPath = url.pathname.split("/o/")[1]
            || String(url.searchParams.get("name") || "").trim();
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

function sanitizeArchiveSegment(value, fallback = "Item") {
    const normalized = sanitizeDownloadFileName(String(value || "").trim() || fallback);
    return normalized.replace(/\.+$/g, "").trim() || fallback;
}

function sanitizeArchiveRelativePath(value, fallbackFileName = "notes.pdf") {
    const raw = String(value || "").replace(/\\/g, "/");
    const parts = raw
        .split("/")
        .map((segment) => sanitizeArchiveSegment(segment, "Item"))
        .filter(Boolean);

    if (!parts.length) {
        return sanitizeArchiveSegment(fallbackFileName, "notes.pdf");
    }

    return parts.join("/");
}

function collectKhazanaLibraryFiles(folderNode, target = []) {
    if (!folderNode || typeof folderNode !== "object") {
        return target;
    }

    (folderNode.files || []).forEach((file) => {
        if (String(file?.extension || "").trim().toLowerCase() === "pdf") {
            target.push(file);
        }
    });

    (folderNode.folders || []).forEach((folder) => {
        collectKhazanaLibraryFiles(folder, target);
    });

    return target;
}

async function getKhazanaClassBookConfigs(classLevel) {
    const snapshot = await firestore.collection("khazana_config").doc("main").get();
    if (!snapshot.exists) {
        return [];
    }

    const books = snapshot.data()?.classes?.[classLevel]?.books;
    return Array.isArray(books) ? books.filter((book) => book && typeof book === "object") : [];
}

function doesKhazanaSubjectMatchBook(subject = {}, bookConfig = {}) {
    const candidates = buildKhazanaSubjectCandidates(bookConfig);
    if (!candidates.size) {
        return false;
    }

    const subjectKeys = [
        normalizeSubjectLookupKey(subject.name || ""),
        normalizeSubjectLookupKey(subject.relativePath || "")
    ].filter(Boolean);

    return subjectKeys.some((subjectKey) => {
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (subjectKey === candidate || subjectKey.includes(candidate) || candidate.includes(subjectKey)) {
                return true;
            }
        }
        return false;
    });
}

function orderKhazanaBundleSubjects(tree = {}, bookConfigs = []) {
    const subjects = Array.isArray(tree.subjects) ? tree.subjects.slice() : [];
    const ordered = [];
    const usedSubjectPaths = new Set();

    bookConfigs.forEach((bookConfig) => {
        const matchedSubject = subjects.find((subject) => {
            const subjectPath = String(subject?.relativePath || "").trim();
            return subjectPath && !usedSubjectPaths.has(subjectPath) && doesKhazanaSubjectMatchBook(subject, bookConfig);
        });

        if (!matchedSubject) {
            return;
        }

        usedSubjectPaths.add(String(matchedSubject.relativePath || "").trim());
        ordered.push({
            subject: matchedSubject,
            bookConfig
        });
    });

    subjects.forEach((subject) => {
        const subjectPath = String(subject?.relativePath || "").trim();
        if (!subjectPath || usedSubjectPaths.has(subjectPath)) {
            return;
        }

        ordered.push({
            subject,
            bookConfig: null
        });
    });

    return ordered;
}

function buildKhazanaBundleRootFolderName(classLevel) {
    return sanitizeArchiveSegment(`${classLevel} Khazana Notes`, `${classLevel} Khazana Notes`);
}

function buildKhazanaBundleSubjectFolderName(index, subjectName) {
    return `${String(index).padStart(2, "0")}_${sanitizeArchiveSegment(subjectName, "Subject")}`;
}

async function buildKhazanaClassBundleEntries(uid, classLevel) {
    const normalizedClass = normalizeClassLevel(classLevel);
    if (!normalizedClass) {
        throw new Error("Invalid class level.");
    }

    const tree = await khazanaLibraryService.getLibraryTree(normalizedClass);
    const bookConfigs = await getKhazanaClassBookConfigs(normalizedClass);
    const orderedSubjects = orderKhazanaBundleSubjects(tree, bookConfigs);
    const rootFolderName = buildKhazanaBundleRootFolderName(normalizedClass);
    const entries = [];
    let libraryCount = 0;
    let bookCount = 0;
    const includedBookIds = new Set();

    for (const [index, item] of orderedSubjects.entries()) {
        const subject = item.subject || {};
        const bookConfig = item.bookConfig || null;
        const subjectFolderName = buildKhazanaBundleSubjectFolderName(index + 1, subject.name || bookConfig?.titleLabel || bookConfig?.name || "Subject");
        const subjectFiles = collectKhazanaLibraryFiles(subject.tree, []);

        for (const file of subjectFiles) {
            try {
                const absolutePath = await khazanaLibraryService.resolveAbsoluteFilePath(normalizedClass, file.relativePath);
                const normalizedRelativePath = String(file.relativePath || "").replace(/\\/g, "/");
                const subjectPrefix = `${String(subject.relativePath || "").replace(/\\/g, "/")}/`;
                const relativeWithinSubject = normalizedRelativePath.startsWith(subjectPrefix)
                    ? normalizedRelativePath.slice(subjectPrefix.length)
                    : sanitizeDownloadFileName(file.name || path.basename(normalizedRelativePath));

                entries.push({
                    type: "library",
                    classLevel: normalizedClass,
                    absolutePath,
                    archivePath: path.posix.join(rootFolderName, subjectFolderName, sanitizeArchiveRelativePath(relativeWithinSubject, file.name || "notes.pdf"))
                });
                libraryCount += 1;
            } catch (error) {
                console.warn(`Skipping missing Khazana library file ${file?.relativePath || ""} from class bundle:`, error?.message || error);
            }
        }

        if (subjectFiles.length > 0) {
            if (bookConfig?.id) {
                includedBookIds.add(String(bookConfig.id).trim());
            }
            continue;
        }

        if (!bookConfig?.id) {
            continue;
        }

        try {
            const resolvedBook = await resolveKhazanaBookFileForUser({
                uid,
                classLevel: normalizedClass,
                bookId: String(bookConfig.id || "").trim()
            });

            if (!resolvedBook?.storagePath) {
                continue;
            }

            entries.push({
                type: "book",
                classLevel: normalizedClass,
                storagePath: String(resolvedBook.storagePath || "").trim(),
                archivePath: path.posix.join(
                    rootFolderName,
                    subjectFolderName,
                    sanitizeArchiveSegment(resolvedBook.fileName || buildKhazanaBookFileName(normalizedClass, bookConfig), buildKhazanaBookFileName(normalizedClass, bookConfig))
                )
            });
            includedBookIds.add(String(bookConfig.id).trim());
            bookCount += 1;
        } catch (error) {
            console.warn(`Skipping Khazana mapped book ${bookConfig?.id || ""} from class bundle:`, error?.message || error);
        }
    }

    if (!entries.length) {
        for (const [index, bookConfig] of bookConfigs.entries()) {
            const bookId = String(bookConfig?.id || "").trim();
            if (!bookId || includedBookIds.has(bookId)) {
                continue;
            }

            try {
                const resolvedBook = await resolveKhazanaBookFileForUser({
                    uid,
                    classLevel: normalizedClass,
                    bookId
                });

                if (!resolvedBook?.storagePath) {
                    continue;
                }

                entries.push({
                    type: "book",
                    classLevel: normalizedClass,
                    storagePath: String(resolvedBook.storagePath || "").trim(),
                    archivePath: path.posix.join(
                        rootFolderName,
                        buildKhazanaBundleSubjectFolderName(index + 1, bookConfig.titleLabel || bookConfig.name || bookId),
                        sanitizeArchiveSegment(resolvedBook.fileName || buildKhazanaBookFileName(normalizedClass, bookConfig), buildKhazanaBookFileName(normalizedClass, bookConfig))
                    )
                });
                bookCount += 1;
            } catch (error) {
                console.warn(`Skipping fallback Khazana mapped book ${bookId} from class bundle:`, error?.message || error);
            }
        }
    }

    return {
        rootFolderName,
        entries,
        libraryCount,
        bookCount
    };
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

function createClassBundleAccessToken(payload = {}) {
    const data = {
        uid: String(payload.uid || "").trim(),
        classLevel: normalizeClassLevel(payload.classLevel),
        fileName: sanitizeDownloadFileName(payload.fileName || "Khazana Notes Bundle.zip"),
        exp: Date.now() + BOOK_ACCESS_TOKEN_TTL_MS
    };

    const encodedPayload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    return `${encodedPayload}.${signature}`;
}

function verifyClassBundleAccessToken(token) {
    const [encodedPayload, signature] = String(token || "").split(".");
    if (!encodedPayload || !signature) {
        throw new Error("Invalid class bundle token.");
    }

    const expectedSignature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    const left = Buffer.from(signature);
    const right = Buffer.from(expectedSignature);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        throw new Error("Class bundle token has been tampered with.");
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload?.uid || !payload?.classLevel) {
        throw new Error("Class bundle token is incomplete.");
    }

    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Date.now()) {
        throw new Error("Class bundle token has expired.");
    }

    return payload;
}

function buildClassBundleUrl(req, token) {
    const baseUrl = getRequestBaseUrl(req);
    const url = new URL("/api/khazana/class-bundle", `${baseUrl}/`);
    url.searchParams.set("token", token);
    return url.toString();
}

function createLibraryFileAccessToken(payload = {}) {
    const data = {
        classLevel: normalizeClassLevel(payload.classLevel),
        relativePath: String(payload.relativePath || "").trim(),
        fileName: String(payload.fileName || "").trim(),
        exp: Date.now() + BOOK_ACCESS_TOKEN_TTL_MS
    };

    const encodedPayload = Buffer.from(JSON.stringify(data)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    return `${encodedPayload}.${signature}`;
}

function verifyLibraryFileAccessToken(token) {
    const [encodedPayload, signature] = String(token || "").split(".");
    if (!encodedPayload || !signature) {
        throw new Error("Invalid library access token.");
    }

    const expectedSignature = crypto
        .createHmac("sha256", BOOK_ACCESS_TOKEN_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    const left = Buffer.from(signature);
    const right = Buffer.from(expectedSignature);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        throw new Error("Library access token has been tampered with.");
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload?.classLevel || !payload?.relativePath) {
        throw new Error("Library access token is incomplete.");
    }

    if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) < Date.now()) {
        throw new Error("Library access token has expired.");
    }

    return payload;
}

function buildLibraryFileUrl(req, token, disposition = "inline") {
    const requestedDisposition = String(disposition || "inline").trim().toLowerCase() === "attachment"
        ? "attachment"
        : "inline";
    const baseUrl = getRequestBaseUrl(req);
    const url = new URL("/api/khazana/library-file", `${baseUrl}/`);
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

function recordKhazanaPdfDownload(classLevel, category = "library", count = 1) {
    const normalizedClass = normalizeClassLevel(classLevel);
    if (!normalizedClass) {
        return Promise.resolve();
    }

    const incrementBy = Math.max(1, Number(count) || 1);
    const normalizedCategory = String(category || "").trim().toLowerCase() === "book"
        ? "book"
        : "library";
    const metricsRef = firestore.collection("khazana_metrics").doc(KHAZANA_METRICS_DOC_ID);

    return metricsRef.set({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        "downloads.total": admin.firestore.FieldValue.increment(incrementBy),
        [`downloads.byClass.${normalizedClass}.total`]: admin.firestore.FieldValue.increment(incrementBy),
        [`downloads.byClass.${normalizedClass}.${normalizedCategory}`]: admin.firestore.FieldValue.increment(incrementBy)
    }, { merge: true });
}

async function streamKhazanaClassBundle(req, res, accessPayload) {
    const classLevel = normalizeClassLevel(accessPayload.classLevel);
    const fileName = sanitizeDownloadFileName(accessPayload.fileName || `${classLevel} Khazana Notes Bundle.zip`);
    const bundle = await buildKhazanaClassBundleEntries(accessPayload.uid, classLevel);

    if (!bundle.entries.length) {
        throw new Error("No PDFs are available yet for this class bundle.");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    if (bundle.libraryCount > 0) {
        void recordKhazanaPdfDownload(classLevel, "library", bundle.libraryCount).catch((error) => {
            console.warn("Unable to record Khazana library bundle download:", error?.message || error);
        });
    }

    if (bundle.bookCount > 0) {
        void recordKhazanaPdfDownload(classLevel, "book", bundle.bookCount).catch((error) => {
            console.warn("Unable to record Khazana book bundle download:", error?.message || error);
        });
    }

    const archive = archiver("zip", {
        zlib: { level: 9 }
    });

    archive.on("warning", (error) => {
        if (error?.code === "ENOENT") {
            console.warn("Khazana bundle warning:", error?.message || error);
            return;
        }
        if (!res.headersSent) {
            res.status(500).end("Unable to prepare the requested class bundle.");
            return;
        }
        res.destroy(error);
    });

    archive.on("error", (error) => {
        if (!res.headersSent) {
            res.status(500).end("Unable to prepare the requested class bundle.");
            return;
        }
        res.destroy(error);
    });

    archive.pipe(res);

    for (const entry of bundle.entries) {
        if (entry.type === "library") {
            archive.file(entry.absolutePath, { name: entry.archivePath });
            continue;
        }

        if (entry.type === "book") {
            const stream = storageBucket.file(entry.storagePath).createReadStream();
            stream.on("error", (error) => {
                archive.emit("error", error);
            });
            archive.append(stream, { name: entry.archivePath });
        }
    }

    await archive.finalize();
}

async function streamKhazanaLibraryFile(req, res, accessPayload, options = {}) {
    const headOnly = Boolean(options.headOnly);
    const absoluteFilePath = await khazanaLibraryService.resolveAbsoluteFilePath(
        accessPayload.classLevel,
        accessPayload.relativePath
    );
    const stats = await fs.promises.stat(absoluteFilePath);
    const totalSize = Number(stats.size || 0);
    const contentType = khazanaLibraryService.getMimeType(accessPayload.fileName || absoluteFilePath);
    const disposition = String(req.query?.disposition || "").trim().toLowerCase() === "attachment"
        ? "attachment"
        : "inline";
    const fileName = sanitizeDownloadFileName(accessPayload.fileName || path.basename(absoluteFilePath));
    const contentDisposition = `${disposition}; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Disposition", contentDisposition);

    const rangeHeader = String(req.headers.range || "").trim();
    const range = parseHttpRange(rangeHeader, totalSize);
    const shouldRecordDownload = !headOnly
        && disposition === "attachment"
        && (!range || Number(range.start || 0) === 0);

    if (shouldRecordDownload) {
        void recordKhazanaPdfDownload(accessPayload.classLevel, "library").catch((error) => {
            console.warn("Unable to record Khazana library PDF download:", error?.message || error);
        });
    }

    if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalSize}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
        if (headOnly) {
            res.end();
            return;
        }

        fs.createReadStream(absoluteFilePath, { start: range.start, end: range.end })
            .on("error", (error) => {
                if (!res.headersSent) {
                    res.status(500).end("Unable to stream the requested file range.");
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

    fs.createReadStream(absoluteFilePath)
        .on("error", (error) => {
            if (!res.headersSent) {
                res.status(500).end("Unable to stream the requested file.");
                return;
            }
            res.destroy(error);
        })
        .pipe(res);
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
    const shouldRecordDownload = !headOnly
        && disposition === "attachment"
        && (!range || Number(range.start || 0) === 0);

    if (shouldRecordDownload) {
        void recordKhazanaPdfDownload(accessPayload.classLevel, "book").catch((error) => {
            console.warn("Unable to record Khazana book PDF download:", error?.message || error);
        });
    }

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
    const purchaseDocs = await findKhazanaPurchaseDocsForUser(uid, email);
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
    const completedPurchases = purchaseDocs.filter((docSnapshot) => {
        const purchase = docSnapshot.data() || {};
        return isCompletedKhazanaPurchase(purchase);
    });

    if (!completedAttempts.length && !completedPurchases.length) {
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

    completedPurchases.forEach((docSnapshot) => {
        const purchase = docSnapshot.data() || {};
        const classLevel = normalizeClassLevel(purchase.class_purchased || purchase.classLevel || purchase.class);
        const classConfig = CLASS_CONFIG[classLevel];
        if (!classLevel || !classConfig) return;

        purchasedClasses.add(classLevel);
        classes[classLevel] = {
            purchase_id: String(purchase.purchase_id || purchase.purchaseId || docSnapshot.id || classes[classLevel]?.purchase_id || "").trim(),
            purchase_status: "completed",
            unlocked_books: Array.isArray(classes[classLevel]?.unlocked_books) && classes[classLevel].unlocked_books.length
                ? classes[classLevel].unlocked_books
                : classConfig.bookIds,
            purchased_at: toIsoString(
                purchase.timestamp
                || purchase.updated_at
                || purchase.updatedAt
                || purchase.created_at
                || purchase.createdAt
            ) || classes[classLevel]?.purchased_at || new Date().toISOString(),
            amount_paid: Number.isFinite(Number(purchase.amount_paid))
                ? Number(purchase.amount_paid)
                : (Number.isFinite(Number(purchase.amountInr)) ? Number(purchase.amountInr) : classConfig.amountInr),
            razorpay_payment_id: String(
                purchase.razorpay_payment_id
                || purchase.paymentId
                || classes[classLevel]?.razorpay_payment_id
                || ""
            ).trim(),
            razorpay_order_id: String(
                purchase.razorpay_order_id
                || purchase.orderId
                || classes[classLevel]?.razorpay_order_id
                || ""
            ).trim()
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
    return Object.values(classes).some((value) => hasCompletedClassAccess(value));
}

function hasCompletedClassAccess(classAccess) {
    const purchaseStatus = String(classAccess?.purchase_status || "").trim().toLowerCase();
    if (purchaseStatus === "completed") {
        return true;
    }

    const unlockedBooks = Array.isArray(classAccess?.unlocked_books) ? classAccess.unlocked_books.filter(Boolean) : [];
    return unlockedBooks.length > 0;
}

function normalizeAccessSummary(accessSummary) {
    const normalized = {};
    const rawClasses = accessSummary?.classes;

    if (rawClasses && typeof rawClasses === "object") {
        Object.entries(rawClasses).forEach(([key, value]) => {
            const normalizedKey = normalizeClassLevel(key);
            if (!normalizedKey || !value || typeof value !== "object") return;
            const unlockedBooks = Array.isArray(value.unlocked_books) ? value.unlocked_books.filter(Boolean) : [];
            normalized[normalizedKey] = {
                ...(normalized[normalizedKey] || {}),
                ...value,
                purchase_status: String(value.purchase_status || normalized[normalizedKey]?.purchase_status || "").trim()
                    || (unlockedBooks.length ? "completed" : "")
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
        const topLevelUnlockedBooks = Array.isArray(accessSummary?.unlocked_books) ? accessSummary.unlocked_books.filter(Boolean) : [];
        normalized[fallbackClass] = {
            ...(normalized[fallbackClass] || {}),
            purchase_status: normalized[fallbackClass]?.purchase_status
                || String(accessSummary?.purchase_status || "").trim()
                || "completed",
            unlocked_books: Array.isArray(normalized[fallbackClass]?.unlocked_books) && normalized[fallbackClass].unlocked_books.length
                ? normalized[fallbackClass].unlocked_books
                : topLevelUnlockedBooks
        };
    }

    return normalized;
}

async function findKhazanaPurchaseDocsForUser(uid, email = "") {
    const purchasesById = new Map();
    const normalizedUid = String(uid || "").trim();
    const normalizedEmail = String(email || "").trim();
    const queries = [];

    if (normalizedUid) {
        queries.push(firestore.collection("purchases").where("user_id", "==", normalizedUid).get());
        queries.push(firestore.collection("purchases").where("uid", "==", normalizedUid).get());
    }

    if (normalizedEmail) {
        queries.push(firestore.collection("purchases").where("student.email", "==", normalizedEmail).get());
    }

    if (!queries.length) {
        return [];
    }

    const settled = await Promise.allSettled(queries);
    settled.forEach((result) => {
        if (result.status !== "fulfilled") {
            console.warn("Unable to query Khazana purchases for access repair:", result.reason?.message || result.reason);
            return;
        }

        result.value.docs.forEach((docSnapshot) => {
            purchasesById.set(docSnapshot.id, docSnapshot);
        });
    });

    return Array.from(purchasesById.values());
}

function isCompletedKhazanaPurchase(purchase = {}) {
    const status = String(purchase.purchase_status || purchase.status || "").trim().toLowerCase();
    if (["completed", "paid", "success", "captured"].includes(status)) {
        return true;
    }

    if (status) {
        return false;
    }

    const classLevel = normalizeClassLevel(purchase.class_purchased || purchase.classLevel || purchase.class);
    return Boolean(
        classLevel
        && (purchase.razorpay_payment_id || purchase.paymentId || purchase.payment_attempt_id || Number.isFinite(Number(purchase.amount_paid)))
    );
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

async function reconcilePendingPaidPaymentLinkAttempts({ limit = 50 } = {}) {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
        return {
            scanned: 0,
            reconciled: 0,
            skipped: 0
        };
    }

    const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const snapshot = await firestore
        .collection("khazana_payment_attempts")
        .where("flow", "==", "payment_link")
        .get();

    const pendingAttempts = snapshot.docs
        .map((docSnapshot) => ({
            id: docSnapshot.id,
            ref: docSnapshot.ref,
            data: docSnapshot.data() || {}
        }))
        .filter(({ data }) => (
            data.status !== "completed"
            && data.paymentLinkId
            && data.uid
            && CLASS_CONFIG[normalizeClassLevel(data.classLevel)]
        ))
        .sort((left, right) => getMillis(right.data.createdAt) - getMillis(left.data.createdAt))
        .slice(0, normalizedLimit);

    let reconciled = 0;
    let skipped = 0;

    for (const { id, ref, data: attempt } of pendingAttempts) {
        try {
            const classLevel = normalizeClassLevel(attempt.classLevel);
            const verifiedLinkPayment = await verifyPaymentLinkAttempt({
                attempt,
                paymentId: "",
                paymentLinkId: "",
                orderId: ""
            });

            await grantKhazanaAccess({
                uid: attempt.uid,
                classLevel,
                payment: verifiedLinkPayment.payment,
                paymentId: verifiedLinkPayment.paymentId,
                orderId: verifiedLinkPayment.orderId,
                attemptId: id,
                attemptRef: ref,
                attempt
            });
            reconciled += 1;
        } catch (error) {
            const message = String(error?.message || "");
            if (!/not marked as paid|payment id is not available|lookup failed/i.test(message)) {
                console.warn(`Unable to reconcile Khazana payment link attempt ${id}:`, error);
            }
            skipped += 1;
        }
    }

    return {
        scanned: pendingAttempts.length,
        reconciled,
        skipped
    };
}

function readFlattenedNumber(source, pathSegments = []) {
    const dottedPath = pathSegments.join(".");
    if (source && Object.prototype.hasOwnProperty.call(source, dottedPath)) {
        const directValue = Number(source[dottedPath]);
        return Number.isFinite(directValue) ? directValue : 0;
    }

    let cursor = source;
    for (const segment of pathSegments) {
        if (!cursor || typeof cursor !== "object") {
            cursor = undefined;
            break;
        }
        cursor = cursor[segment];
    }

    const nestedValue = Number(cursor);
    return Number.isFinite(nestedValue) ? nestedValue : 0;
}

function isCompletedKhazanaPurchaseRecord(purchase = {}) {
    const status = String(purchase.purchase_status || purchase.status || "").trim().toLowerCase();
    if (["completed", "paid", "success", "captured"].includes(status)) {
        return true;
    }

    if (status) {
        return false;
    }

    const classLevel = normalizeClassLevel(purchase.class_purchased || purchase.classLevel || purchase.class);
    return Boolean(
        classLevel
        && (
            String(purchase.razorpay_payment_id || purchase.paymentId || "").trim()
            || String(purchase.payment_attempt_id || purchase.paymentAttemptId || "").trim()
            || Number.isFinite(Number(purchase.amount_paid))
            || Number.isFinite(Number(purchase.amountInr))
        )
    );
}

function hasCompletedKhazanaClassAccess(classAccess = {}) {
    const purchaseStatus = String(classAccess.purchase_status || "").trim().toLowerCase();
    if (["completed", "paid", "success", "captured"].includes(purchaseStatus)) {
        return true;
    }

    const unlockedBooks = Array.isArray(classAccess.unlocked_books) ? classAccess.unlocked_books.filter(Boolean) : [];
    return unlockedBooks.length > 0;
}

function normalizeKhazanaAccessSummary(accessSummary = {}) {
    const normalized = {};
    const rawClasses = accessSummary?.classes;

    if (rawClasses && typeof rawClasses === "object") {
        Object.entries(rawClasses).forEach(([key, value]) => {
            const normalizedKey = normalizeClassLevel(key);
            if (!normalizedKey || !value || typeof value !== "object") return;
            const unlockedBooks = Array.isArray(value.unlocked_books) ? value.unlocked_books.filter(Boolean) : [];
            normalized[normalizedKey] = {
                ...(normalized[normalizedKey] || {}),
                ...value,
                purchase_status: String(value.purchase_status || normalized[normalizedKey]?.purchase_status || "").trim()
                    || (unlockedBooks.length ? "completed" : "")
            };
        });
    }

    const purchasedClasses = Array.isArray(accessSummary?.purchased_classes) ? accessSummary.purchased_classes : [];
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
        const topLevelUnlockedBooks = Array.isArray(accessSummary?.unlocked_books) ? accessSummary.unlocked_books.filter(Boolean) : [];
        normalized[fallbackClass] = {
            ...(normalized[fallbackClass] || {}),
            purchase_status: normalized[fallbackClass]?.purchase_status || String(accessSummary?.purchase_status || "completed").trim(),
            unlocked_books: Array.isArray(normalized[fallbackClass]?.unlocked_books) && normalized[fallbackClass].unlocked_books.length
                ? normalized[fallbackClass].unlocked_books
                : topLevelUnlockedBooks
        };
    }

    return normalized;
}

function buildAdminBuyerIdentityKeys(buyer = {}) {
    const identities = [];
    const purchaseId = String(buyer.purchase_id || buyer.purchaseId || buyer.id || "").trim();
    const attemptId = String(buyer.payment_attempt_id || buyer.paymentAttemptId || "").trim();
    const paymentId = String(buyer.razorpay_payment_id || buyer.paymentId || "").trim();
    const uid = String(buyer.user_id || buyer.uid || "").trim();
    const classLevel = normalizeClassLevel(buyer.class_purchased || buyer.classLevel || buyer.class || buyer.buyerClass);
    const email = String(buyer.buyerEmail || buyer.email || buyer.student?.email || "").trim().toLowerCase();

    if (purchaseId) identities.push(`purchase:${purchaseId}`);
    if (attemptId) identities.push(`attempt:${attemptId}`);
    if (paymentId) identities.push(`payment:${paymentId}`);
    if (uid && classLevel) identities.push(`userclass:${uid}:${classLevel}`);
    if (email && classLevel) identities.push(`emailclass:${email}:${classLevel}`);

    const fallback = [uid, classLevel, String(buyer.timestamp || buyer.createdAt || buyer.updated_at || "").trim()].filter(Boolean).join("::");
    if (fallback) identities.push(`fallback:${fallback}`);

    return Array.from(new Set(identities.filter(Boolean)));
}

function buildSalesSummaryFromBuyers(buyers = []) {
    const counts = { "10th": 0, "12th": 0 };
    const revenue = { "10th": 0, "12th": 0 };
    const byClass = { "10th": [], "12th": [] };

    buyers.forEach((buyer) => {
        const classLevel = normalizeClassLevel(buyer.class_purchased || buyer.classLevel || buyer.class || buyer.buyerClass);
        if (!classLevel || !(classLevel in counts)) {
            return;
        }

        counts[classLevel] += 1;
        revenue[classLevel] += Number.isFinite(Number(buyer.amount_paid)) ? Number(buyer.amount_paid) : 0;
        byClass[classLevel].push(buyer);
    });

    return {
        counts,
        revenue,
        totalSold: buyers.length,
        totalRevenue: buyers.reduce((sum, buyer) => sum + (Number.isFinite(Number(buyer.amount_paid)) ? Number(buyer.amount_paid) : 0), 0),
        byClass
    };
}

async function buildAdminKhazanaAnalyticsPayload() {
    const [configSnapshot, metricsSnapshot, purchasesSnapshot, attemptsSnapshot, accessSnapshot] = await Promise.all([
        firestore.collection("khazana_config").doc("main").get(),
        firestore.collection("khazana_metrics").doc("downloads").get(),
        firestore.collection("purchases").get(),
        firestore.collection("khazana_payment_attempts").where("status", "==", "completed").get(),
        firestore.collection("user_access").get()
    ]);

    const config = configSnapshot.exists ? (configSnapshot.data() || {}) : {};
    const metricsData = metricsSnapshot.exists ? (metricsSnapshot.data() || {}) : {};
    const downloads = {
        total: readFlattenedNumber(metricsData, ["downloads", "total"]),
        byClass: {
            "10th": {
                total: readFlattenedNumber(metricsData, ["downloads", "byClass", "10th", "total"]),
                library: readFlattenedNumber(metricsData, ["downloads", "byClass", "10th", "library"]),
                book: readFlattenedNumber(metricsData, ["downloads", "byClass", "10th", "book"])
            },
            "12th": {
                total: readFlattenedNumber(metricsData, ["downloads", "byClass", "12th", "total"]),
                library: readFlattenedNumber(metricsData, ["downloads", "byClass", "12th", "library"]),
                book: readFlattenedNumber(metricsData, ["downloads", "byClass", "12th", "book"])
            }
        }
    };

    const buyers = [];
    const seen = new Set();
    const addBuyer = (buyer) => {
        const identities = buildAdminBuyerIdentityKeys(buyer);
        if (!identities.length || identities.some((identity) => seen.has(identity))) {
            return;
        }

        identities.forEach((identity) => seen.add(identity));
        buyers.push(buyer);
    };

    purchasesSnapshot.docs
        .map((docSnapshot) => ({ id: docSnapshot.id, ...docSnapshot.data() }))
        .filter((purchase) => isCompletedKhazanaPurchaseRecord(purchase))
        .forEach((purchase) => addBuyer({
            source: "purchase",
            ...purchase
        }));

    attemptsSnapshot.docs
        .map((docSnapshot) => ({ id: docSnapshot.id, ...docSnapshot.data() }))
        .forEach((attempt) => addBuyer({
            source: "attempt",
            id: String(attempt.purchaseId || attempt.id || "").trim(),
            uid: String(attempt.uid || attempt.user_id || "").trim(),
            user_id: String(attempt.uid || attempt.user_id || "").trim(),
            class_purchased: normalizeClassLevel(attempt.classLevel || attempt.class_purchased || attempt.class),
            purchase_status: "completed",
            amount_paid: Number.isFinite(Number(attempt.amountInr)) ? Number(attempt.amountInr) : 0,
            razorpay_payment_id: String(attempt.paymentId || attempt.razorpay_payment_id || "").trim(),
            razorpay_order_id: String(attempt.orderId || attempt.razorpay_order_id || "").trim(),
            payment_attempt_id: String(attempt.payment_attempt_id || attempt.paymentAttemptId || attempt.id || "").trim(),
            student: attempt.student || {},
            timestamp: attempt.verifiedAt || attempt.updatedAt || attempt.createdAt || null,
            createdAt: attempt.createdAt || null,
            updated_at: attempt.updatedAt || null
        }));

    accessSnapshot.docs.forEach((docSnapshot) => {
        const accessSummary = docSnapshot.data() || {};
        const classes = normalizeKhazanaAccessSummary(accessSummary);

        Object.entries(classes).forEach(([classLevel, classAccess]) => {
            if (!hasCompletedKhazanaClassAccess(classAccess)) {
                return;
            }

            addBuyer({
                source: "access",
                id: `access:${docSnapshot.id}:${classLevel}`,
                uid: String(accessSummary.user_id || docSnapshot.id || "").trim(),
                user_id: String(accessSummary.user_id || docSnapshot.id || "").trim(),
                class_purchased: classLevel,
                purchase_status: "completed",
                amount_paid: Number.isFinite(Number(classAccess.amount_paid)) ? Number(classAccess.amount_paid) : (Number.isFinite(Number(classAccess.amountInr)) ? Number(classAccess.amountInr) : 0),
                razorpay_payment_id: String(classAccess.razorpay_payment_id || classAccess.paymentId || "").trim(),
                razorpay_order_id: String(classAccess.razorpay_order_id || classAccess.orderId || "").trim(),
                purchase_id: String(classAccess.purchase_id || classAccess.purchaseId || "").trim(),
                student: accessSummary.student || {},
                timestamp: classAccess.purchased_at || accessSummary.updated_at || accessSummary.timestamp || null,
                createdAt: accessSummary.createdAt || null,
                updated_at: accessSummary.updated_at || null
            });
        });
    });

    return {
        config,
        buyers,
        sales: buildSalesSummaryFromBuyers(buyers),
        downloads,
        backend: {
            ok: true,
            service: "khazana-razorpay-backend",
            flow: DEFAULT_RAZORPAY_FLOW,
            classes: Object.fromEntries(
                Object.entries(CLASS_CONFIG).map(([classLevel, configEntry]) => [
                    classLevel,
                    {
                        displayName: configEntry.displayName,
                        amountInr: configEntry.amountInr
                    }
                ])
            )
        }
    };
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
