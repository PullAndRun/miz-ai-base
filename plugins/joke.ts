import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { MizPlugin } from "@/plugins";

const JOKE_DIRECTORY = path.join(process.cwd(), "github", "miHoYoJokes");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const JOKE_COUNT = 10;
let jokeImagesPromise: Promise<readonly string[]> | undefined;

const jokePlugin: MizPlugin = {
  name: "joke",
  commands: ["joke"],
  description: "随机抽一组米哈游笑话图，每次十连，张张不重复。\n用法：miz joke",
  async handle({ command, logger, message, reply, replyForward }) {
    if (command.args) {
      await reply("🎲 十连不需要追加内容，直接发 miz joke 就能开抽。");
      return;
    }

    if (message.groupId === undefined) {
      await reply("这份笑话图十连要和群友一起看，回群里再抽吧。");
      return;
    }

    try {
      const imagePaths = await getJokeImages();
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
          title: "🎲 米游笑话图 · 十连",
          source: "miz joke",
          summary: "十连已送达",
        },
      );
    } catch (error) {
      logger.error("plugin", "joke images failed to send", error);
      await reply("图库刚才卡了一下，这次十连先欠着，晚点再抽吧。");
    }
  },
};

export default jokePlugin;

const getJokeImages = () => {
  if (!jokeImagesPromise) {
    jokeImagesPromise = listJokeImages(JOKE_DIRECTORY).catch((error) => {
      jokeImagesPromise = undefined;
      throw error;
    });
  }

  return jokeImagesPromise;
};

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
