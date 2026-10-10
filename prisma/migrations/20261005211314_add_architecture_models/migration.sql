-- CreateTable
CREATE TABLE "Architecture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "summary" TEXT NOT NULL DEFAULT '',
    "frontendArch" TEXT NOT NULL DEFAULT '',
    "backendArch" TEXT NOT NULL DEFAULT '',
    "rationale" TEXT NOT NULL DEFAULT '',
    "directoryTree" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Architecture_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TechnologyStack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "architectureId" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TechnologyStack_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArchitectureModule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "architectureId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "layer" TEXT NOT NULL DEFAULT 'both',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ArchitectureModule_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "architectureId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "module" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "requiresAuth" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ApiDefinition_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PermissionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "architectureId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PermissionRule_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatabaseSchema" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "architectureId" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'MySQL',
    CONSTRAINT "DatabaseSchema_architectureId_fkey" FOREIGN KEY ("architectureId") REFERENCES "Architecture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatabaseTable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "indexesJson" TEXT NOT NULL DEFAULT '[]',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DatabaseTable_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "DatabaseSchema" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatabaseField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tableId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nullable" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isUnique" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DatabaseField_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "DatabaseTable" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DatabaseRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaId" TEXT NOT NULL,
    "fromTable" TEXT NOT NULL,
    "fromField" TEXT NOT NULL,
    "toTable" TEXT NOT NULL,
    "toField" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'one-to-many',
    CONSTRAINT "DatabaseRelation_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "DatabaseSchema" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Architecture_projectId_key" ON "Architecture"("projectId");

-- CreateIndex
CREATE INDEX "Architecture_projectId_idx" ON "Architecture"("projectId");

-- CreateIndex
CREATE INDEX "TechnologyStack_architectureId_idx" ON "TechnologyStack"("architectureId");

-- CreateIndex
CREATE INDEX "ArchitectureModule_architectureId_idx" ON "ArchitectureModule"("architectureId");

-- CreateIndex
CREATE INDEX "ApiDefinition_architectureId_idx" ON "ApiDefinition"("architectureId");

-- CreateIndex
CREATE INDEX "PermissionRule_architectureId_idx" ON "PermissionRule"("architectureId");

-- CreateIndex
CREATE UNIQUE INDEX "DatabaseSchema_architectureId_key" ON "DatabaseSchema"("architectureId");

-- CreateIndex
CREATE INDEX "DatabaseTable_schemaId_idx" ON "DatabaseTable"("schemaId");

-- CreateIndex
CREATE INDEX "DatabaseField_tableId_idx" ON "DatabaseField"("tableId");

-- CreateIndex
CREATE INDEX "DatabaseRelation_schemaId_idx" ON "DatabaseRelation"("schemaId");
