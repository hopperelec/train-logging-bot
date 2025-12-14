-- CreateTable
CREATE TABLE "Day" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dayId" INTEGER NOT NULL,
    CONSTRAINT "Message_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "Day" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dayId" INTEGER NOT NULL,
    "trn" TEXT NOT NULL,
    "units" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "notes" TEXT,
    "index" INTEGER NOT NULL DEFAULT 0,
    "withdrawn" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Allocation_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "Day" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Day_date_key" ON "Day"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Allocation_dayId_trn_units_key" ON "Allocation"("dayId", "trn", "units");
