const fs = require("fs");
const path = require("path");

const fsp = fs.promises;
const LIBRARY_ROOT = resolveLibraryRoot();
const CLASS_DIRECTORY_BY_LEVEL = {
    "10th": "Class-10",
    "12th": "Class-12"
};
const VALID_CLASS_LEVELS = new Set(Object.keys(CLASS_DIRECTORY_BY_LEVEL));
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const LIBRARY_TREE_CACHE_TTL_MS = 60 * 1000;
const libraryTreeCache = new Map();
let allLibrariesCache = {
    value: null,
    exp: 0
};

function resolveLibraryRoot() {
    const envOverride = String(process.env.KHAZANA_LIBRARY_ROOT || "").trim();
    const candidates = [
        envOverride,
        path.resolve(process.cwd(), "data", "khazana"),
        path.resolve(process.cwd(), "..", "data", "khazana"),
        path.resolve(__dirname, "..", "..", "data", "khazana"),
        path.resolve(__dirname, "..", "data", "khazana")
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch (_) {
        }
    }

    return candidates[0] || path.resolve(__dirname, "..", "..", "data", "khazana");
}

function normalizeSortableDigits(value) {
    return Array.from(String(value || "")).map((character) => {
        const codePoint = character.codePointAt(0);
        if (typeof codePoint !== "number") {
            return character;
        }

        if (codePoint >= 0x0966 && codePoint <= 0x096F) {
            return String(codePoint - 0x0966);
        }

        if (codePoint >= 0x0660 && codePoint <= 0x0669) {
            return String(codePoint - 0x0660);
        }

        if (codePoint >= 0x06F0 && codePoint <= 0x06F9) {
            return String(codePoint - 0x06F0);
        }

        if (codePoint >= 0xFF10 && codePoint <= 0xFF19) {
            return String(codePoint - 0xFF10);
        }

        return character;
    }).join("");
}

function getNaturalSortLabel(value) {
    const raw = normalizeSortableDigits(value)
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim();
    const parsed = path.parse(raw);
    return {
        raw,
        base: parsed.ext ? parsed.name : raw
    };
}

function compareNaturalNames(leftValue, rightValue) {
    const left = getNaturalSortLabel(leftValue);
    const right = getNaturalSortLabel(rightValue);
    const baseCompare = left.base.localeCompare(right.base, undefined, {
        numeric: true,
        sensitivity: "base"
    });
    if (baseCompare !== 0) {
        return baseCompare;
    }

    return left.raw.localeCompare(right.raw, undefined, {
        numeric: true,
        sensitivity: "base"
    });
}

function normalizeClassLevel(value) {
    const raw = String(value || "").trim();
    const compact = raw.toLowerCase().replace(/\s+/g, "");
    if (["10", "10th", "class10", "class10th", "10thclass", "classx", "x", "std10"].includes(compact)) return "10th";
    if (["12", "12th", "class12", "class12th", "12thclass", "classxii", "xii", "std12"].includes(compact)) return "12th";
    return "";
}

function ensureValidClassLevel(classLevel) {
    const normalized = normalizeClassLevel(classLevel);
    if (!VALID_CLASS_LEVELS.has(normalized)) {
        throw new Error("Invalid class level.");
    }
    return normalized;
}

function getClassDirectoryName(classLevel) {
    return CLASS_DIRECTORY_BY_LEVEL[ensureValidClassLevel(classLevel)];
}

function normalizeRelativePath(value, options = {}) {
    const allowEmpty = options.allowEmpty !== false;
    const raw = String(value || "").trim().replace(/\\/g, "/");
    if (!raw) {
        if (allowEmpty) return "";
        throw new Error("Folder path is required.");
    }

    const segments = raw
        .split("/")
        .map((segment) => String(segment || "").trim())
        .filter(Boolean);

    if (!segments.length) {
        if (allowEmpty) return "";
        throw new Error("Folder path is required.");
    }

    if (segments.some((segment) => segment === "." || segment === "..")) {
        throw new Error("Folder path is invalid.");
    }

    return segments.join("/");
}

function sanitizeUploadFileName(value) {
    const baseName = path.basename(String(value || "").trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
    return baseName || "file";
}

function sanitizeFolderSegment(value) {
    const cleaned = String(value || "")
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!cleaned || cleaned === "." || cleaned === "..") {
        throw new Error("Folder name is invalid.");
    }

    return cleaned;
}

function getSubjectRootRelativePath(relativePath) {
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const [subjectSegment] = normalizedRelativePath.split("/");
    if (!subjectSegment) {
        throw new Error("Subject path is invalid.");
    }
    return subjectSegment;
}

async function ensureLibraryRoot() {
    await fsp.mkdir(LIBRARY_ROOT, { recursive: true });
    return LIBRARY_ROOT;
}

function getClassRoot(classLevel) {
    return path.join(LIBRARY_ROOT, getClassDirectoryName(classLevel));
}

async function ensureClassRoot(classLevel) {
    await ensureLibraryRoot();
    const classRoot = getClassRoot(classLevel);
    await fsp.mkdir(classRoot, { recursive: true });
    return classRoot;
}

function assertPathInsideRoot(rootPath, candidatePath) {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedCandidate = path.resolve(candidatePath);
    const relative = path.relative(resolvedRoot, resolvedCandidate);

    if (!relative || relative === "") {
        return resolvedCandidate;
    }

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Resolved path is outside the Khazana library.");
    }

    return resolvedCandidate;
}

async function getSortedDirectoryEntries(directoryPath) {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    return entries.sort((left, right) => compareNaturalNames(left.name, right.name));
}

function createFileRecord({ classLevel, relativePath, parentPath, entryName, stats, isFreePreview = false }) {
    return {
        name: entryName,
        classLevel,
        relativePath: relativePath.replace(/\\/g, "/"),
        parentPath,
        extension: path.extname(entryName).slice(1).toLowerCase(),
        size: Number(stats.size) || 0,
        updatedAt: stats.mtime.toISOString(),
        isFreePreview
    };
}

async function buildFolderNode(classLevel, absoluteFolderPath, relativeFolderPath) {
    const entries = await getSortedDirectoryEntries(absoluteFolderPath);
    const resolvedEntries = await Promise.all(entries.map(async (entry) => {
        const entryAbsolutePath = path.join(absoluteFolderPath, entry.name);
        const entryRelativePath = relativeFolderPath ? `${relativeFolderPath}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            return {
                kind: "folder",
                value: await buildFolderNode(classLevel, entryAbsolutePath, entryRelativePath)
            };
        }

        if (!entry.isFile()) {
            return null;
        }

        const stats = await fsp.stat(entryAbsolutePath);
        return {
            kind: "file",
            value: createFileRecord({
                classLevel,
                relativePath: entryRelativePath,
                parentPath: relativeFolderPath,
                entryName: entry.name,
                stats
            })
        };
    }));

    const folders = resolvedEntries
        .filter((entry) => entry?.kind === "folder" && entry.value)
        .map((entry) => entry.value);
    const files = resolvedEntries
        .filter((entry) => entry?.kind === "file" && entry.value)
        .map((entry) => entry.value);

    return {
        type: "folder",
        name: path.basename(absoluteFolderPath),
        classLevel,
        relativePath: relativeFolderPath.replace(/\\/g, "/"),
        folders,
        files
    };
}

function isImageFile(file = {}) {
    return IMAGE_EXTENSIONS.has(String(file.extension || "").trim().toLowerCase());
}

function pickSubjectCoverFile(subjectNode) {
    const rootFiles = Array.isArray(subjectNode?.files) ? subjectNode.files : [];
    const imageFiles = rootFiles.filter((file) => isImageFile(file));
    if (!imageFiles.length) {
        return null;
    }

    const prioritized = imageFiles.find((file) => {
        const normalized = String(file.name || "").trim().toLowerCase();
        return normalized.startsWith("cover.") || normalized.startsWith("book-cover.") || normalized.includes("cover");
    });

    return prioritized || imageFiles[0] || null;
}

function collectFiles(folderNode, target = []) {
    if (!folderNode || typeof folderNode !== "object") {
        return target;
    }

    (folderNode.files || []).forEach((file) => {
        target.push(file);
    });

    (folderNode.folders || []).forEach((folder) => {
        collectFiles(folder, target);
    });

    return target;
}

function countFolders(folderNode) {
    if (!folderNode || typeof folderNode !== "object") {
        return 0;
    }

    return (folderNode.folders || []).reduce((total, folder) => total + 1 + countFolders(folder), 0);
}

function resetFolderFreePreview(folderNode) {
    if (!folderNode || typeof folderNode !== "object") {
        return;
    }

    folderNode.files = (folderNode.files || []).map((file) => ({
        ...file,
        isFreePreview: false
    }));

    folderNode.folders = (folderNode.folders || []).map((folder) => {
        resetFolderFreePreview(folder);
        return folder;
    });
}

function pickPreferredFreePreviewFile(files = []) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) {
        return null;
    }

    const pdfFile = list.find((file) => String(file.extension || "").trim().toLowerCase() === "pdf");
    return pdfFile || list[0] || null;
}

function markSingleSubjectFreePreview(folderNode) {
    if (!folderNode || typeof folderNode !== "object") {
        return {
            freeCount: 0,
            freeRelativePath: ""
        };
    }

    resetFolderFreePreview(folderNode);
    const allFiles = collectFiles(folderNode, []);
    const freeFile = pickPreferredFreePreviewFile(allFiles);
    if (!freeFile?.relativePath) {
        return {
            freeCount: 0,
            freeRelativePath: ""
        };
    }

    const freeRelativePath = String(freeFile.relativePath || "").replace(/\\/g, "/");
    const applyPreviewFlag = (node) => {
        node.files = (node.files || []).map((file) => ({
            ...file,
            isFreePreview: String(file.relativePath || "").replace(/\\/g, "/") === freeRelativePath
        }));
        node.folders = (node.folders || []).map((folder) => {
            applyPreviewFlag(folder);
            return folder;
        });
    };

    applyPreviewFlag(folderNode);

    return {
        freeCount: 1,
        freeRelativePath
    };
}

function findFolderNode(folderNode, relativePath) {
    if (!folderNode || typeof folderNode !== "object") {
        return null;
    }

    const normalizedTarget = normalizeRelativePath(relativePath, { allowEmpty: true });
    if (String(folderNode.relativePath || "") === normalizedTarget) {
        return folderNode;
    }

    for (const folder of folderNode.folders || []) {
        const matched = findFolderNode(folder, normalizedTarget);
        if (matched) {
            return matched;
        }
    }

    return null;
}

function stripClassPrefixFromPath(filePath = "") {
    const normalized = normalizeRelativePath(filePath, { allowEmpty: false });
    const parts = normalized.split("/");
    const first = String(parts[0] || "").trim();
    const classLevel = normalizeClassLevel(first);

    if (classLevel && parts.length > 1) {
        return {
            classLevel,
            relativePath: parts.slice(1).join("/")
        };
    }

    const classByDirectory = Object.entries(CLASS_DIRECTORY_BY_LEVEL).find(([, directoryName]) => directoryName.toLowerCase() === first.toLowerCase());
    if (classByDirectory && parts.length > 1) {
        return {
            classLevel: classByDirectory[0],
            relativePath: parts.slice(1).join("/")
        };
    }

    return {
        classLevel: "",
        relativePath: normalized
    };
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function readCachedLibraryTree(classLevel) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const cached = libraryTreeCache.get(normalizedClass);
    if (!cached || !cached.value || Number(cached.exp || 0) <= Date.now()) {
        libraryTreeCache.delete(normalizedClass);
        return null;
    }

    return cloneJson(cached.value);
}

function writeCachedLibraryTree(classLevel, tree) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    libraryTreeCache.set(normalizedClass, {
        value: cloneJson(tree),
        exp: Date.now() + LIBRARY_TREE_CACHE_TTL_MS
    });
}

function invalidateLibraryCaches(classLevel = "") {
    const normalizedClass = normalizeClassLevel(classLevel);
    if (normalizedClass) {
        libraryTreeCache.delete(normalizedClass);
    } else {
        libraryTreeCache.clear();
    }

    allLibrariesCache = {
        value: null,
        exp: 0
    };
}

async function getLibraryTree(classLevel) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const cachedTree = readCachedLibraryTree(normalizedClass);
    if (cachedTree) {
        return cachedTree;
    }

    await ensureLibraryRoot();
    const classRoot = getClassRoot(normalizedClass);
    const hasClassRoot = await fsp.access(classRoot, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
    if (!hasClassRoot) {
        return {
            classLevel: normalizedClass,
            classDirectory: getClassDirectoryName(normalizedClass),
            subjects: [],
            subjectCount: 0,
            totalFileCount: 0,
            freeFileCount: 0
        };
    }

    const entries = await getSortedDirectoryEntries(classRoot);
    const subjects = (await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory()) {
            return null;
        }

        const relativeSubjectPath = entry.name;
        const subjectNode = await buildFolderNode(
            normalizedClass,
            path.join(classRoot, entry.name),
            relativeSubjectPath
        );

        const coverFile = pickSubjectCoverFile(subjectNode);
        subjectNode.files = (subjectNode.files || []).filter((file) => !isImageFile(file));
        const freeSummary = markSingleSubjectFreePreview(subjectNode);
        const allFiles = collectFiles(subjectNode, []);

        return {
            id: relativeSubjectPath
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || relativeSubjectPath,
            name: entry.name,
            classLevel: normalizedClass,
            classDirectory: getClassDirectoryName(normalizedClass),
            relativePath: relativeSubjectPath,
            coverFile,
            freeFileRelativePath: freeSummary.freeRelativePath || "",
            fileCount: allFiles.length,
            freeFileCount: freeSummary.freeCount,
            folderCount: countFolders(subjectNode),
            tree: subjectNode
        };
    }))).filter(Boolean);

    const totalFileCount = subjects.reduce((sum, subject) => sum + Number(subject.fileCount || 0), 0);
    const freeFileCount = subjects.reduce((sum, subject) => sum + Number(subject.freeFileCount || 0), 0);

    const tree = {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        subjects,
        subjectCount: subjects.length,
        totalFileCount,
        freeFileCount
    };

    writeCachedLibraryTree(normalizedClass, tree);
    return cloneJson(tree);
}

async function getAllLibraries() {
    if (allLibrariesCache.value && Number(allLibrariesCache.exp || 0) > Date.now()) {
        return cloneJson(allLibrariesCache.value);
    }

    const classes = await Promise.all(
        Object.keys(CLASS_DIRECTORY_BY_LEVEL).map((classLevel) => getLibraryTree(classLevel))
    );

    const payload = {
        classes,
        byClass: Object.fromEntries(classes.map((entry) => [entry.classLevel, entry]))
    };

    allLibrariesCache = {
        value: cloneJson(payload),
        exp: Date.now() + LIBRARY_TREE_CACHE_TTL_MS
    };

    return cloneJson(payload);
}

async function getFileRecord(classLevel, relativePath) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const tree = await getLibraryTree(normalizedClass);

    for (const subject of tree.subjects) {
        const files = collectFiles(subject.tree, []);
        const matchedFile = files.find((file) => file.relativePath === normalizedRelativePath);
        if (matchedFile) {
            return {
                classLevel: normalizedClass,
                subject,
                file: matchedFile
            };
        }
    }

    return null;
}

async function getSubjectCoverRecord(classLevel, relativePath) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const tree = await getLibraryTree(normalizedClass);

    for (const subject of tree.subjects) {
        if (subject?.coverFile?.relativePath === normalizedRelativePath) {
            return {
                classLevel: normalizedClass,
                subject,
                file: subject.coverFile
            };
        }
    }

    return null;
}

async function resolveAbsoluteFilePath(classLevel, relativePath) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const absoluteFilePath = assertPathInsideRoot(classRoot, path.join(classRoot, normalizedRelativePath));
    const stats = await fsp.stat(absoluteFilePath);

    if (!stats.isFile()) {
        throw new Error("Requested file does not exist.");
    }

    return absoluteFilePath;
}

async function resolveNonCollidingFilePath(directoryPath, fileName) {
    const parsed = path.parse(fileName);
    let nextAbsolutePath = path.join(directoryPath, fileName);
    let counter = 1;

    while (true) {
        try {
            await fsp.access(nextAbsolutePath, fs.constants.F_OK);
            const suffix = ` (${counter})`;
            nextAbsolutePath = path.join(directoryPath, `${parsed.name}${suffix}${parsed.ext}`);
            counter += 1;
        } catch (_) {
            return nextAbsolutePath;
        }
    }
}

async function uploadFile({ classLevel, folderPath, fileName, fileBuffer }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedFolderPath = normalizeRelativePath(folderPath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const targetDirectory = assertPathInsideRoot(classRoot, path.join(classRoot, normalizedFolderPath));
    const safeFileName = sanitizeUploadFileName(fileName);
    const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.alloc(0);

    if (!buffer.length) {
        throw new Error("Uploaded file is empty.");
    }

    await fsp.mkdir(targetDirectory, { recursive: true });
    const absoluteFilePath = await resolveNonCollidingFilePath(targetDirectory, safeFileName);
    await fsp.writeFile(absoluteFilePath, buffer);
    invalidateLibraryCaches(normalizedClass);

    const savedFileName = path.basename(absoluteFilePath);
    const relativePath = `${normalizedFolderPath}/${savedFileName}`.replace(/\\/g, "/");
    const stats = await fsp.stat(absoluteFilePath);
    const fileRecord = createFileRecord({
        classLevel: normalizedClass,
        relativePath,
        parentPath: normalizedFolderPath,
        entryName: savedFileName,
        stats
    });

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        folderPath: normalizedFolderPath,
        relativePath,
        fileName: savedFileName,
        file: fileRecord || null
    };
}

async function uploadFiles({ classLevel, subject, subfolder = "", files = [] }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedSubject = normalizeRelativePath(subject, { allowEmpty: false });
    const normalizedSubfolder = normalizeRelativePath(subfolder, { allowEmpty: true });
    const targetFolderPath = normalizeRelativePath(
        normalizedSubfolder ? `${normalizedSubject}/${normalizedSubfolder}` : normalizedSubject,
        { allowEmpty: false }
    );

    const uploaded = [];
    for (const file of Array.from(files || [])) {
        if (!file) {
            continue;
        }

        uploaded.push(await uploadFile({
            classLevel: normalizedClass,
            folderPath: targetFolderPath,
            fileName: file.name,
            fileBuffer: file.buffer
        }));
    }

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        subject: normalizedSubject,
        subfolder: normalizedSubfolder,
        folderPath: targetFolderPath,
        uploaded
    };
}

async function createFolder({ classLevel, folderPath }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedFolderPath = normalizeRelativePath(folderPath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const targetDirectory = assertPathInsideRoot(classRoot, path.join(classRoot, normalizedFolderPath));

    await fsp.mkdir(targetDirectory, { recursive: true });
    invalidateLibraryCaches(normalizedClass);

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        folderPath: normalizedFolderPath
    };
}

async function pruneEmptyDirectories(startDirectory, stopDirectory) {
    let currentDirectory = startDirectory;
    const resolvedStopDirectory = path.resolve(stopDirectory);

    while (currentDirectory && path.resolve(currentDirectory) !== resolvedStopDirectory) {
        const entries = await fsp.readdir(currentDirectory);
        if (entries.length > 0) {
            return;
        }

        await fsp.rmdir(currentDirectory);
        currentDirectory = path.dirname(currentDirectory);
    }
}

async function deleteFile({ classLevel, relativePath }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const absoluteFilePath = await resolveAbsoluteFilePath(normalizedClass, normalizedRelativePath);
    const subjectRootPath = assertPathInsideRoot(
        classRoot,
        path.join(classRoot, getSubjectRootRelativePath(normalizedRelativePath))
    );

    await fsp.unlink(absoluteFilePath);
    await pruneEmptyDirectories(path.dirname(absoluteFilePath), subjectRootPath);
    invalidateLibraryCaches(normalizedClass);

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        relativePath: normalizedRelativePath
    };
}

async function deleteFileByAnyPath(filePath, fallbackClassLevel = "") {
    const resolvedPath = stripClassPrefixFromPath(filePath);
    const classLevel = ensureValidClassLevel(resolvedPath.classLevel || fallbackClassLevel);
    return deleteFile({
        classLevel,
        relativePath: resolvedPath.relativePath
    });
}

async function deleteFolder({ classLevel, folderPath, allowRoot = false }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedFolderPath = normalizeRelativePath(folderPath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const absoluteFolderPath = assertPathInsideRoot(classRoot, path.join(classRoot, normalizedFolderPath));
    const subjectRootPath = assertPathInsideRoot(
        classRoot,
        path.join(classRoot, getSubjectRootRelativePath(normalizedFolderPath))
    );
    const relativeFromClassRoot = path.relative(classRoot, absoluteFolderPath).replace(/\\/g, "/");

    if ((!relativeFromClassRoot || !relativeFromClassRoot.includes("/")) && !allowRoot) {
        throw new Error("Main subject folders cannot be deleted from this panel.");
    }

    const stats = await fsp.stat(absoluteFolderPath);
    if (!stats.isDirectory()) {
        throw new Error("Requested folder does not exist.");
    }

    await fsp.rm(absoluteFolderPath, { recursive: true, force: false });
    await pruneEmptyDirectories(path.dirname(absoluteFolderPath), subjectRootPath);
    invalidateLibraryCaches(normalizedClass);

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        folderPath: normalizedFolderPath
    };
}

async function renameFolder({ classLevel, folderPath, nextName, allowRoot = false }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedFolderPath = normalizeRelativePath(folderPath, { allowEmpty: false });
    const safeNextName = sanitizeFolderSegment(nextName);
    const classRoot = await ensureClassRoot(normalizedClass);
    const absoluteFolderPath = assertPathInsideRoot(classRoot, path.join(classRoot, normalizedFolderPath));
    const stats = await fsp.stat(absoluteFolderPath);

    if (!stats.isDirectory()) {
        throw new Error("Requested folder does not exist.");
    }

    const parentRelativePath = path.posix.dirname(normalizedFolderPath).replace(/\\/g, "/");
    const isRootSubjectFolder = parentRelativePath === "." || parentRelativePath === "";
    if (isRootSubjectFolder && !allowRoot) {
        throw new Error("Main subject folders cannot be renamed from this route.");
    }

    const parentAbsolutePath = isRootSubjectFolder
        ? classRoot
        : assertPathInsideRoot(classRoot, path.join(classRoot, parentRelativePath));
    const targetAbsolutePath = assertPathInsideRoot(classRoot, path.join(parentAbsolutePath, safeNextName));
    const nextRelativePath = isRootSubjectFolder
        ? safeNextName
        : `${parentRelativePath}/${safeNextName}`.replace(/\\/g, "/");

    if (normalizedFolderPath === nextRelativePath) {
        return {
            classLevel: normalizedClass,
            classDirectory: getClassDirectoryName(normalizedClass),
            folderPath: normalizedFolderPath,
            nextFolderPath: nextRelativePath,
            nextName: safeNextName
        };
    }

    try {
        await fsp.access(targetAbsolutePath, fs.constants.F_OK);
        throw new Error("A folder with this name already exists.");
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }

    await fsp.rename(absoluteFolderPath, targetAbsolutePath);
    invalidateLibraryCaches(normalizedClass);

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        folderPath: normalizedFolderPath,
        nextFolderPath: nextRelativePath,
        nextName: safeNextName
    };
}

async function renameFile({ classLevel, relativePath, nextName }) {
    const normalizedClass = ensureValidClassLevel(classLevel);
    const normalizedRelativePath = normalizeRelativePath(relativePath, { allowEmpty: false });
    const classRoot = await ensureClassRoot(normalizedClass);
    const absoluteFilePath = await resolveAbsoluteFilePath(normalizedClass, normalizedRelativePath);
    const currentParsed = path.parse(absoluteFilePath);
    const currentRelativeDir = path.posix.dirname(normalizedRelativePath).replace(/\\/g, "/");
    const safeRequestedName = sanitizeUploadFileName(nextName);
    const requestedParsed = path.parse(safeRequestedName);
    const nextBaseName = requestedParsed.ext
        ? safeRequestedName
        : `${requestedParsed.name || "file"}${currentParsed.ext || ""}`;
    const nextAbsolutePath = assertPathInsideRoot(classRoot, path.join(currentParsed.dir, nextBaseName));
    const nextRelativePath = currentRelativeDir === "." || currentRelativeDir === ""
        ? nextBaseName
        : `${currentRelativeDir}/${nextBaseName}`.replace(/\\/g, "/");

    if (normalizedRelativePath === nextRelativePath) {
        const fileRecord = await getFileRecord(normalizedClass, nextRelativePath);
        return {
            classLevel: normalizedClass,
            classDirectory: getClassDirectoryName(normalizedClass),
            relativePath: normalizedRelativePath,
            nextRelativePath,
            fileName: nextBaseName,
            file: fileRecord?.file || null
        };
    }

    try {
        await fsp.access(nextAbsolutePath, fs.constants.F_OK);
        throw new Error("A file with this name already exists.");
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }

    await fsp.rename(absoluteFilePath, nextAbsolutePath);
    invalidateLibraryCaches(normalizedClass);
    const stats = await fsp.stat(nextAbsolutePath);
    const fileRecord = createFileRecord({
        classLevel: normalizedClass,
        relativePath: nextRelativePath,
        parentPath: currentRelativeDir === "." ? "" : currentRelativeDir,
        entryName: path.basename(nextAbsolutePath),
        stats
    });

    return {
        classLevel: normalizedClass,
        classDirectory: getClassDirectoryName(normalizedClass),
        relativePath: normalizedRelativePath,
        nextRelativePath,
        fileName: nextBaseName,
        file: fileRecord || null
    };
}

function getMimeType(fileName) {
    const ext = path.extname(String(fileName || "").trim()).toLowerCase();
    const mimeTypes = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".txt": "text/plain; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".zip": "application/zip"
    };

    return mimeTypes[ext] || "application/octet-stream";
}

module.exports = {
    LIBRARY_ROOT,
    getLibraryTree,
    getAllLibraries,
    getFileRecord,
    getSubjectCoverRecord,
    resolveAbsoluteFilePath,
    uploadFile,
    uploadFiles,
    createFolder,
    deleteFile,
    deleteFileByAnyPath,
    deleteFolder,
    renameFolder,
    renameFile,
    normalizeClassLevel,
    normalizeRelativePath,
    sanitizeUploadFileName,
    sanitizeFolderSegment,
    compareNaturalNames,
    getMimeType,
    isImageFile,
    findFolderNode,
    getClassDirectoryName
};
