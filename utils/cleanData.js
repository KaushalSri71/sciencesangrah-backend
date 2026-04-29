const { resolvePaymentState } = require("./paymentStatus");

function normalizeHeader(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function matrixToObjects(matrix, sheetName) {
    if (!Array.isArray(matrix) || matrix.length === 0) {
        return [];
    }

    const [headers, ...rows] = matrix;
    if (!Array.isArray(headers) || headers.length === 0) {
        throw new Error(`${sheetName} sheet is missing header row.`);
    }

    const normalizedHeaders = headers.map(normalizeHeader);

    return rows
        .filter((row) => Array.isArray(row) && row.some((cell) => String(cell || "").trim() !== ""))
        .map((row, index) => {
            const record = {
                __rowNumber: index + 2
            };

            normalizedHeaders.forEach((header, columnIndex) => {
                if (!header) {
                    return;
                }

                record[header] = row[columnIndex];
            });

            return record;
        });
}

function pickValue(row, headerNames) {
    for (const headerName of headerNames) {
        const normalizedHeader = normalizeHeader(headerName);
        if (Object.prototype.hasOwnProperty.call(row, normalizedHeader)) {
            return row[normalizedHeader];
        }
    }

    return "";
}

function normalizeText(value) {
    if (value == null) {
        return "";
    }

    return String(value).trim();
}

function normalizePhone(value) {
    return normalizeText(value).replace(/\.0$/, "");
}

function parseNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    const cleaned = String(value || "")
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "")
        .trim();

    if (!cleaned) {
        return 0;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        return parseNumericDate(value);
    }

    const raw = String(value || "").trim();
    if (!raw) {
        return null;
    }

    if (/^\d+(\.\d+)?$/.test(raw)) {
        return parseNumericDate(Number(raw));
    }

    const match = raw.match(/^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})(?:\s+.*)?$/);
    if (match) {
        let year;
        let month;
        let day;

        const first = Number(match[1]);
        const second = Number(match[2]);
        const third = Number(match[3]);

        if (match[1].length === 4) {
            year = first;
            month = second;
            day = third;
        } else if (match[3].length === 4) {
            year = third;
            day = first;
            month = second;
        } else {
            year = third + 2000;
            day = first;
            month = second;
        }

        if (isValidDateParts(year, month, day)) {
            return new Date(year, month - 1, day);
        }
    }

    const isoCandidate = new Date(raw);
    return Number.isNaN(isoCandidate.getTime()) ? null : isoCandidate;
}

function parseNumericDate(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }

    if (value > 1000000000000) {
        const unixDate = new Date(value);
        return Number.isNaN(unixDate.getTime()) ? null : unixDate;
    }

    if (value > 1000000000 && value < 1000000000000) {
        const unixSecondsDate = new Date(value * 1000);
        return Number.isNaN(unixSecondsDate.getTime()) ? null : unixSecondsDate;
    }

    if (value < 20000 || value > 60000) {
        return null;
    }

    const excelEpoch = Date.UTC(1899, 11, 30);
    const candidate = new Date(excelEpoch + Math.round(value) * 24 * 60 * 60 * 1000);
    return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function isValidDateParts(year, month, day) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
        return false;
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return false;
    }

    const date = new Date(year, month - 1, day);
    return (
        date.getFullYear() === year
        && date.getMonth() === month - 1
        && date.getDate() === day
    );
}

function normalizeSalesRows(rows) {
    return rows.map((row) => {
        const batchFee = parseNumber(pickValue(row, ["Batch Fee", "BatchFee", "Fee"]));
        const feeConcession = parseNumber(pickValue(row, ["Fee Concession", "FeeConcession", "Concession"]));
        const amountReceived = parseNumber(pickValue(row, ["Amount Received", "Amount Recieved", "Received Amount", "AmountReceived", "Amount_Received", "Amount_Recieved"]));
        const rawPending = parseNumber(pickValue(row, ["Amount Due", "Amount_Due", "Due Amount"]));
        const paymentStatus = normalizeText(pickValue(row, ["Payment Status", "PaymentStatus", "Status"]));
        const emi1 = parseNumber(pickValue(row, ["EMI 1", "EMI1", "Emi 1"]));
        const emi2 = parseNumber(pickValue(row, ["EMI 2", "EMI2", "Emi 2"]));
        const emi1Date = parseDate(pickValue(row, ["EMI 1 Date", "EMI1 Date", "Emi 1 Date"]));
        const emi1Status = normalizeText(pickValue(row, ["EMI 1 Status", "EMI1 Status", "Emi 1 Status"]));
        const emi2Date = parseDate(pickValue(row, ["EMI 2 Date", "EMI2 Date", "Emi 2 Date"]));
        const emi2Status = normalizeText(pickValue(row, ["EMI 2 Status", "EMI2 Status", "Emi 2 Status"]));
        const medium = normalizeText(pickValue(row, ["Medium"]));
        const rawUpgrade = normalizeText(pickValue(row, ["UpGrade", "Upgrade"]));
        const statusDetails = [
            pickValue(row, ["Final Status", "FinalStatus"]),
            pickValue(row, ["EMI Status", "EMIStatus"]),
            pickValue(row, ["Remarks", "Remark", "Comment", "Comments", "Notes"])
        ].map(normalizeText);
        const paymentState = resolvePaymentState({
            batchFee,
            feeConcession,
            amountReceived,
            rawStatus: paymentStatus,
            rawPending,
            emi1Amount: emi1,
            emi2Amount: emi2,
            statusHints: statusDetails,
            installmentStatuses: [emi1Status, emi2Status],
            installmentAmounts: [emi1, emi2],
            installmentDates: [emi1Date, emi2Date]
        });

        return {
            date: parseDate(pickValue(row, ["DATE", "Date", "date"])),
            name: normalizeText(pickValue(row, ["Student Name", "StudentName", "Name"])),
            phone: normalizePhone(pickValue(row, ["Phone Number", "PhoneNumber", "Phone", "Mobile"])),
            batch: normalizeText(pickValue(row, ["Batch Name", "BatchName", "Batch"])),
            medium,
            batchFee,
            feeConcession,
            finalFee: paymentState.finalFee,
            amountReceived,
            amount: paymentState.collectedAmount,
            payment_mode: normalizeText(pickValue(row, ["Payment Mode", "PaymentMode", "Mode"])),
            paymentStatus: paymentState.paymentStatus,
            status: paymentState.status,
            agent: normalizeText(pickValue(row, ["Agent Name", "AgentName", "Agent"])),
            pending: paymentState.pending,
            sheetPending: rawPending,
            emi1,
            emi2,
            emi1Date,
            emi1Status,
            emi2Date,
            emi2Status,
            upgrade: rawUpgrade || (paymentState.pending === 0 && /prahar\s*pro/i.test(normalizeText(pickValue(row, ["Batch Name", "BatchName", "Batch"]))) ? "YES" : ""),
            type: "new"
        };
    });
}

function normalizeUpgradeRows(rows) {
    return rows.map((row) => {
        const amountReceived = parseNumber(pickValue(row, ["Received Amount", "Amount Received", "Amount Recieved", "ReceivedAmount", "Amount_Received", "Amount_Recieved"]));
        const paymentState = resolvePaymentState({
            rawStatus: normalizeText(pickValue(row, ["Payment Status", "PaymentStatus", "Status"])),
            rawPending: 0,
            amountReceived
        });

        return {
            date: parseDate(pickValue(row, ["DATE", "Date", "date"])),
            name: normalizeText(pickValue(row, ["Student Name", "StudentName", "Name"])),
            phone: normalizePhone(pickValue(row, ["Phone Number", "PhoneNumber", "Phone", "Mobile"])),
            batch: normalizeText(pickValue(row, ["Upgraded Batch", "UpgradedBatch", "Batch Name", "Batch"])),
            batchFee: 0,
            feeConcession: 0,
            finalFee: paymentState.finalFee || 0,
            amountReceived,
            amount: paymentState.collectedAmount || amountReceived,
            payment_mode: normalizeText(pickValue(row, ["Payment Mode", "PaymentMode", "Mode"])),
            paymentStatus: paymentState.paymentStatus || paymentState.status,
            status: paymentState.status,
            agent: "",
            pending: paymentState.pending,
            emi1: 0,
            emi2: 0,
            type: "upgrade"
        };
    });
}

module.exports = {
    matrixToObjects,
    normalizeSalesRows,
    normalizeUpgradeRows,
    parseDate,
    parseNumber
};
