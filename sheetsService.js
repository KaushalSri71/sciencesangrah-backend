const {
    matrixToObjects,
    normalizeSalesRows,
    normalizeUpgradeRows
} = require("../utils/cleanData");
const {
    buildDashboardMetrics,
    buildBatchStats,
    buildAgentStats,
    buildChatContext
} = require("../utils/metrics");

const CACHE_TTL_MS = 30 * 1000;
const SHEET_FETCH_TIMEOUT_MS = 15 * 1000;

const dashboardCache = {
    value: null,
    fetchedAt: 0,
    expiresAt: 0,
    inFlightPromise: null
};

async function getDashboardPayload(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const maxAgeMs = resolveMaxAgeMs(options.maxAgeMs, CACHE_TTL_MS);
    const now = Date.now();
    const cacheAge = dashboardCache.fetchedAt ? now - dashboardCache.fetchedAt : Number.POSITIVE_INFINITY;

    if (!forceRefresh && dashboardCache.value && cacheAge <= maxAgeMs) {
        return clonePayload(dashboardCache.value, {
            servedFromCache: true,
            cacheAgeMs: cacheAge
        });
    }

    if (dashboardCache.inFlightPromise) {
        return dashboardCache.inFlightPromise;
    }

    dashboardCache.inFlightPromise = buildDashboardPayload()
        .then((payload) => {
            const fetchedAt = Date.now();
            dashboardCache.value = payload;
            dashboardCache.fetchedAt = fetchedAt;
            dashboardCache.expiresAt = fetchedAt + CACHE_TTL_MS;
            return clonePayload(payload, {
                servedFromCache: false,
                cacheAgeMs: 0
            });
        })
        .catch((error) => {
            if (dashboardCache.value) {
                return clonePayload(dashboardCache.value, {
                    servedFromCache: true,
                    cacheAgeMs: dashboardCache.fetchedAt ? Math.max(Date.now() - dashboardCache.fetchedAt, 0) : null,
                    staleFallback: true,
                    staleReason: error.message || "Live sheet refresh failed."
                });
            }

            throw error;
        })
        .finally(() => {
            dashboardCache.inFlightPromise = null;
        });

    return dashboardCache.inFlightPromise;
}

async function getChatContextPayload(options = {}) {
    const dashboardPayload = await getDashboardPayload(options);
    return buildChatContext(
        dashboardPayload.data,
        dashboardPayload.metrics,
        dashboardPayload.batchStats
    );
}

async function buildDashboardPayload() {
    const [salesSource, upgradeSource] = await Promise.all([
        fetchSheetSource(process.env.SALES_2026_27, "SALES_2026_27"),
        fetchSheetSource(process.env.UpGrade || process.env.UPGRADE_URL, "UpGrade")
    ]);

    const salesRecords = normalizeSalesRows(matrixToObjects(salesSource.matrix, "SALES"));
    const upgradeRecords = normalizeUpgradeRows(matrixToObjects(upgradeSource.matrix, "UpGrade"));
    const finalData = [...salesRecords, ...upgradeRecords].sort(sortByDateDesc);
    const latestRecordDate = getLatestRecordDate(finalData);
    const syncedAt = new Date().toISOString();

    return {
        metrics: buildDashboardMetrics(finalData),
        batchStats: buildBatchStats(finalData),
        agentStats: buildAgentStats(finalData),
        data: finalData,
        meta: {
            syncedAt,
            latestRecordDate,
            totalRecords: finalData.length,
            sources: [
                summarizeSource(salesSource),
                summarizeSource(upgradeSource)
            ]
        }
    };
}

async function fetchSheetSource(rawUrl, label) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLESHEET_KEY_SECRET || "";
    const url = buildSheetUrl(rawUrl, apiKey, label);
    if (!url) {
        const error = new Error(`${label} is not configured.`);
        error.statusCode = 500;
        throw error;
    }

    let response;

    try {
        response = await fetch(url, {
            headers: {
                Accept: "application/json, text/plain, text/csv;q=0.9, */*;q=0.8"
            },
            signal: createTimeoutSignal(SHEET_FETCH_TIMEOUT_MS)
        });
    } catch (error) {
        const networkError = new Error(`Unable to reach ${label}. ${error.message}`);
        networkError.statusCode = 502;
        throw networkError;
    }

    const rawBody = await response.text();

    if (!response.ok) {
        const fetchError = new Error(`${label} request failed with status ${response.status}.`);
        fetchError.statusCode = 502;
        fetchError.details = rawBody.slice(0, 250);
        throw fetchError;
    }

    const matrix = parseSheetMatrix(rawBody, label, response.headers.get("content-type"));

    if (!Array.isArray(matrix)) {
        const shapeError = new Error(`${label} did not return sheet rows in array format.`);
        shapeError.statusCode = 502;
        throw shapeError;
    }

    return {
        label,
        url,
        matrix,
        fetchedAt: new Date().toISOString()
    };
}

function parseSheetMatrix(rawBody, label, contentType = "") {
    const payload = readStructuredSheetPayload(rawBody, label);
    const matrix = extractMatrix(payload);

    if (Array.isArray(matrix)) {
        return matrix;
    }

    if (looksDelimited(contentType, rawBody)) {
        return parseDelimitedMatrix(rawBody);
    }

    const parseError = new Error(`${label} did not return a supported sheet format.`);
    parseError.statusCode = 502;
    throw parseError;
}

function readStructuredSheetPayload(rawBody, label) {
    try {
        return JSON.parse(rawBody);
    } catch (error) {
        const visualizationPayload = extractGoogleVisualizationPayload(rawBody);
        if (visualizationPayload) {
            return visualizationPayload;
        }

        return null;
    }
}

function buildSheetUrl(rawUrl, apiKey, label) {
    const trimmed = String(rawUrl || "").trim();
    if (!trimmed) {
        return "";
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(trimmed);
    } catch (_) {
        return trimmed;
    }

    if (/(^|\.)docs\.google\.com$/i.test(parsedUrl.hostname)) {
        const spreadsheetId = extractSpreadsheetId(parsedUrl.pathname);
        if (spreadsheetId) {
            const range = encodeURIComponent(label);
            const apiUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`);
            if (apiKey) {
                apiUrl.searchParams.set("key", apiKey);
            }
            return apiUrl.toString();
        }
    }

    const isGoogleApiUrl = /(^|\.)googleapis\.com$/i.test(parsedUrl.hostname);
    if (isGoogleApiUrl && apiKey && !parsedUrl.searchParams.has("key")) {
        parsedUrl.searchParams.set("key", apiKey);
    }

    return parsedUrl.toString();
}

function createTimeoutSignal(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortSignal === "undefined") {
        return undefined;
    }

    if (typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(timeoutMs);
    }

    return undefined;
}

function resolveMaxAgeMs(candidate, fallbackMs) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
    }

    return fallbackMs;
}

function clonePayload(payload, metaPatch = {}) {
    return {
        ...payload,
        meta: {
            ...(payload?.meta || {}),
            ...metaPatch
        }
    };
}

function summarizeSource(source) {
    const rowCount = Array.isArray(source?.matrix) ? Math.max(source.matrix.length - 1, 0) : 0;
    return {
        label: source?.label || "",
        rowCount,
        fetchedAt: source?.fetchedAt || null
    };
}

function getLatestRecordDate(records) {
    const latestRecord = (Array.isArray(records) ? records : []).find((record) => (
        record?.date instanceof Date && !Number.isNaN(record.date.getTime())
    ));

    return latestRecord?.date ? latestRecord.date.toISOString() : null;
}

function extractMatrix(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }

    if (Array.isArray(payload?.values)) {
        return payload.values;
    }

    if (payload?.table?.cols && payload?.table?.rows) {
        return convertGoogleVisualizationTable(payload.table);
    }

    return null;
}

function extractGoogleVisualizationPayload(rawBody) {
    const raw = String(rawBody || "").trim();
    const match = raw.match(/google\.visualization\.Query\.setResponse\(([\s\S]+)\);\s*$/);
    if (!match) {
        return null;
    }

    const jsonLike = match[1].replace(/\bDate\(([^)]*)\)/g, (_fullMatch, dateArgs) => `"Date(${dateArgs})"`);

    try {
        return JSON.parse(jsonLike);
    } catch (_) {
        return null;
    }
}

function convertGoogleVisualizationTable(table) {
    const columns = Array.isArray(table?.cols) ? table.cols : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const headers = columns.map((column, index) => String(column?.label || column?.id || `column_${index + 1}`));

    const matrix = rows.map((row) => {
        const cells = Array.isArray(row?.c) ? row.c : [];
        return columns.map((column, index) => normalizeVisualizationCell(cells[index], column));
    });

    return [headers, ...matrix];
}

function normalizeVisualizationCell(cell, column) {
    if (!cell || cell.v == null) {
        return "";
    }

    const value = cell.v;
    if (typeof value === "string" && /^Date\((.*)\)$/.test(value)) {
        return parseVisualizationDateToken(value) || cell.f || value;
    }

    if (column?.type === "date" || column?.type === "datetime") {
        return parseVisualizationDateToken(String(value)) || cell.f || value;
    }

    return value;
}

function parseVisualizationDateToken(value) {
    const match = String(value || "").match(/^Date\((.*)\)$/);
    if (!match) {
        return null;
    }

    const parts = match[1]
        .split(",")
        .map((part) => Number(String(part || "").trim()))
        .filter((part) => Number.isFinite(part));

    if (parts.length < 3) {
        return null;
    }

    return new Date(
        parts[0],
        parts[1],
        parts[2],
        parts[3] || 0,
        parts[4] || 0,
        parts[5] || 0
    );
}

function looksDelimited(contentType, rawBody) {
    const normalizedContentType = String(contentType || "").toLowerCase();
    if (normalizedContentType.includes("csv") || normalizedContentType.includes("tsv")) {
        return true;
    }

    const sample = String(rawBody || "").trim();
    return Boolean(sample && (sample.includes(",") || sample.includes("\t")) && sample.includes("\n"));
}

function parseDelimitedMatrix(rawBody) {
    const text = String(rawBody || "").replace(/^\uFEFF/, "");
    const delimiter = text.includes("\t") && !text.includes(",") ? "\t" : ",";
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
    return lines.map((line) => splitDelimitedLine(line, delimiter));
}

function splitDelimitedLine(line, delimiter) {
    const output = [];
    let current = "";
    let insideQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const nextChar = line[index + 1];

        if (char === "\"") {
            if (insideQuotes && nextChar === "\"") {
                current += "\"";
                index += 1;
            } else {
                insideQuotes = !insideQuotes;
            }
            continue;
        }

        if (char === delimiter && !insideQuotes) {
            output.push(current);
            current = "";
            continue;
        }

        current += char;
    }

    output.push(current);
    return output.map((value) => value.trim());
}

function extractSpreadsheetId(pathname) {
    const match = String(pathname || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : "";
}

function sortByDateDesc(left, right) {
    const leftTime = left.date instanceof Date && !Number.isNaN(left.date.getTime())
        ? left.date.getTime()
        : 0;
    const rightTime = right.date instanceof Date && !Number.isNaN(right.date.getTime())
        ? right.date.getTime()
        : 0;
    return rightTime - leftTime;
}

module.exports = {
    getDashboardPayload,
    getChatContextPayload
};
