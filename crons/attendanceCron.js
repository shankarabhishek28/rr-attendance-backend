/**
 * Lazy catch-up: marks all PAST attendance records that have a punch-in
 * but no punch-out as "absent". Works on Render Free Tier without node-cron
 * or external schedulers.
 *
 * Only touches records where date < today — today's records are left alone
 * because the employee might still punch out later.
 */
async function markUnpunchedAsAbsent(prisma) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await prisma.attendance.updateMany({
        where: {
            date: { lt: today },          // only past days, not today
            punchInTime: { not: null },
            punchOutTime: null,
            status: { not: "absent" },     // skip already-marked ones
        },
        data: {
            status: "absent",
            workedHours: 0,
        },
    });

    if (result.count > 0) {
        console.log(`[catch-up:mark-absent] Marked ${result.count} past unpunched record(s) as absent.`);
    } else {
        console.log("[catch-up:mark-absent] No past unpunched records found. All clean.");
    }

    return result.count;
}

let lastCheckedDay = null;
let inFlightCleanup = null;

function getLocalDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Runs markUnpunchedAsAbsent at most once per calendar day (and deduplicates
 * concurrent calls). Ensures catch-up still runs when the day rolls over
 * even if the server stays awake past midnight without restarting.
 */
async function ensurePastAbsentMarked(prisma) {
    const todayKey = getLocalDayKey(new Date());
    if (lastCheckedDay === todayKey) {
        return 0;
    }

    if (!inFlightCleanup) {
        inFlightCleanup = markUnpunchedAsAbsent(prisma)
            .then((count) => {
                lastCheckedDay = todayKey;
                return count;
            })
            .finally(() => {
                inFlightCleanup = null;
            });
    }

    return inFlightCleanup;
}

module.exports = { markUnpunchedAsAbsent, ensurePastAbsentMarked };
