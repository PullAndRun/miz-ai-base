import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MizPlugin } from "@/plugins";

const JOKE_DIRECTORY = path.join(process.cwd(), "github", "miHoYoJokes");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const JOKE_COUNT = 10;

const jokePlugin: MizPlugin = {
  name: "joke",
  commands: ["joke"],
  description: "随机发送十张米哈游笑话图片。用法：miz joke",
  async handle({ command, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("用法：miz joke");
      return;
    }

    if (message.groupId === undefined) {
      await reply("该命令仅支持在群内使用。");
      return;
    }

    try {
      const imagePaths = await listJokeImages(JOKE_DIRECTORY);
      const selectedImages = selectRandomImages(imagePaths, JOKE_COUNT);
      if (selectedImages.length < JOKE_COUNT) {
        throw new Error(`Not enough joke images: found ${selectedImages.length}`);
      }

      await replyForward(
        await Promise.all(
          selectedImages.map(async (imagePath) => [
            {
              type: "image",
              data: {
                file: `base64://${(await readFile(imagePath)).toString("base64")}`,
              },
            },
          ]),
        ),
        {
          title: "米哈游笑话",
          source: "miz joke",
          summary: "10 张随机笑话图片",
        },
      );
    } catch (error) {
      logger.error("plugin", "joke images failed to send", error);
      await reply("笑话图片暂时无法发送，请稍后再试。");
    }
  },
};

export default jokePlugin;

const listJokeImages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listJokeImages(entryPath);
      }

      return entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ? [entryPath]
        : [];
    }),
  );
  return files.flat();
};

const selectRandomImages = (imagePaths: readonly string[], count: number) => {
  const shuffled = [...imagePaths];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled.slice(0, count);
};
