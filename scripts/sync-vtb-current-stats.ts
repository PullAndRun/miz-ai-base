import pg from "pg";
import { loadConfig } from "@/config";
import { getDatabaseUrl } from "@/database";
import { getVtbGuardSnapshot, getVtbLiveStats, getVtbRepository } from "@/vtb";

const config = await loadConfig();
const databaseUrl = getDatabaseUrl(config);
const pool = new pg.Pool({ connectionString: databaseUrl });
const repository = await getVtbRepository(config);

try {
  const streamers = await repository.listStreamers();
  const sessions = await pool.query<{ streamer_mid: string; live_room: string | null }>(
    "select streamer_mid::text, live_room::text from vtb_live_sessions",
  );
  const sessionRooms = new Map(sessions.rows.map((row) => [row.streamer_mid, row.live_room]));
  const summary = { updated: 0, skipped: 0, failed: 0 };

  for (const streamer of streamers) {
    const roomId = sessionRooms.get(streamer.mid) ?? streamer.roomId ?? undefined;
    if (!sessionRooms.has(streamer.mid) || !roomId) {
      summary.skipped += 1;
      console.log(`SKIP ${streamer.name} (${streamer.mid}): no saved live session or room id`);
      continue;
    }

    try {
      const stats = await getVtbLiveStats(streamer.mid, config.vtb);
      const guards = await getVtbGuardSnapshot(roomId, streamer.mid, config.vtb);
      if (stats.fans === undefined) {
        summary.skipped += 1;
        console.log(`SKIP ${streamer.name} (${streamer.mid}): follower count unavailable`);
        continue;
      }
      await pool.query(
        `update vtb_live_sessions set
           start_fans = $1, start_fan_club = $2, start_guards = $3,
           start_guard_ids = $4, start_guard_names = $5, start_guard_snapshot_captured = $6,
           end_fans = $1, end_fan_club = $2, end_guards = $3,
           end_guard_ids = $4, end_guard_names = $5, end_guard_snapshot_captured = $6
         where streamer_mid = $7`,
        [stats.fans, stats.fanClub ?? null, guards.ids.length, guards.ids, guards.names, guards.captured, streamer.mid],
      );
      summary.updated += 1;
      console.log(`OK ${streamer.name} (${streamer.mid}): fans=${stats.fans}, fanClub=${stats.fanClub ?? "null"}, guards=${guards.ids.length}, guardNames=${guards.names.length}`);
    } catch (error) {
      summary.failed += 1;
      console.error(`FAIL ${streamer.name} (${streamer.mid}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`SUMMARY updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`);
} finally {
  await pool.end();
  await repository.close();
}
