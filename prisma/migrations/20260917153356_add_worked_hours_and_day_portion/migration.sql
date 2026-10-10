-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "workedHours" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "dayPortion" TEXT NOT NULL DEFAULT 'full_day',
ALTER COLUMN "numberOfDays" SET DATA TYPE DOUBLE PRECISION;
