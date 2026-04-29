function normalizePaymentStatusText(value) {
    return String(value || "").trim();
}

function safeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function hasStatusPattern(value, patterns) {
    const normalized = normalizePaymentStatusText(value).toLowerCase();
    if (!normalized) {
        return false;
    }

    return patterns.some((pattern) => pattern.test(normalized));
}

const CLEARED_STATUS_PATTERNS = [
    /\bpaid\b/,
    /\bsuccess(?:ful)?\b/,
    /\bcomplete(?:d)?\b/,
    /\bcaptured\b/,
    /\bsettled\b/,
    /\bclear(?:ed)?\b/,
    /\bdone\b/,
    /\bclosed\b/,
    /\bno\s*dues?\b/,
    /\bzero\s*due\b/,
    /\bdues?\s*clear(?:ed)?\b/,
    /\bfully\s*paid\b/,
    /\bfull\s*paid\b/,
    /\bemi\s*clear(?:ed)?\b/
];

const PENDING_STATUS_PATTERNS = [
    /\bdue\b/,
    /\bpending\b/,
    /\bpartial\b/,
    /\bbalance\b/,
    /\bremaining\b/,
    /\bunpaid\b/,
    /\boverdue\b/,
    /\bemi\s*pending\b/
];

function isClearedPaymentStatus(value) {
    return hasStatusPattern(value, CLEARED_STATUS_PATTERNS);
}

function isPendingPaymentStatus(value) {
    return hasStatusPattern(value, PENDING_STATUS_PATTERNS);
}

function clampNonNegative(value) {
    return Math.max(safeNumber(value), 0);
}

function isClosedEmi2Status(value) {
    return /\bclosed\b/i.test(normalizePaymentStatusText(value));
}

function hasEmiSettlementSignal(values) {
    return uniqueStatusValues(values).some((value) => (
        /\b(emi|clear(?:ed)?|done|closed|no\s*dues?|zero\s*due)\b/i.test(value)
    ));
}

function uniqueStatusValues(values) {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
        .map((value) => normalizePaymentStatusText(value))
        .filter((value) => {
            if (!value) {
                return false;
            }

            const key = value.toLowerCase();
            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
}

function getPreferredClearedLabel(statuses) {
    const primary = uniqueStatusValues(statuses).find((status) => (
        /\b(emi|clear(?:ed)?|done|closed|no\s*dues?)\b/i.test(status)
    ));

    if (primary && /\bemi\b/i.test(primary)) {
        return "EMI Cleared";
    }

    if (primary && /\b(no\s*dues?|clear(?:ed)?|done|closed)\b/i.test(primary)) {
        return "EMI Cleared";
    }

    return "PAID";
}

function getPreferredPendingLabel(statuses) {
    const primary = uniqueStatusValues(statuses)[0] || "";
    if (/\boverdue\b/i.test(primary)) {
        return "Overdue";
    }
    if (/\bpartial\b/i.test(primary)) {
        return "Partial";
    }
    return "Due";
}

function hasAllActiveInstallmentsCleared(installmentStatuses, installmentAmounts) {
    const statuses = Array.isArray(installmentStatuses) ? installmentStatuses : [];
    const amounts = Array.isArray(installmentAmounts) ? installmentAmounts : [];
    const total = Math.max(statuses.length, amounts.length);
    let activeCount = 0;
    let clearedCount = 0;

    for (let index = 0; index < total; index += 1) {
        const status = normalizePaymentStatusText(statuses[index]);
        const amount = safeNumber(amounts[index]);
        const active = Boolean(status) || amount > 0;

        if (!active) {
            continue;
        }

        activeCount += 1;
        if (isClearedPaymentStatus(status)) {
            clearedCount += 1;
        }
    }

    return activeCount > 0 && activeCount === clearedCount;
}

function resolveLegacyPaymentState(options = {}) {
    const rawPending = safeNumber(options.rawPending);
    const rawStatus = normalizePaymentStatusText(options.rawStatus);
    const statusHints = uniqueStatusValues([rawStatus, ...(options.statusHints || [])]);
    const installmentStatuses = uniqueStatusValues(options.installmentStatuses || []);
    const installmentAmounts = Array.isArray(options.installmentAmounts) ? options.installmentAmounts : [];

    const explicitCleared = statusHints.some(isClearedPaymentStatus);
    const explicitPending = statusHints.some(isPendingPaymentStatus);
    const installmentsCleared = hasAllActiveInstallmentsCleared(installmentStatuses, installmentAmounts);

    if (explicitCleared || (installmentsCleared && !explicitPending) || (rawPending <= 0 && !explicitPending)) {
        return {
            pending: 0,
            status: getPreferredClearedLabel([...statusHints, ...installmentStatuses]),
            statusKind: "cleared"
        };
    }

    if (explicitPending || rawPending > 0) {
        return {
            pending: rawPending,
            status: getPreferredPendingLabel(statusHints),
            statusKind: "pending"
        };
    }

    return {
        pending: 0,
        status: rawStatus || "",
        statusKind: rawStatus ? "unknown" : "cleared",
        collectedAmount: safeNumber(options.amountReceived),
        paymentStatus: rawStatus || "",
        finalFee: 0
    };
}

function resolvePaymentState(options = {}) {
    const batchFee = safeNumber(options.batchFee);
    const feeConcession = safeNumber(options.feeConcession);
    const amountReceived = safeNumber(options.amountReceived);
    const rawPending = safeNumber(options.rawPending);
    const rawStatus = normalizePaymentStatusText(options.rawStatus);
    const statusHints = uniqueStatusValues([rawStatus, ...(options.statusHints || [])]);
    const emi1Amount = safeNumber(options.emi1Amount);
    const emi2AmountRaw = safeNumber(options.emi2Amount);
    const installmentStatuses = options.installmentStatuses || [];
    const emi1Status = normalizePaymentStatusText(installmentStatuses[0]);
    const emi2Status = normalizePaymentStatusText(installmentStatuses[1]);
    const installmentDates = options.installmentDates || [];
    const hasFeeInputs = batchFee > 0 || feeConcession > 0 || amountReceived > 0;

    if (!hasFeeInputs) {
        return resolveLegacyPaymentState(options);
    }

    const finalFee = clampNonNegative(batchFee - feeConcession);
    const formulaPending = clampNonNegative(finalFee - amountReceived);
    const paymentStatus = amountReceived >= finalFee ? "PAID" : "DUE";
    const explicitCleared = statusHints.some(isClearedPaymentStatus);
    const explicitPending = statusHints.some(isPendingPaymentStatus);
    const emi1Completed = isClearedPaymentStatus(emi1Status);
    const emi2Completed = isClearedPaymentStatus(emi2Status);
    const emi2Closed = isClosedEmi2Status(emi2Status);
    const emiFieldsPresent = (
        emi1Amount > 0
        || emi2AmountRaw > 0
        || Boolean(emi1Status)
        || Boolean(emi2Status)
        || (Array.isArray(installmentDates) && installmentDates.some((value) => Boolean(normalizePaymentStatusText(value))))
    );

    const emi2Amount = emi2AmountRaw > 0
        ? emi2AmountRaw
        : clampNonNegative(formulaPending - emi1Amount);

    let collectedAmount = amountReceived;
    let pending = formulaPending;
    let status = paymentStatus === "PAID" ? "PAID" : "Due";
    let statusKind = paymentStatus === "PAID" ? "cleared" : "pending";

    if (emi1Completed) {
        collectedAmount += emi1Amount;
        pending = clampNonNegative(finalFee - collectedAmount);
    }

    // Core rule: EMI 2 CLOSED means full payment is complete, so no due can remain.
    if (emi2Closed) {
        pending = 0;
        collectedAmount = Math.max(collectedAmount + emi2Amount, finalFee);
    } else if (emi2Completed) {
        collectedAmount += emi2Amount;
        pending = 0;
    }

    if (emi1Completed && emi1Amount >= formulaPending) {
        pending = 0;
        collectedAmount = Math.max(collectedAmount, finalFee);
    }

    if (explicitCleared) {
        pending = 0;
        collectedAmount = Math.max(collectedAmount, finalFee);
    }

    if (pending <= 0) {
        pending = 0;
        collectedAmount = Math.max(collectedAmount, finalFee);
        status = (hasEmiSettlementSignal([...statusHints, emi1Status, emi2Status]) || emi1Completed || emi2Completed)
            ? "EMI Cleared"
            : "PAID";
        statusKind = "cleared";
    } else if (explicitPending || paymentStatus === "DUE" || rawPending > 0) {
        if (/\boverdue\b/i.test(rawStatus)) {
            status = "Overdue";
        } else if (/\bpartial\b/i.test(rawStatus)) {
            status = "Partial";
        } else {
            status = "Due";
        }
        statusKind = "pending";
    } else if (rawStatus) {
        status = rawStatus;
        statusKind = "unknown";
    }

    // If fee formula and EMI fields disagree with the stale due/status cells, trust the completed EMI trail.
    if (!explicitCleared && emiFieldsPresent && !emi1Completed && !emi2Completed && rawPending > 0) {
        pending = Math.max(pending, rawPending);
    }

    return {
        pending,
        status,
        statusKind,
        collectedAmount,
        paymentStatus,
        finalFee
    };
}

module.exports = {
    isClearedPaymentStatus,
    isPendingPaymentStatus,
    normalizePaymentStatusText,
    resolvePaymentState
};
