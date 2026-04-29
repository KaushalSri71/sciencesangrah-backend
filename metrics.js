const INDIA_TIME_ZONE = "Asia/Kolkata";

function buildDashboardMetrics(records) {
    const todayParts = getDateParts(new Date());
    const todaySerial = toDaySerial(todayParts);
    const weekStartSerial = todaySerial - ((getWeekday(todayParts) + 6) % 7);

    let totalRevenue = 0;
    let totalSalesToday = 0;
    let totalSalesThisWeek = 0;
    let totalSalesThisMonth = 0;
    let emiPendingCount = 0;
    let emiPendingAmount = 0;
    const totalStudents = countUniqueStudents(records);
    const studentsJoinedToday = countUniqueStudents(
        records.filter((record) => record.type === "new" && isSameDay(record.date, todayParts))
    );

    records.forEach((record) => {
        const amount = safeNumber(record.amount);
        const pending = safeNumber(record.pending);
        const recordParts = getDateParts(record.date);

        totalRevenue += amount;

        if (recordParts) {
            const recordSerial = toDaySerial(recordParts);

            if (recordSerial === todaySerial) {
                totalSalesToday += amount;
            }

            if (recordSerial >= weekStartSerial && recordSerial <= todaySerial) {
                totalSalesThisWeek += amount;
            }

            if (recordParts.year === todayParts.year && recordParts.month === todayParts.month) {
                totalSalesThisMonth += amount;
            }
        }

        if (pending > 0) {
            emiPendingCount += 1;
            emiPendingAmount += pending;
        }
    });

    return {
        totalRevenue,
        totalSalesToday,
        totalSalesThisWeek,
        totalSalesThisMonth,
        studentsJoinedToday,
        totalStudents,
        emiPendingCount,
        emiPendingAmount,
        weeklySales: totalSalesThisWeek,
        monthlySales: totalSalesThisMonth,
        studentsToday: studentsJoinedToday
    };
}

function buildBatchStats(records) {
    return countBy(records, (record) => record.batch);
}

function buildAgentStats(records) {
    return countBy(records, (record) => record.agent);
}

function buildChatContext(records, metrics, batchStats) {
    const topBatch = Object.entries(batchStats)
        .sort((left, right) => right[1] - left[1])[0]?.[0] || "";

    return {
        todaySales: safeNumber(metrics.totalSalesToday),
        studentsToday: safeNumber(metrics.studentsJoinedToday),
        emiPending: safeNumber(metrics.emiPendingCount),
        topBatch,
        totalRevenue: safeNumber(metrics.totalRevenue),
        totalStudents: safeNumber(metrics.totalStudents),
        recentEntries: records.slice(0, 5).map((record) => ({
            name: record.name,
            batch: record.batch,
            amount: safeNumber(record.amount),
            type: record.type,
            status: record.status,
            date: record.date instanceof Date && !Number.isNaN(record.date.getTime())
                ? record.date.toISOString()
                : null
        }))
    };
}

function countBy(records, selector) {
    return records.reduce((accumulator, record) => {
        const key = String(selector(record) || "").trim();
        if (!key) {
            return accumulator;
        }

        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
    }, {});
}

function countUniqueStudents(records) {
    const students = new Set();

    records.forEach((record) => {
        const identifier = buildStudentIdentifier(record);
        if (identifier) {
            students.add(identifier);
        }
    });

    return students.size;
}

function buildStudentIdentifier(record) {
    const phone = String(record?.phone || "").replace(/\D/g, "");
    if (phone) {
        return `phone:${phone}`;
    }

    const name = String(record?.name || "").trim().toLowerCase();
    if (name) {
        return `name:${name}`;
    }

    return "";
}

function isSameDay(value, expectedParts) {
    const actualParts = getDateParts(value);
    if (!actualParts || !expectedParts) {
        return false;
    }

    return (
        actualParts.year === expectedParts.year
        && actualParts.month === expectedParts.month
        && actualParts.day === expectedParts.day
    );
}

function getDateParts(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return null;
    }

    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: INDIA_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });

    const parts = formatter.formatToParts(value);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);

    if (!year || !month || !day) {
        return null;
    }

    return { year, month, day };
}

function toDaySerial(parts) {
    return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
}

function getWeekday(parts) {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function safeNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
    buildDashboardMetrics,
    buildBatchStats,
    buildAgentStats,
    buildChatContext
};
