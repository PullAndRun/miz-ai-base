/**
 * 测试用的最小 MP4：只包含 inspectMp4Video 会读的盒子（ftyp/moov/trak/mdia/minf/stbl/mdat），
 * 样本内容是一串长度前缀的 NAL 单元，因此能通过结构自检，但不是真的能解码的视频。
 */

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
};

const box = (type: string, ...parts: readonly Buffer[]) => {
  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
};

const fullBox = (type: string, ...parts: readonly Buffer[]) =>
  box(type, Buffer.alloc(4), ...parts);

/** 一个长度前缀的 NAL 单元。 */
export const createNalSample = (nalType: number, payloadLength: number) => {
  const nal = Buffer.concat([Buffer.from([nalType]), Buffer.alloc(payloadLength, 0x5a)]);
  return Buffer.concat([u32(nal.length), nal]);
};

const createSampleEntry = (type: string) => {
  const fields = Buffer.alloc(78);
  fields.writeUInt16BE(1, 6);      // data_reference_index
  fields.writeUInt16BE(16, 24);    // width
  fields.writeUInt16BE(16, 26);    // height
  fields.writeUInt16BE(1, 40);     // frame_count
  fields.writeUInt16BE(24, 74);    // depth
  fields.writeUInt16BE(0xffff, 76); // pre_defined
  if (type !== "avc1" && type !== "avc3") {
    return box(type, fields);
  }
  const avcC = box("avcC", Buffer.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe0, 0x00, 0x00, 0x00]));
  return box(type, fields, avcC);
};

export type Mp4VideoFixtureOptions = Readonly<{
  /** 样本内容，默认两个合法的 NAL 链。 */
  samples?: readonly Buffer[];
  /** 故意把 chunk 偏移写歪，模拟素材生成器留下的坏文件。 */
  chunkOffsetShift?: number;
  /** 样本表里声明的样本长度，默认与样本一致；改大可以模拟尾部截断。 */
  declaredSampleSizes?: readonly number[];
  /** 视频样本类型，默认 avc1；换成 vp09 之类就不会走 NAL 检查。 */
  sampleEntryType?: string;
}>;

export const createMp4VideoFixture = (options: Mp4VideoFixtureOptions = {}) => {
  const samples = options.samples ?? [createNalSample(0x65, 32), createNalSample(0x41, 16)];
  const declaredSizes = options.declaredSampleSizes ??
    samples.map((sample) => sample.byteLength);
  if (declaredSizes.length !== samples.length) {
    throw new Error("declaredSampleSizes must match samples");
  }

  const ftyp = box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomiso2avc1mp41"));
  const entryCount = u32(1);
  const stsd = fullBox("stsd", entryCount, createSampleEntry(options.sampleEntryType ?? "avc1"));
  const stts = fullBox("stts", u32(1), u32(samples.length), u32(512));
  const stsc = fullBox("stsc", u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = fullBox("stsz", u32(0), u32(samples.length), ...declaredSizes.map(u32));

  const buildMoov = (chunkOffset: number) => {
    const stco = fullBox("stco", u32(1), u32(chunkOffset));
    const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
    const minf = box("minf", stbl);
    const mdia = box("mdia", minf);
    const trak = box("trak", mdia);
    return box("moov", trak);
  };

  const placeholderMoov = buildMoov(0);
  const payload = Buffer.concat(samples);
  const chunkOffset = ftyp.byteLength + placeholderMoov.byteLength + 8;
  const moov = buildMoov(chunkOffset + (options.chunkOffsetShift ?? 0));
  return Buffer.concat([ftyp, moov, box("mdat", payload)]);
};
