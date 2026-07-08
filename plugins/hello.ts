import type { MizPlugin } from "@/plugins";

const helloPlugin: MizPlugin = {
  name: "hello",
  commands: ["hello"],
  description: "回复 world，用于测试插件系统是否正常工作",
  async handle({ reply }) {
    await reply("world");
  },
};

export default helloPlugin;
