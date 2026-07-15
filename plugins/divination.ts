import type { MizPlugin } from "@/plugins";

const fortunes = [
  { name: "大吉", hint: "今天适合把想了很久的事往前推一步，开头比想象中轻松。" },
  { name: "大吉", hint: "会遇到一个让心情变好的小插曲，记得接住这份好运。" },
  { name: "大吉", hint: "今天的直觉很准，犹豫时可以多相信自己的第一反应。" },
  { name: "吉", hint: "先做最重要的那一件，剩下的事情会自然排好顺序。" },
  { name: "吉", hint: "适合主动联系许久没说话的人，话题会比预想中自然。" },
  { name: "吉", hint: "今天的好运藏在细节里，多看一眼就可能发现惊喜。" },
  { name: "吉", hint: "按自己的节奏走就好，不必为了赶上别人打乱步子。" },
  { name: "小吉", hint: "手头的小事会一件件解决，别被刚开始的混乱吓到。" },
  { name: "小吉", hint: "适合给计划留一点空白，临时出现的灵感值得一试。" },
  { name: "小吉", hint: "今天不需要做得完美，完成比反复修改更重要。" },
  { name: "小吉", hint: "一句真诚的回应会带来不错的结果，不用想得太复杂。" },
  { name: "平", hint: "今天适合稳稳推进，不抢速度，也别轻易放弃。" },
  { name: "平", hint: "遇到拿不准的事先放十分钟，回来时答案会清楚一些。" },
  { name: "平", hint: "把注意力收回到眼前，做好手边这一步就已经足够。" },
  { name: "平", hint: "少看一点无关消息，今天会过得轻松不少。" },
  { name: "小凶", hint: "今天容易因为着急漏掉细节，发出消息前多检查一遍。" },
  { name: "小凶", hint: "别把所有安排塞得太满，留一点余地会更从容。" },
  { name: "小凶", hint: "碰到不顺时先停一下，不必在情绪最满的时候做决定。" },
  { name: "小凶", hint: "今天不适合硬撑，累了就早点收工，明天再继续。" },
] as const;

const luckyColors = [
  "雾蓝", "奶油白", "薄荷绿", "琥珀橙", "珊瑚粉", "月光银", "松针绿", "晴空蓝",
  "葡萄紫", "蜜桃粉", "暖杏色", "海盐蓝", "砖红", "燕麦色", "深靛青", "雨灰色",
] as const;

const luckyActivities = [
  "整理一下桌面", "完成一个拖了很久的小待办", "出门走十分钟", "听一首最近喜欢的歌",
  "给朋友发条消息", "喝一杯热饮", "把明天的安排写下来", "关闭几个无关通知",
  "读几页书", "收拾一个常被忽略的角落", "早点洗漱休息", "记录一个突然冒出的想法",
  "晒一会儿太阳", "做一次简单拉伸", "给自己准备一顿喜欢的食物", "清理几张不再需要的照片",
] as const;

const divinationPlugin: MizPlugin = {
  name: "divination",
  commands: ["占卜", "fortune"],
  description: "抽一张今日小签，也可以写下想问的主题。\n用法：miz 占卜 [主题]",
  async handle({ command, reply }) {
    const topic = command.args.trim();
    const fortune = pickRandom(fortunes);

    await reply(
      [
        topic ? "┌ 主题小签 ┐" : "┌ 今日小签 ┐",
        ...(topic ? [`想问：${topic}`] : []),
        `签面：${fortune.name}`,
        `幸运色：${pickRandom(luckyColors)}`,
        `适合做：${pickRandom(luckyActivities)}`,
        `小签说：${topic ? `关于「${topic}」——${fortune.hint}` : fortune.hint}`,
        "└ 娱乐一下，别让签替你做决定 ┘",
      ].join("\n"),
    );
  },
};

export default divinationPlugin;

const pickRandom = <T>(items: readonly T[]) => items[randomInteger(0, items.length - 1)];

const randomInteger = (minimum: number, maximum: number) => {
  const range = maximum - minimum + 1;
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return minimum + (buffer[0] % range);
};
