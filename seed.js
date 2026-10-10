require("dotenv/config");
const { PrismaClient } = require("./generated/prisma/client.ts");
const { PrismaPg } = require("@prisma/adapter-pg");
const bcrypt = require("bcrypt");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });
async function main() {
    const passwordHash = await bcrypt.hash("Admin@123", 10);

    const admin = await prisma.user.upsert({
        where: { employeeId: "R&R001" },
        update: {},
        create: {
            employeeId: "R&R001",
            name: "Admin User",
            email: "admin@restonroute.com",
            passwordHash,
            role: "admin",
        },
    });

    const office = await prisma.location.findFirst({ where: { name: "Reston Route Office" } });

    const manager = await prisma.user.upsert({
        where: { employeeId: "R&R002" },
        update: {},
        create: {
            employeeId: "R&R002",
            name: "Amit Kumar",
            email: "amit@restonroute.com",
            passwordHash,
            role: "employee",
            locationId: office.id,
        },
    });

    const employee = await prisma.user.upsert({
        where: { employeeId: "R&R003" },
        update: {},
        create: {
            employeeId: "R&R003",
            name: "Rahul Sharma",
            email: "rahul@restonroute.com",
            passwordHash,
            role: "employee",
            locationId: office.id,
        },
    });

    console.log({ admin: admin.employeeId, manager: manager.employeeId, employee: employee.employeeId });
}
main()
    .catch((e) => console.error(e))
    .finally(() => prisma.$disconnect());