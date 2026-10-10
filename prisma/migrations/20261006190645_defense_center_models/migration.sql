-- CreateTable
CREATE TABLE "DefenseQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '综合',
    "question" TEXT NOT NULL,
    "expectedPoints" TEXT NOT NULL DEFAULT '[]',
    "difficulty" TEXT NOT NULL DEFAULT '进阶',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DefenseQuestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DefenseSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "overallScore" INTEGER,
    "summary" TEXT NOT NULL DEFAULT '',
    "weakPoints" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "DefenseSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DefenseTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "question" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '综合',
    "isFollowup" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT NOT NULL DEFAULT '',
    "scores" TEXT NOT NULL DEFAULT '{}',
    "comment" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DefenseTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DefenseSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DefenseMaterial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ppt_outline',
    "content" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DefenseMaterial_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DefenseQuestion_projectId_status_idx" ON "DefenseQuestion"("projectId", "status");

-- CreateIndex
CREATE INDEX "DefenseSession_projectId_createdAt_idx" ON "DefenseSession"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "DefenseTurn_sessionId_index_idx" ON "DefenseTurn"("sessionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "DefenseMaterial_projectId_kind_key" ON "DefenseMaterial"("projectId", "kind");
