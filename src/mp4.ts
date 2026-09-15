/**
 * MP4 结构自检：QQ 里播放失败的特效视频，多半是素材文件本身坏了
 * （重复 moov、chunk 偏移错位、尾部截断）。这里不依赖 ffmpeg，
 * 只做几项廉价检查：采样表能解析、样本都落在文件内、样本内容是长度前缀的 NAL 链。
 */

export type Mp4VideoInspection =
  | Readonly<{ playable: true }>
  | Readonly<{ playable: false; reason: string }>;

type Mp4Box = Readonly<{
  type: string;
  /** 盒子里数据的起点（跳过 size/type 头）。 */
  start: number;
  /** 盒子结束位置（不含）。 */
  end: number;
}>;

type SampleLayout = Readonly<{
  /** 每个样本在文件里的起点，按解码顺序排列。 */
  offsets: readonly number[];
  sizes: readonly number[];
}>;

/** 需要按长度前缀解析 NAL 的编码；其它编码只看数据范围。 */
const NAL_SAMPLE_ENTRY_TYPES = new Set(["avc1", "avc3", "hvc1", "hev1"]);

/** 头部与尾部各抽查几个样本，足以发现偏移错位和尾部截断。 */
const NAL_CHECK_SAMPLE_COUNT = 8;

const MAX_TABLE_ENTRIES = 1_000_000;

const readType = (view: DataView, offset: number) => {
  let type = "";
  for (let index = 0; index < 4; index += 1) {
    type += String.fromCharCode(view.getUint8(offset + index));
  }
  return type;
};

const readBoxes = (view: DataView, start: number, end: number): Mp4Box[] => {
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) break;
    boxes.push({ type: readType(view, offset + 4), start: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
};

const findBox = (view: DataView, start: number, end: number, type: string) =>
  readBoxes(view, start, end).find((box) => box.type === type);

const readSampleSizes = (view: DataView, stsz: Mp4Box) => {
  if (stsz.start + 12 > stsz.end) return undefined;
  const uniformSize = view.getUint32(stsz.start + 4);
  const sampleCount = view.getUint32(stsz.start + 8);
  if (sampleCount > MAX_TABLE_ENTRIES) return undefined;
  if (uniformSize > 0) return new Array<number>(sampleCount).fill(uniformSize);
  if (stsz.start + 12 + sampleCount * 4 > stsz.end) return undefined;
  const sizes: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    sizes.push(view.getUint32(stsz.start + 12 + index * 4));
  }
  return sizes;
};

const readChunkOffsets = (view: DataView, stco: Mp4Box) => {
  const entrySize = stco.type === "co64" ? 8 : 4;
  if (stco.start + 8 > stco.end) return undefined;
  const count = view.getUint32(stco.start + 4);
  if (count > MAX_TABLE_ENTRIES || stco.start + 8 + count * entrySize > stco.end) return undefined;
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = stco.start + 8 + index * entrySize;
    offsets.push(entrySize === 8 ? Number(view.getBigUint64(offset)) : view.getUint32(offset));
  }
  return offsets;
};

const readSamplesPerChunk = (view: DataView, stsc: Mp4Box) => {
  if (stsc.start + 8 > stsc.end) return undefined;
  const count = view.getUint32(stsc.start + 4);
  if (count === 0 || count > MAX_TABLE_ENTRIES || stsc.start + 8 + count * 12 > stsc.end) {
    return undefined;
  }
  const entries: Array<Readonly<{ firstChunk: number; samplesPerChunk: number }>> = [];
  for (let index = 0; index < count; index += 1) {
    const offset = stsc.start + 8 + index * 12;
    entries.push({
      firstChunk: view.getUint32(offset),
      samplesPerChunk: view.getUint32(offset + 4),
    });
  }
  return entries;
};

/** 按 stsc/stco/stsz 摊平出每个样本的位置。 */
const layoutSamples = (
  sizes: readonly number[],
  chunkOffsets: readonly number[],
  samplesPerChunk: readonly Readonly<{ firstChunk: number; samplesPerChunk: number }>[],
): SampleLayout | undefined => {
  const offsets: number[] = [];
  let sampleIndex = 0;
  for (let chunk = 1; chunk <= chunkOffsets.length && sampleIndex < sizes.length; chunk += 1) {
    let perChunk = samplesPerChunk[0]?.samplesPerChunk ?? 0;
    for (const entry of samplesPerChunk) {
      if (chunk >= entry.firstChunk) perChunk = entry.samplesPerChunk;
    }
    if (perChunk <= 0) return undefined;
    let cursor = chunkOffsets[chunk - 1]!;
    for (let index = 0; index < perChunk && sampleIndex < sizes.length; index += 1) {
      offsets.push(cursor);
      cursor += sizes[sampleIndex]!;
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== sizes.length || offsets.length === 0) return undefined;
  return { offsets, sizes };
};

/** 视频样本描述里的 NAL 长度字段宽度；非 AVC/HEVC 返回空对象。 */
const readNalLengthSize = (view: DataView, stsd: Mp4Box): Readonly<{ nalLengthSize?: number }> | undefined => {
  if (stsd.start + 8 > stsd.end) return undefined;
  for (const entry of readBoxes(view, stsd.start + 8, stsd.end)) {
    if (!NAL_SAMPLE_ENTRY_TYPES.has(entry.type)) return {};
    const config = findBox(view, entry.start + 78, entry.end, "avcC") ??
      findBox(view, entry.start + 78, entry.end, "hvcC");
    if (!config || config.start + 5 > config.end) return { nalLengthSize: 4 };
    return { nalLengthSize: (view.getUint8(config.start + 4) & 3) + 1 };
  }
  return undefined;
};

/** 样本是否是一串自洽的长度前缀 NAL 单元（AVC/HEVC 在 MP4 里的存放方式）。 */
const isNalSample = (
  view: DataView,
  offset: number,
  size: number,
  nalLengthSize: number,
  limit: number,
) => {
  const end = offset + size;
  let cursor = offset;
  if (size <= 0 || end > limit) return false;
  while (cursor < end) {
    if (cursor + nalLengthSize > end) return false;
    let length = 0;
    for (let index = 0; index < nalLengthSize; index += 1) {
      length = length * 256 + view.getUint8(cursor + index);
    }
    cursor += nalLengthSize;
    if (length <= 0 || cursor + length > end) return false;
    // NAL 头首个 bit 必须为 0，类型 0 保留不用。
    const header = view.getUint8(cursor);
    if ((header & 0x80) !== 0 || (header & 0x1f) === 0) return false;
    cursor += length;
  }
  return true;
};

export const inspectMp4Video = (data: Uint8Array): Mp4VideoInspection => {
  if (data.byteLength < 16) {
    return { playable: false, reason: "file is too small to be an MP4 video" };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const moov = findBox(view, 0, data.byteLength, "moov");
  if (!moov) {
    return { playable: false, reason: "missing moov box" };
  }
  const trak = findBox(view, moov.start, moov.end, "trak");
  const mdia = trak ? findBox(view, trak.start, trak.end, "mdia") : undefined;
  const minf = mdia ? findBox(view, mdia.start, mdia.end, "minf") : undefined;
  const stbl = minf ? findBox(view, minf.start, minf.end, "stbl") : undefined;
  if (!stbl) {
    return { playable: false, reason: "missing video sample table" };
  }
  const stsd = findBox(view, stbl.start, stbl.end, "stsd");
  const stsz = findBox(view, stbl.start, stbl.end, "stsz");
  const stsc = findBox(view, stbl.start, stbl.end, "stsc");
  const stco = findBox(view, stbl.start, stbl.end, "stco") ?? findBox(view, stbl.start, stbl.end, "co64");
  if (!stsd || !stsz || !stsc || !stco) {
    return { playable: false, reason: "missing video sample table" };
  }

  const sizes = readSampleSizes(view, stsz);
  const chunkOffsets = readChunkOffsets(view, stco);
  const perChunk = readSamplesPerChunk(view, stsc);
  if (!sizes || !chunkOffsets || !perChunk || sizes.length === 0) {
    return { playable: false, reason: "video sample table is malformed" };
  }
  const layout = layoutSamples(sizes, chunkOffsets, perChunk);
  if (!layout) {
    return { playable: false, reason: "video samples cannot be located" };
  }
  for (const [index, offset] of layout.offsets.entries()) {
    const size = layout.sizes[index]!;
    if (size <= 0 || offset + size > data.byteLength) {
      return { playable: false, reason: `sample ${index} is missing or truncated` };
    }
  }

  const sampleEntry = readNalLengthSize(view, stsd);
  if (!sampleEntry) {
    return { playable: false, reason: "missing video sample description" };
  }
  const nalLengthSize = sampleEntry.nalLengthSize;
  if (nalLengthSize === undefined) {
    // 非 AVC/HEVC 编码（如 VP9/AV1）不按长度前缀解析，只确认数据范围合法。
    return { playable: true };
  }

  const checkIndexes = new Set<number>();
  for (let index = 0; index < Math.min(NAL_CHECK_SAMPLE_COUNT, layout.sizes.length); index += 1) {
    checkIndexes.add(index);
  }
  for (let index = Math.max(0, layout.sizes.length - NAL_CHECK_SAMPLE_COUNT); index < layout.sizes.length; index += 1) {
    checkIndexes.add(index);
  }
  for (const index of checkIndexes) {
    const offset = layout.offsets[index]!;
    const size = layout.sizes[index]!;
    if (!isNalSample(view, offset, size, nalLengthSize, data.byteLength)) {
      return { playable: false, reason: `sample ${index} is not a valid NAL unit chain` };
    }
  }
  return { playable: true };
};