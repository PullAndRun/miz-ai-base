import type { MizPlugin } from "@/plugins";

const fortuneNames = ["大吉", "吉", "小吉", "平", "小凶"];
const fortuneContexts = [
  "处理今天的安排时", "面对手头的小事时", "规划接下来的时间时", "回复重要消息时", "做出一个选择时",
  "开始一份新计划时", "整理脑海里的想法时", "和朋友相处时", "学习新东西时", "感到有些犹豫时",
  "准备休息之前", "想让自己轻松一点时", "完成一项待办之后", "遇到小小的阻碍时", "想尝试新事物时",
  "安排生活琐事时", "回顾最近收获时", "准备表达想法时", "觉得节奏有些乱时", "期待一点好运时",
];
const fortuneSuggestions = [
  "先从最简单的一步开始", "给自己留一点余地", "把优先顺序理清再行动", "按自己的节奏推进",
  "先确认细节再决定", "把想到的内容写下来", "用十分钟做个小整理", "优先完成最关键的一项",
  "给计划预留一些缓冲", "向可靠的人请教", "暂停片刻再继续", "保留一点好奇心",
];
const fortuneClosings = [
  "慢一点反而会更稳", "不必急着看到结果", "平常心会带来好状态", "耐心能让事情更顺利",
  "小小的行动也值得肯定", "清晰会比速度更重要", "好消息常藏在细节里", "适合相信自己的判断",
  "留白能带来新的灵感", "轻松一点会更有收获", "稳住节奏就很好", "今天会比想象中顺利",
];
const colorModifiers = [
  "晨雾", "晴空", "月光", "薄荷", "暖阳", "海盐", "暮云", "微风", "琥珀", "星夜",
  "雨后", "初雪", "森林", "花瓣", "清泉", "霞光", "奶油", "极光", "砂糖", "静谧",
];
const colorBases = [
  "湖蓝", "暖橙", "松绿", "雾紫", "奶白", "珊瑚粉", "墨黑", "杏黄", "砖红", "银灰", "靛青", "蜜桃色",
];
const activityStyles = [
  "安静地", "轻松地", "认真地", "慢慢地", "趁空档", "带着好奇心", "放下手机后", "喝口水再", "听着喜欢的歌", "给自己一点空间后", "有空时", "心情平静时",
];
const activityThemes = [
  "整理桌面", "完成一个待办", "散步一小段", "读几页书", "写下一个灵感",
  "给朋友问好", "收拾一个角落", "学一个小技巧", "听一首老歌", "喝一杯热饮",
  "关闭无关通知", "检查明天的安排", "晒晒太阳", "做一次拉伸", "清理相册",
  "回顾最近的收获", "准备一顿喜欢的食物", "把烦恼写下来", "完成一件小承诺", "早点休息",
];

// Colors and activities each contain 240 variants (20 × 12). Fortune hints
// use a complete-sentence template with 2,880 natural combinations.
const fortunes = createFortunes();
const luckyColors = combine(colorModifiers, colorBases);
const luckyActivities = combine(activityStyles, activityThemes);

const divinationPlugin: MizPlugin = {
  name: "divination",
  commands: ["占卜", "fortune"],
  description: "抽取一条随机运势，也可指定想问的主题。\n用法：miz 占卜 [主题]",
  async handle({ command, reply }) {
    const topic = command.args.trim();
    const fortune = pickRandom(fortunes);
    const score = randomInteger(55, 100);

    await reply(
      [
        topic ? "┌ 占卜结果 ┐" : "┌ 今日运势 ┐",
        ...(topic ? [`所问：${topic}`] : []),
        `${topic ? "结果" : "运势"}：${fortune.name} · ${score}%`,
        `幸运色：${pickRandom(luckyColors)}`,
        `幸运行动：${pickRandom(luckyActivities)}`,
        `提示：${topic ? `关于「${topic}」，${fortune.hint}` : fortune.hint}`,
        topic ? "└ 仅供娱乐，祝你心想事成 ┘" : "└ 愿你今天顺顺利利 ┘",
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

function createFortunes() {
  return fortuneContexts.flatMap((context, contextIndex) =>
    fortuneSuggestions.flatMap((suggestion, suggestionIndex) =>
      fortuneClosings.map((closing, closingIndex) => ({
        name: fortuneNames[(contextIndex + suggestionIndex + closingIndex) % fortuneNames.length],
        hint: `${context}，${suggestion}，${closing}。`,
      })),
    ),
  );
}

function combine(left: readonly string[], right: readonly string[]) {
  return left.flatMap((leftItem) => right.map((rightItem) => `${leftItem}${rightItem}`));
}
