CREATE TABLE "activities" (
    "id" SERIAL NOT NULL,
    "group_id" TEXT NOT NULL,
    "display_id" INTEGER NOT NULL,
    "creator_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "event_at" TIMESTAMP(3) NOT NULL,
    "remind_at" TIMESTAMP(3) NOT NULL,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "activity_registrations" (
    "activity_id" INTEGER NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_registrations_pkey" PRIMARY KEY ("activity_id", "user_id")
);

CREATE TABLE "faq_entries" (
    "id" SERIAL NOT NULL,
    "group_id" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "group_todos" (
    "id" SERIAL NOT NULL,
    "group_id" TEXT NOT NULL,
    "display_id" INTEGER NOT NULL,
    "creator_id" TEXT NOT NULL,
    "assignee_id" TEXT,
    "content" TEXT NOT NULL,
    "due_at" TIMESTAMP(3),
    "remind_at" TIMESTAMP(3),
    "reminded_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_todos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "activities_group_id_display_id_key" ON "activities"("group_id", "display_id");
CREATE INDEX "activities_reminded_at_remind_at_idx" ON "activities"("reminded_at", "remind_at");
CREATE INDEX "activities_group_id_event_at_idx" ON "activities"("group_id", "event_at");
CREATE UNIQUE INDEX "faq_entries_group_id_keyword_key" ON "faq_entries"("group_id", "keyword");
CREATE INDEX "faq_entries_group_id_updated_at_idx" ON "faq_entries"("group_id", "updated_at");
CREATE UNIQUE INDEX "group_todos_group_id_display_id_key" ON "group_todos"("group_id", "display_id");
CREATE INDEX "group_todos_group_id_completed_at_due_at_idx" ON "group_todos"("group_id", "completed_at", "due_at");
CREATE INDEX "group_todos_completed_at_reminded_at_remind_at_idx" ON "group_todos"("completed_at", "reminded_at", "remind_at");

ALTER TABLE "activity_registrations"
ADD CONSTRAINT "activity_registrations_activity_id_fkey"
FOREIGN KEY ("activity_id") REFERENCES "activities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
