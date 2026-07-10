import type { MizPlugin } from "@/plugins";
import {
  formatDynamicMessage,
  formatLiveQueryMessage,
  getVtbRepository,
  getVtbDynamics,
  getVtbFanCount,
  getVtbLiveInfo,
  resolveTrackedVtbStreamer,
} from "@/vtb";

const vtbPlugin: MizPlugin = {
  name: "vtb",
  commands: ["vtb"],
  description: "查询 B 站主播直播或动态。用法：miz vtb live 主播名 / miz vtb dynamic 主播名",
  async handle({ command, config, logger, reply, replyForward }) {
    const [type, ...nameParts] = command.args.trim().split(/\s+/);
    const streamerName = nameParts.join(" ").trim();
    if ((type !== "live" && type !== "dynamic") || !streamerName) {
      await reply("用法：miz vtb live 主播名\n或：miz vtb dynamic 主播名");
      return;
    }

    if (!config.vtb.enabled) {
      await reply("VTB 功能当前未启用。");
      return;
    }

    try {
      const repository = await getVtbRepository(config);
      const streamer = await resolveTrackedVtbStreamer(streamerName, config.vtb, repository);
      if (!streamer) {
        await reply(`没有找到主播：${streamerName}`);
        return;
      }

      if (type === "live") {
        const [live, fans] = await Promise.all([
          getVtbLiveInfo(streamer, config.vtb),
          getVtbFanCount(streamer.mid, config.vtb),
        ]);
        await reply([
          {
            type: "text",
            data: {
              text: [
                formatLiveQueryMessage(live, fans),
              ].join("\n"),
            },
          },
          ...(live.coverUrl
            ? [
                {
                  type: "image",
                  data: { file: live.coverUrl },
                },
              ]
            : []),
        ]);
        return;
      }

      const feed = await getVtbDynamics(streamer, config.vtb);
      await replyForward(feed.items.map(formatDynamicMessage), {
        title: `${streamer.name} 的最新动态`,
        source: "miz vtb dynamic",
        summary: `${feed.items.length} 条动态`,
      });
    } catch (error) {
      logger.error("plugin", "vtb query failed", error);
      await reply("主播信息暂时无法获取，请稍后再试。");
    }
  },
};

export default vtbPlugin;
