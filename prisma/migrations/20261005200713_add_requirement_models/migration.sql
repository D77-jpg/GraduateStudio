-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "background" TEXT,
    "goals" TEXT NOT NULL DEFAULT '[]',
    "businessFlows" TEXT NOT NULL DEFAULT '[]',
    "nonFunctional" TEXT NOT NULL DEFAULT '[]',
    "boundaries" TEXT NOT NULL DEFAULT '{}',
    "devTasks" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Requirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "UserRole_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priority" TEXT NOT NULL DEFAULT 'should',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Feature_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Feature_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL DEFAULT 'web',
    "techStack" TEXT NOT NULL DEFAULT '[]',
    "stage" TEXT NOT NULL DEFAULT 'topic',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "devLanguage" TEXT,
    "database" TEXT,
    "difficulty" TEXT,
    "needsAi" BOOLEAN NOT NULL DEFAULT false,
    "background" TEXT,
    "goals" TEXT NOT NULL DEFAULT '[]',
    "scores" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("createdAt", "description", "id", "name", "progress", "stage", "status", "techStack", "type", "updatedAt", "userId") SELECT "createdAt", "description", "id", "name", "progress", "stage", "status", "techStack", "type", "updatedAt", "userId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Requirement_projectId_key" ON "Requirement"("projectId");

-- CreateIndex
CREATE INDEX "Requirement_projectId_idx" ON "Requirement"("projectId");

-- CreateIndex
CREATE INDEX "UserRole_requirementId_idx" ON "UserRole"("requirementId");

-- CreateIndex
CREATE INDEX "Feature_requirementId_idx" ON "Feature"("requirementId");

-- CreateIndex
CREATE INDEX "Feature_parentId_idx" ON "Feature"("parentId");
