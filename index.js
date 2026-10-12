require("dotenv/config");
const { requireAuth } = require("./middleware/auth");
const { getDistanceInMeters } = require("./utils/distance");


const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { PrismaClient } = require("./generated/prisma/client.ts");
const { PrismaPg } = require("@prisma/adapter-pg");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const app = express();
const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use(express.json());

app.get("/", (req, res) => {
    res.send("R&R Attendance API is running");
});

app.post("/api/auth/login", async (req, res) => {
    const { employeeId, password } = req.body;

    if (!employeeId || !password) {
        return res.status(400).json({ error: "employeeId and password are required" });
    }

    const user = await prisma.user.findUnique({ where: { employeeId } });
    if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
        { userId: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
    );

    res.json({
        token,
        user: { employeeId: user.employeeId, name: user.name, role: user.role },
    });
});

app.post("/api/attendance/punch", requireAuth, async (req, res) => {
    // Admin accounts do not mark attendance
    if (req.user.role === "admin") {
        return res.status(403).json({ error: "Admin accounts do not mark attendance" });
    }

    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: "latitude and longitude are required" });
    }

    const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: { location: true },
    });

    if (!user.location) {
        return res.status(400).json({ error: "No attendance location assigned to you yet" });
    }

    const distance = getDistanceInMeters(
        latitude,
        longitude,
        user.location.latitude,
        user.location.longitude
    );

    const locationVerified = distance <= user.location.radiusMeters;

    if (!locationVerified) {
        return res.status(403).json({
            error: "You are outside the permitted attendance location.",
            distanceMeters: Math.round(distance),
        });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: user.id, date: today } },
    });

    if (existing) {
        return res.status(409).json({ error: "Attendance already marked for today", attendance: existing });
    }

    const attendance = await prisma.attendance.create({
        data: {
            employeeId: user.id,
            date: today,
            punchInTime: new Date(),
            latitude,
            longitude,
            distanceMeters: distance,
            locationVerified,
            status: "present",
        },
    });

    res.json({ message: "Attendance marked", attendance });
});

// Punch-out endpoint
app.post("/api/attendance/punch-out", requireAuth, async (req, res) => {
    // Admin accounts do not mark attendance
    if (req.user.role === "admin") {
        return res.status(403).json({ error: "Admin accounts do not mark attendance" });
    }

    const { latitude, longitude } = req.body;

    if (latitude === undefined || longitude === undefined) {
        return res.status(400).json({ error: "latitude and longitude are required" });
    }

    const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        include: { location: true },
    });

    if (!user.location) {
        return res.status(400).json({ error: "No attendance location assigned to you yet" });
    }

    // Geofence check (same as punch-in)
    const distance = getDistanceInMeters(
        latitude,
        longitude,
        user.location.latitude,
        user.location.longitude
    );

    const locationVerified = distance <= user.location.radiusMeters;

    if (!locationVerified) {
        return res.status(403).json({
            error: "You are outside the permitted attendance location.",
            distanceMeters: Math.round(distance),
        });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const existing = await prisma.attendance.findUnique({
        where: { employeeId_date: { employeeId: user.id, date: today } },
    });

    if (!existing) {
        return res.status(400).json({ error: "You haven't punched in today" });
    }

    if (existing.punchOutTime) {
        return res.status(409).json({ error: "You have already punched out today", attendance: existing });
    }

    const punchOutTime = new Date();
    const workedMs = punchOutTime - new Date(existing.punchInTime);
    const workedHours = parseFloat((workedMs / 3600000).toFixed(2));

    let status;
    if (workedHours >= 9) {
        status = "present";
    } else if (workedHours >= 4.5) {
        status = "half_day";
    } else {
        status = "absent";
    }

    const updated = await prisma.attendance.update({
        where: { id: existing.id },
        data: { punchOutTime, workedHours, status },
    });

    res.json({ message: "Punched out successfully", attendance: updated });
});

// Employee applies for leave
app.post("/api/leave/apply", requireAuth, async (req, res) => {
    // Admin accounts do not apply for leave
    if (req.user.role === "admin") {
        return res.status(403).json({ error: "Admin accounts do not apply for leave" });
    }

    const { leaveType, startDate, endDate, reason, dayPortion } = req.body;

    if (!leaveType || !startDate || !endDate) {
        return res.status(400).json({ error: "leaveType, startDate, and endDate are required" });
    }

    // Validate dayPortion
    const validPortions = ["full_day", "first_half", "second_half"];
    const portion = dayPortion || "full_day";
    if (!validPortions.includes(portion)) {
        return res.status(400).json({ error: "dayPortion must be one of: full_day, first_half, second_half" });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Half-day leave must be single day
    if (portion !== "full_day") {
        const startNorm = new Date(start); startNorm.setHours(0, 0, 0, 0);
        const endNorm = new Date(end); endNorm.setHours(0, 0, 0, 0);
        if (startNorm.getTime() !== endNorm.getTime()) {
            return res.status(400).json({ error: "Half-day leave must be for a single date (start and end dates must be the same)" });
        }
    }

    const numberOfDays = portion !== "full_day"
        ? 0.5
        : Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;

    const leave = await prisma.leaveRequest.create({
        data: {
            employeeId: req.user.userId,
            leaveType,
            startDate: start,
            endDate: end,
            numberOfDays,
            dayPortion: portion,
            reason,
            status: "pending",
        },
    });

    res.json({ message: "Leave request submitted", leave });
});

// Reporting Person approves/rejects a leave request
app.post("/api/leave/:id/decide", requireAuth, async (req, res) => {
    const { decision } = req.body;

    if (!["approved", "rejected"].includes(decision)) {
        return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    }

    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can approve or reject leave requests" });
    }

    const leave = await prisma.leaveRequest.findUnique({ where: { id: req.params.id } });
    if (!leave) return res.status(404).json({ error: "Leave request not found" });

    const updated = await prisma.leaveRequest.update({
        where: { id: req.params.id },
        data: { status: decision, approverId: req.user.userId },
    });

    res.json({ message: `Leave ${decision}`, leave: updated });
});

app.get("/api/users/me", requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { employeeId: true, name: true, email: true, role: true, locationId: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

app.post("/api/admin/employees", requireAuth, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can create employees" });
    }

    const { name, email, role, locationId, password } = req.body;

    if (!name || !email || !role || !password) {
        return res.status(400).json({ error: "name, email, role, and password are required" });
    }

    try {
        // Find the highest existing employeeId number to avoid gaps causing collisions
        const lastUser = await prisma.user.findMany({
            select: { employeeId: true },
            orderBy: { employeeId: "desc" },
        });
        const lastNum = lastUser.reduce((max, u) => {
            const n = parseInt(u.employeeId.replace("R&R", ""), 10);
            return isNaN(n) ? max : Math.max(max, n);
        }, 0);
        const employeeId = `R&R${String(lastNum + 1).padStart(3, "0")}`;
        const passwordHash = await bcrypt.hash(password, 10);
        let assignedLocationId = locationId || null;
        if (!assignedLocationId) {
            const office = await prisma.location.findFirst();
            assignedLocationId = office ? office.id : null;
        }
        const employee = await prisma.user.create({
            data: { employeeId, name, email, passwordHash, role, locationId: assignedLocationId },
        });

        res.json({
            message: "Employee created",
            employee: { employeeId: employee.employeeId, name: employee.name, email: employee.email, role: employee.role },
        });
    } catch (err) {
        if (err.code === "P2002") {
            const target = err.meta?.target ?? "";
            const field = Array.isArray(target) ? target.join(", ") : String(target);
            if (field.includes("email")) {
                return res.status(409).json({ error: "An account with this email already exists" });
            }
            return res.status(409).json({ error: `Duplicate value on field: ${field}` });
        }
        console.error(err);
        res.status(500).json({ error: "Something went wrong creating this employee" });
    }
});

app.get("/api/leave", requireAuth, async (req, res) => {
    const where = req.user.role === "admin"
        ? {}
        : { employeeId: req.user.userId };

    const leaves = await prisma.leaveRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: { employee: { select: { name: true, employeeId: true } } },
    });

    res.json(leaves);
});

// Admin: see everyone's attendance for a given day (defaults to today)
app.get("/api/admin/attendance", requireAuth, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can view company-wide attendance" });
    }

    const date = req.query.date ? new Date(req.query.date) : new Date();
    date.setHours(0, 0, 0, 0);

    const employees = await prisma.user.findMany({
        where: { role: { not: "admin" } },
        select: {
            employeeId: true,
            name: true,
            attendance: {
                where: { date },
                select: { punchInTime: true, punchOutTime: true, status: true, workedHours: true, distanceMeters: true, locationVerified: true },
            },
        },
    });

    const report = employees.map((e) => ({
        employeeId: e.employeeId,
        name: e.name,
        status: e.attendance[0]?.status || "not_marked",
        punchInTime: e.attendance[0]?.punchInTime || null,
        punchOutTime: e.attendance[0]?.punchOutTime || null,
        workedHours: e.attendance[0]?.workedHours || null,
    }));

    res.json({ date, employees: report });
});

// Attendance history — paginated, date-filtered
app.get("/api/attendance/history", requireAuth, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 30));
    const skip = (page - 1) * pageSize;

    const where = {};

    // Date range filter
    if (req.query.from || req.query.to) {
        where.date = {};
        if (req.query.from) {
            const from = new Date(req.query.from);
            from.setHours(0, 0, 0, 0);
            where.date.gte = from;
        }
        if (req.query.to) {
            const to = new Date(req.query.to);
            to.setHours(23, 59, 59, 999);
            where.date.lte = to;
        }
    }

    // Scope by role
    if (req.user.role !== "admin") {
        // Non-admin: always own records only
        where.employeeId = req.user.userId;
    } else {
        // Admin: can filter by employeeId (the R&R00X string)
        if (req.query.employeeId) {
            const targetUser = await prisma.user.findUnique({
                where: { employeeId: req.query.employeeId },
                select: { id: true },
            });
            if (!targetUser) {
                return res.json({ page, pageSize, total: 0, rows: [] });
            }
            where.employeeId = targetUser.id;
        }
    }

    const [total, rows] = await Promise.all([
        prisma.attendance.count({ where }),
        prisma.attendance.findMany({
            where,
            orderBy: { date: "desc" },
            skip,
            take: pageSize,
            include: {
                employee: { select: { employeeId: true, name: true } },
            },
        }),
    ]);

    res.json({
        page,
        pageSize,
        total,
        rows: rows.map((r) => ({
            date: r.date,
            employeeId: r.employee.employeeId,
            name: r.employee.name,
            punchInTime: r.punchInTime,
            punchOutTime: r.punchOutTime,
            workedHours: r.workedHours,
            status: r.status,
            distanceMeters: r.distanceMeters,
            locationVerified: r.locationVerified,
        })),
    });
});

// Admin: employee summary with attendance + leave aggregation
app.get("/api/admin/summary", requireAuth, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can view employee summary" });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;

    // Date range
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    // Get all non-admin employees (paginated)
    const allEmployees = await prisma.user.findMany({
        where: { role: { not: "admin" } },
        select: { id: true, employeeId: true, name: true },
        orderBy: { employeeId: "asc" },
    });

    const total = allEmployees.length;
    const pagedEmployees = allEmployees.slice(skip, skip + pageSize);

    const rows = await Promise.all(pagedEmployees.map(async (emp) => {
        // Attendance aggregation
        const attendanceRows = await prisma.attendance.findMany({
            where: {
                employeeId: emp.id,
                date: { gte: from, lte: to },
            },
            select: { status: true, workedHours: true },
        });

        let fullDays = 0, halfDays = 0, absentDays = 0, totalHours = 0;
        for (const a of attendanceRows) {
            if (a.status === "present") fullDays++;
            else if (a.status === "half_day") halfDays++;
            else if (a.status === "absent") absentDays++;
            totalHours += a.workedHours || 0;
        }

        // Leave aggregation — only approved and pending, not rejected
        // Leaves that overlap the date range
        const leaveRows = await prisma.leaveRequest.findMany({
            where: {
                employeeId: emp.id,
                status: { in: ["approved", "pending"] },
                startDate: { lte: to },
                endDate: { gte: from },
            },
            select: { numberOfDays: true, status: true },
        });

        let approvedLeaveDays = 0, pendingLeaveDays = 0;
        for (const l of leaveRows) {
            if (l.status === "approved") approvedLeaveDays += l.numberOfDays;
            else if (l.status === "pending") pendingLeaveDays += l.numberOfDays;
        }

        return {
            employeeId: emp.employeeId,
            name: emp.name,
            fullDays,
            halfDays,
            absentDays,
            daysMarked: attendanceRows.length,
            totalHours: parseFloat(totalHours.toFixed(1)),
            approvedLeaveDays,
            pendingLeaveDays,
        };
    }));

    res.json({ page, pageSize, total, rows });
});

// Admin: CSV export
app.get("/api/admin/export", requireAuth, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can export data" });
    }

    const { type } = req.query;
    if (!type || !["attendance", "summary"].includes(type)) {
        return res.status(400).json({ error: "type must be 'attendance' or 'summary'" });
    }

    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    function csvEscape(val) {
        if (val === null || val === undefined) return "";
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    function formatDateCSV(d) {
        if (!d) return "";
        return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    }

    function formatTimeCSV(d) {
        if (!d) return "";
        return new Date(d).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
    }

    if (type === "attendance") {
        const where = { date: { gte: from, lte: to } };

        if (req.query.employeeId) {
            const targetUser = await prisma.user.findUnique({
                where: { employeeId: req.query.employeeId },
                select: { id: true },
            });
            if (targetUser) where.employeeId = targetUser.id;
        }

        const rows = await prisma.attendance.findMany({
            where,
            orderBy: { date: "desc" },
            include: { employee: { select: { employeeId: true, name: true } } },
        });

        const header = "Employee ID,Name,Date,Punch In,Punch Out,Hours Worked,Status,Distance (m),GPS Verified";
        const csvRows = rows.map((r) =>
            [
                csvEscape(r.employee.employeeId),
                csvEscape(r.employee.name),
                csvEscape(formatDateCSV(r.date)),
                csvEscape(formatTimeCSV(r.punchInTime)),
                csvEscape(formatTimeCSV(r.punchOutTime)),
                csvEscape(r.workedHours != null ? r.workedHours.toFixed(1) : ""),
                csvEscape(r.status),
                csvEscape(r.distanceMeters != null ? Math.round(r.distanceMeters) : ""),
                csvEscape(r.locationVerified ? "Yes" : "No"),
            ].join(",")
        );

        const csv = [header, ...csvRows].join("\n");
        const empSuffix = req.query.employeeId ? `_${req.query.employeeId}` : "";
        const filename = `attendance${empSuffix}_${fromStr}_to_${toStr}.csv`;

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(csv);
    }

    if (type === "summary") {
        // Reuse same logic as /api/admin/summary but unpaginated
        const employees = await prisma.user.findMany({
            where: { role: { not: "admin" } },
            select: { id: true, employeeId: true, name: true },
            orderBy: { employeeId: "asc" },
        });

        const header = "Employee ID,Name,Full Days,Half Days,Absent Days,Days Marked,Total Hours,Approved Leave Days,Pending Leave Days";
        const csvRows = await Promise.all(employees.map(async (emp) => {
            const attendanceRows = await prisma.attendance.findMany({
                where: { employeeId: emp.id, date: { gte: from, lte: to } },
                select: { status: true, workedHours: true },
            });

            let fullDays = 0, halfDays = 0, absentDays = 0, totalHours = 0;
            for (const a of attendanceRows) {
                if (a.status === "present") fullDays++;
                else if (a.status === "half_day") halfDays++;
                else if (a.status === "absent") absentDays++;
                totalHours += a.workedHours || 0;
            }

            const leaveRows = await prisma.leaveRequest.findMany({
                where: {
                    employeeId: emp.id,
                    status: { in: ["approved", "pending"] },
                    startDate: { lte: to },
                    endDate: { gte: from },
                },
                select: { numberOfDays: true, status: true },
            });

            let approvedLeaveDays = 0, pendingLeaveDays = 0;
            for (const l of leaveRows) {
                if (l.status === "approved") approvedLeaveDays += l.numberOfDays;
                else if (l.status === "pending") pendingLeaveDays += l.numberOfDays;
            }

            return [
                csvEscape(emp.employeeId),
                csvEscape(emp.name),
                fullDays,
                halfDays,
                absentDays,
                attendanceRows.length,
                totalHours.toFixed(1),
                approvedLeaveDays,
                pendingLeaveDays,
            ].join(",");
        }));

        const csv = [header, ...csvRows].join("\n");
        const filename = `summary_${fromStr}_to_${toStr}.csv`;

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(csv);
    }
});

// List all employees (for admin dropdowns)
app.get("/api/admin/employees", requireAuth, async (req, res) => {
    if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Only Admin can view employee list" });
    }

    const employees = await prisma.user.findMany({
        where: { role: { not: "admin" } },
        select: { employeeId: true, name: true },
        orderBy: { employeeId: "asc" },
    });

    res.json(employees);
});