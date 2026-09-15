let bleDevice, gattServer;
let epdService, epdCharacteristic;
let startTime, msgIndex, appVersion;
let canvas, ctx, textDecoder;
let paintManager, cropManager;
let fwModels = null;           // 固件支持的屏型号 id 数组（GET_MODELS 回复）
let modelsResolver = null;     // loadModels() 等待通知的 resolver

// ===== 版本/能力协商 (与固件 EPD_service.h 保持一致) =====
const WEB_VER = '1.7';                // 前端版本: 改功能后递增 (也用于 CSS/JS 缓存参数)
const CAP_RLE_V16 = 1 << 0;           // 0x30 配置字 RLE (原仓库 v1.6 格式)
const CAP_HEATSHRINK = 1 << 1;        // 0x31 Heatshrink (本 fork)
const CAP_E6_CMAP = 1 << 2;           // E6 双相 + GET_CMAP
const CAP_WEEK_START = 1 << 3;        // SET_WEEK_START
let fwMajor = 0, fwMinor = 0, fwCaps = 0;  // 当前连接固件的版本/能力

const EpdCmd = {
  SET_PINS: 0x00,
  INIT: 0x01,
  CLEAR: 0x02,
  SEND_CMD: 0x03,
  SEND_DATA: 0x04,
  REFRESH: 0x05,
  SLEEP: 0x06,

  SET_TIME: 0x20,

  WRITE_IMG: 0x30, // v1.6
  WRITE_IMG_RLE: 0x31,

  SET_CONFIG: 0x90,
  SYS_RESET: 0x91,
  SYS_SLEEP: 0x92,
  CFG_ERASE: 0x99,
  GET_CMAP: 0xA0,
  GET_MODELS: 0xA1,
  GET_DLOG: 0xA2,
};

const canvasSizes = [
  { name: '1.54_152_152', width: 152, height: 152 },
  { name: '1.54_200_200', width: 200, height: 200 },
  { name: '2.13_104_212', width: 104, height: 212 },
  { name: '2.13_122_250', width: 122, height: 250 },
  { name: '2.66_152_296', width: 152, height: 296 },
  { name: '2.66_184_360', width: 184, height: 360 },
  { name: '2.9_128_296', width: 128, height: 296 },
  { name: '2.9_168_384', width: 168, height: 384 },
  { name: '3.5_184_384', width: 184, height: 384 },
  { name: '3.5_360_600', width: 360, height: 600 },
  { name: '3.7_240_416', width: 240, height: 416 },
  { name: '3.7_280_480', width: 280, height: 480 },
  { name: '3.97_800_480', width: 800, height: 480 },
  { name: '3.68_792_528', width: 792, height: 528 },
  { name: '3.98_768_552', width: 768, height: 552 },
  { name: '4.2_400_300', width: 400, height: 300 },
  { name: '5.79_792_272', width: 792, height: 272 },
  { name: '5.83_600_448', width: 600, height: 448 },
  { name: '5.83_648_480', width: 648, height: 480 },
  { name: '7.5_640_384', width: 640, height: 384 },
  { name: '7.5_800_480', width: 800, height: 480 },
  { name: '7.5_880_528', width: 880, height: 528 },
  { name: '10.2_960_640', width: 960, height: 640 },
  { name: '10.85_1360_480', width: 1360, height: 480 },
  { name: '11.6_960_640', width: 960, height: 640 },
  { name: '4.0E6_600_400', width: 600, height: 400 },
  { name: '7.3E6_800_480', width: 800, height: 480 },
];

/**
 * 轻量级纯原生 Heatshrink 压缩器 (纯 JS 实现，无需 NPM)
 * 参数说明: windowBits = 8 (256 字节窗口), lookaheadBits = 4 (最大 16 字节匹配)
 */
class HeatshrinkCompressor {
  constructor(windowBits = 8, lookaheadBits = 4) {
    this.windowBits = windowBits;
    this.lookaheadBits = lookaheadBits;
    this.windowSize = 1 << windowBits;
    this.lookaheadSize = 1 << lookaheadBits;
  }

  compress(input) {
    const inputLen = input.length;
    let outBits = [];
    
    // 写入 bit 辅助函数
    const writeBits = (val, count) => {
      for (let i = count - 1; i >= 0; i--) {
        outBits.push((val >> i) & 1);
      }
    };

    let pos = 0;
    while (pos < inputLen) {
      let maxMatchLen = 0;
      let maxMatchOffset = 0;

      // 在滑动窗口 (256 字节) 内寻找匹配
      const winStart = Math.max(0, pos - this.windowSize);
      const maxLen = Math.min(this.lookaheadSize, inputLen - pos);

      for (let offset = 1; offset <= (pos - winStart); offset++) {
        let matchLen = 0;
        while (matchLen < maxLen && input[pos - offset + (matchLen % offset)] === input[pos + matchLen]) {
          matchLen++;
        }
        if (matchLen > maxMatchLen) {
          maxMatchLen = matchLen;
          maxMatchOffset = offset;
        }
      }

      // 如果找到符合要求的重复序列 (匹配长度需大于 2，否则发字面量更划算)
      if (maxMatchLen >= 3) {
        writeBits(0, 1); // Tag: Backref (0)
        writeBits(maxMatchOffset - 1, this.windowBits); // Offset
        writeBits(maxMatchLen - 1, this.lookaheadBits); // Length
        pos += maxMatchLen;
      } else {
        writeBits(1, 1); // Tag: Literal (1)
        writeBits(input[pos], 8); // Byte
        pos++;
      }
    }

    // 将 bit 数组转换为 Uint8Array 字节流
    const byteLen = Math.ceil(outBits.length / 8);
    const result = new Uint8Array(byteLen);
    for (let i = 0; i < outBits.length; i++) {
      if (outBits[i]) {
        result[i >> 3] |= (1 << (7 - (i % 8)));
      }
    }

    return result;
  }
}

function hex2bytes(hex) {
  for (var bytes = [], c = 0; c < hex.length; c += 2)
    bytes.push(parseInt(hex.substr(c, 2), 16));
  return new Uint8Array(bytes);
}

function bytes2hex(data) {
  return new Uint8Array(data).reduce(
    function (memo, i) {
      return memo + ("0" + i.toString(16)).slice(-2);
    }, "");
}

function intToHex(intIn) {
  let stringOut = ("0000" + intIn.toString(16)).substr(-4)
  return stringOut.substring(2, 4) + stringOut.substring(0, 2);
}

function resetVariables() {
  gattServer = null;
  epdService = null;
  epdCharacteristic = null;
  msgIndex = 0;
  fwMajor = 0; fwMinor = 0; fwCaps = 0;
  // 清除上一个连接固件的型号/cmap 缓存，确保下次连接时重新协商（GET_MODELS/GET_CMAP）
  fwModels = null;
  e6_cmap_loaded = false;
  e6_cmap1 = [1,1,2,3, 0,1,0,1, 1,1,1,1, 1,1,1,1];
  e6_cmap2 = [0,1,1,3, 1,2,1,1, 1,1,1,1, 1,1,1,1];
  // 若有上一次连接遗留的等待者，先放行，避免旧 Promise 悬挂
  if (modelsResolver) { modelsResolver(); modelsResolver = null; }
  if (e6_cmapResolver) { e6_cmapResolver(); e6_cmapResolver = null; }
  // 恢复驱动下拉全部选项可见，避免上次固件的型号过滤残留
  resetModelFilter();
  document.getElementById("log").value = '';
}

async function write(cmd, data, withResponse = true, quiet = false) {
  if (!epdCharacteristic) {
    addLog("服务不可用，请检查蓝牙连接");
    return false;
  }
  let payload = [cmd];
  if (data) {
    if (typeof data == 'string') data = hex2bytes(data);
    if (data instanceof Uint8Array) data = Array.from(data);
    payload.push(...data)
  }
  if (!quiet) addLog(bytes2hex(payload), '⇑');
  try {
    if (withResponse)
      await epdCharacteristic.writeValueWithResponse(Uint8Array.from(payload));
    else
      await epdCharacteristic.writeValueWithoutResponse(Uint8Array.from(payload));
  } catch (e) {
    console.error(e);
    if (e.message) addLog("write: " + e.message);
    return false;
  }
  return true;
}

// E6屏：将4bpp数据拆分为两份2bpp数据
// cmap默认值(与固件JD79xxx.c一致), 蓝牙加载成功后会覆盖
let e6_cmap1 = [1,1,2,3, 0,1,0,1, 1,1,1,1, 1,1,1,1];
let e6_cmap2 = [0,1,1,3, 1,2,1,1, 1,1,1,1, 1,1,1,1];
let e6_cmap_loaded = false;
let e6_cmapResolver = null;

async function loadE6Cmap() {
  if (e6_cmap_loaded) return;
  const promise = new Promise((resolve) => { e6_cmapResolver = resolve; });
  await write(EpdCmd.GET_CMAP);
  if (e6_cmap_loaded) return;
  await promise;
}

// ===== 屏型号动态协商（GET_MODELS）=====
// 连接后向固件查询"支持的屏型号 id 列表"，据此过滤驱动下拉，
// 只显示当前固件实际支持的型号（如 SSD16XX 固件只显示 03/04）。
async function loadModels() {
  if (fwModels != null) return;
  // 兜底超时：旧固件无 GET_MODELS 回复时不至于卡死连接流程
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  const promise = new Promise((resolve) => { modelsResolver = resolve; });
  await write(EpdCmd.GET_MODELS, null, true, true);
  if (fwModels != null) return;
  await Promise.race([promise, timeout]);
}

// 恢复"驱动"下拉全部选项可见（断开/重新连接前调用）
function resetModelFilter() {
  const sel = document.getElementById("epddriver");
  if (!sel) return;
  for (const opt of sel.options) opt.style.display = '';
}

// 按固件支持的型号过滤"驱动"下拉（隐藏不支持的 option）
function applyModelFilter() {
  const sel = document.getElementById("epddriver");
  if (!sel || !fwModels || fwModels.length === 0) return;
  const supported = new Set(fwModels.map(id => id.toString(16).padStart(2, '0')));
  let visible = 0, firstVisible = null;
  for (const opt of sel.options) {
    const show = supported.has(opt.value);
    opt.style.display = show ? '' : 'none';
    if (show) {
      visible++;
      if (firstVisible == null) firstVisible = opt;
    }
  }
  if (visible === 1 && firstVisible) sel.value = firstVisible.value;
  const ids = fwModels.map(id => id.toString(16).padStart(2, '0').toUpperCase()).join(', ');
  addLog(`固件支持型号 (${fwModels.length}): ${ids}`);
  updateDitcherOptions();
}

// ===== 读取固件诊断日志（GET_DLOG）=====
// 分片读取 retention dlog 缓冲（复位/断开前固件写入的探针日志），
// 用于诊断 macOS 下连接断开/复位的原因。请求 [0xA2, off_lo, off_hi]，
// 固件回复 [0xA2, off_lo, off_hi, len, data...]；len=0 表示读完。
let dlogChunks = [], dlogResolver = null;

async function readDlog() {
  if (!epdCharacteristic) { addLog("未连接，无法读取诊断日志"); return; }
  addLog("读取诊断日志 (dlog)…");
  dlogChunks = [];
  const promise = new Promise((resolve) => { dlogResolver = resolve; });
  await write(EpdCmd.GET_DLOG, "0000", true, true);
  await promise;
  const text = dlogChunks.join('');
  addLog("======= dlog 诊断日志 =======");
  if (!text.trim()) {
    addLog("(空 — 固件未写入诊断日志)");
  } else {
    for (const line of text.split('\n')) { if (line.trim()) addLog(line); }
  }
  addLog("======= 结束 =======");
}

function splitE6Phases(data4bpp, cmap1, cmap2) {
  const pixels = [];
  for (let i = 0; i < data4bpp.length; i++) {
    pixels.push(data4bpp[i] >> 4);
    pixels.push(data4bpp[i] & 0x0F);
  }
  const phase1 = new Uint8Array(pixels.length);
  const phase2 = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    phase1[i] = cmap1[pixels[i]];
    phase2[i] = cmap2[pixels[i]];
  }
  return { phase1, phase2 };
}

function hasCap(bit) { return (fwCaps & bit) !== 0; }

// 旧固件(单字节版本, 无能力位)的兜底能力表:
// 原仓库最新 (0x1A) 起支持 0x30 配置字 RLE; 更早版本无压缩。
function fwCapsFromVersion(v) {
  if (v >= 0x1A) return CAP_RLE_V16;
  return 0;
}

function capNames(caps) {
  const names = [];
  if (caps & CAP_RLE_V16) names.push('RLE');
  if (caps & CAP_HEATSHRINK) names.push('Heatshrink');
  if (caps & CAP_E6_CMAP) names.push('E6');
  if (caps & CAP_WEEK_START) names.push('WeekStart');
  return names.length ? names.join(',') : '无';
}

// ===== 图片发送: 根据固件能力自动选择压缩/协议路径 =====
async function writeImage(data, step = 'bw') {
  if (hasCap(CAP_HEATSHRINK)) {
    // 本 fork: 0x31 Heatshrink (或按复选框关压缩走 0x30 纯图)
    return writeImageHS(data, step);
  }
  if (hasCap(CAP_RLE_V16)) {
    // 原仓库 v1.6: 0x30 配置字 RLE 位
    return writeImageV16(data, step);
  }
  // 未知/更旧固件: 强制纯图 (0x30 ram_addr 格式), 保证可兼容
  addLog('固件未反馈压缩能力, 使用纯图模式发送 (无压缩)');
  return writeImageHS(data, step, true);
}

// 本 fork: Heatshrink 压缩 (0x31) + 全部 writeWithResponse; forcePlain=true 时走 0x30 纯图
async function writeImageHS(data, step = 'bw', forcePlain = false) {
  const useRle = !forcePlain && (document.getElementById('enableCompression')?.checked);
  const mtu = parseInt(document.getElementById('mtusize').value) || 247;

  const sendData = useRle ? compressHS(data) : data;
  const cmd = useRle ? EpdCmd.WRITE_IMG_RLE : EpdCmd.WRITE_IMG;

  const headerSize = 1;
  const chunkSize = mtu - headerSize - 1;
  const totalChunks = Math.ceil(sendData.length / chunkSize);

  let chunkIdx = 0;
  for (let i = 0; i < sendData.length; i += chunkSize) {
    const chunk = sendData.slice(i, i + chunkSize);
    const cfgByte = (step === 'bw' ? 0x0F : 0x00) | (i === 0 ? 0x00 : 0xF0);
    const payload = [cfgByte, ...chunk];

    setStatus(`${step}${useRle ? ' (HS)' : ''}: ${chunkIdx + 1}/${totalChunks}`);
    await write(cmd, payload, true, true);
    chunkIdx++;
  }
}

// 原仓库 v1.6 协议: 0x30 配置字 {bit0: black/red, bit1: begin, bit2: rle}
async function writeImageV16(data, step = 'bw') {
  const mtu = parseInt(document.getElementById('mtusize').value) || 247;
  const chunkSize = mtu - 2;

  const rleChunks = rleCompressMTU(data, chunkSize);
  const rleLength = rleChunks.reduce((t, c) => t + c.length, 0);
  const useRle = rleLength < data.length;
  const totalChunks = useRle ? rleChunks.length : Math.ceil(data.length / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = useRle ? rleChunks[i] : data.slice(i * chunkSize, i * chunkSize + chunkSize);
    const cfg = (step === 'bw' ? 0x00 : 0x01) | (i === 0 ? 0x02 : 0x00) | (useRle ? 0x04 : 0x00);

    setStatus(`${step}${useRle ? ' (RLE)' : ''}: ${i + 1}/${totalChunks}`);
    await write(EpdCmd.WRITE_IMG, [cfg, ...chunk], true, true);
  }
}

// 原仓库 v1.6 RLE 编码 (0x30 配置字 bit2=1 时固件按此格式解压)
function rleCompressV16(data, maxLiteralSize = 128) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const result = [];
  let i = 0;

  while (i < input.length) {
    let runLen = 1;
    while (i + runLen < input.length && runLen < 130 && input[i + runLen] === input[i]) runLen++;

    if (runLen >= 3) {
      // 重复串: 控制字节 = 0x80 | (runLen - 3)
      result.push(0x80 | (runLen - 3));
      result.push(input[i]);
      i += runLen;
    } else {
      // 字面串: 控制字节 = literalLen - 1, 后跟 literalLen 个字节
      const literalStart = i;
      let literalLen = 0;
      while (i < input.length && literalLen < maxLiteralSize) {
        if (i + 2 < input.length && input[i] === input[i + 1] && input[i] === input[i + 2]) break;
        literalLen++;
        i++;
      }
      if (literalLen === 0) {
        result.push(0x00);
        result.push(input[i++]);
      } else {
        result.push(literalLen - 1);
        for (let j = literalStart; j < literalStart + literalLen; j++) result.push(input[j]);
      }
    }
  }

  return new Uint8Array(result);
}

// 整段 RLE 压缩后按完整码字边界分片, 每片都是合法 RLE 流
function rleCompressMTU(data, maxChunkSize) {
  const maxLit = Math.min(maxChunkSize - 1, 128);
  const input = rleCompressV16(data, maxLit);
  const chunks = [];
  let i = 0, start = 0;

  while (i < input.length) {
    const control = input[i];
    const codeLen = (control & 0x80) ? 2 : (control + 2);
    if (i - start + codeLen > maxChunkSize && i > start) {
      chunks.push(input.slice(start, i));
      start = i;
    }
    i += codeLen;
  }

  if (i > start) chunks.push(input.slice(start, i));
  return chunks;
}

// E6屏 Heatshrink 发送 — 两阶段各有独立 4 字节 Header
async function sendE6HS(phase1, phase2) {
  const mtu = parseInt(document.getElementById('mtusize').value) || 247;

  const pack2bpp = (pixels) => {
    const packed = new Uint8Array(Math.ceil(pixels.length / 4));
    for (let i = 0; i < pixels.length; i++) {
      const byteIdx = i >> 2;
      const bitShift = 6 - ((i & 3) << 1);
      packed[byteIdx] |= (pixels[i] & 0x03) << bitShift;
    }
    return packed;
  };

  const sendPhase = async (pixels, phaseNum) => {
    const packedBytes = pack2bpp(pixels);
    const compressedPayload = compressHS(packedBytes);

    const headerSize = 2; // [phase, ramAddr]
    const chunkSize = mtu - headerSize - 1;
    const totalChunks = Math.ceil(compressedPayload.length / chunkSize);

    let chunkIdx = 0;
    for (let i = 0; i < compressedPayload.length; i += chunkSize) {
      const chunk = compressedPayload.slice(i, i + chunkSize);
      const ramAddr = (i === 0) ? 0x00 : 0x10;
      const payload = [phaseNum, ramAddr, ...chunk];

      setStatus(`E6 Phase${phaseNum + 1} (HS): ${chunkIdx + 1}/${totalChunks}`);
      await write(EpdCmd.WRITE_IMG_RLE, payload, true, true);
      chunkIdx++;
    }
  };

  await sendPhase(phase1, 0);
  await write(EpdCmd.REFRESH);
  await sendPhase(phase2, 1);
  await write(EpdCmd.REFRESH);
}

// RLE编码: bitsPerPixel=0表示输入已是打包字节, 直接RLE压缩
function rleEncode(data, bitsPerPixel = 2) {
  if (data.length === 0) return [];

  let packed;
  if (bitsPerPixel === 0) {
    // 输入已是打包字节 (非E6屏 processImageData 输出), 直接使用
    packed = data;
  } else {
    // 打包像素到字节
    const pixelsPerByte = 8 / bitsPerPixel;
    packed = [];
    for (let i = 0; i < data.length; i += pixelsPerByte) {
      let byte = 0;
      const remaining = Math.min(pixelsPerByte, data.length - i);
      const shift = bitsPerPixel === 1 ? 7 : (bitsPerPixel === 2 ? 6 : 4);
      for (let j = 0; j < remaining; j++) {
        const mask = (1 << bitsPerPixel) - 1;
        byte |= (data[i + j] & mask) << (shift - j * bitsPerPixel);
      }
      packed.push(byte);
    }
  }

  // 2. RLE压缩打包后的字节
  const out = [];
  let i = 0;
  while (i < packed.length) {
    let val = packed[i];
    let cnt = 1;
    while (i + cnt < packed.length && cnt < 255 && packed[i + cnt] === val) cnt++;
    out.push(cnt - 1, val);
    i += cnt;
  }
  return out;
}

/**
 * 压缩图像数据并添加 4 字节原始长度包头
 * @param {Uint8Array} rawPixelData 解压前的原始图像字节数组
 * @returns {Uint8Array} 压缩好、带 4 字节 Header 的数据，准备用于 BLE 分片发送
 */
function compressHS(rawPixelData) {
  // 1. 初始化压缩器 (窗口=8, 前瞻=4)
  const compressor = new HeatshrinkCompressor(8, 4);

  // 2. 执行压缩
  const compressed = compressor.compress(rawPixelData);

  // 3. 构造 4 字节 Header (大端模式 Big-Endian，储存 rawPixelData 的原始总大小 uint32_t)
  const totalSize = rawPixelData.length;
  const header = new Uint8Array([
    (totalSize >> 24) & 0xFF,
    (totalSize >> 16) & 0xFF,
    (totalSize >> 8) & 0xFF,
    totalSize & 0xFF
  ]);

  // 4. 将 Header (4 字节) 拼接在压缩 Payload 的最前面
  const finalPayload = new Uint8Array(header.length + compressed.length);
  finalPayload.set(header, 0);
  finalPayload.set(compressed, header.length);

  console.log(`[EPD] 原始大小: ${totalSize} 字节 | 压缩后大小: ${compressed.length} 字节 | 压缩率: ${(compressed.length / totalSize * 100).toFixed(1)}%`);

  return finalPayload;
}

async function setDriver() {
  await write(EpdCmd.SET_PINS, document.getElementById("epdpins").value);
  await write(EpdCmd.INIT, document.getElementById("epddriver").value);
}

// Build full 14-byte config from UI inputs
// Config layout: pins(7) + model_id(1) + wakeup(1) + led(1) + en(1) + mode(1) + week(1) + ganzhi(1)
function buildConfig() {
  const pins = document.getElementById('epdpins').value;
  const driver = document.getElementById('epddriver').value;
  const wakeup = document.getElementById('wakeupPin').value.trim();
  const led = document.getElementById('ledPin').value.trim();
  const enabled = document.getElementById('ganzhiEnable').checked ? 1 : 0;
  const cfg = new Uint8Array(14);
  if (pins) {
    const pinBytes = hex2bytes(pins);
    for (let i = 0; i < Math.min(pinBytes.length, 7); i++) cfg[i] = pinBytes[i];
  }
  if (driver) cfg[7] = parseInt(driver, 16);
  cfg[8] = wakeup ? parseInt(wakeup, 16) : 0xFF;    // wakeup_pin, FF=未配置
  if (led) cfg[9] = parseInt(led, 16);              // led_pin
  if (pins && pins.length > 14) cfg[10] = hex2bytes(pins)[7]; // en_pin
  cfg[11] = 1; // display_mode = MODE_CALENDAR
  cfg[12] = 0; // week_start
  cfg[13] = enabled;
  return cfg;
}

async function setGanzhi() {
  await write(EpdCmd.SET_CONFIG, buildConfig());
}

async function setWakeup() {
  const wakeupVal = document.getElementById('wakeupPin').value.trim();
  if (wakeupVal == '') return;
  await write(EpdCmd.SET_CONFIG, buildConfig());
  addLog("唤醒引脚已设置: 0x" + wakeupVal.toUpperCase() + (wakeupVal == 'FF' ? " (未配置)" : ""));
}

function toggleDebug() {
  const els = document.querySelectorAll('.debug');
  const btn = document.getElementById('debugToggle');
  const showing = document.body.classList.toggle('show-debug');
  btn.textContent = showing ? '🔓 精简' : '🔧 调试';
  localStorage.setItem('showDebug', showing ? '1' : '0');
}

// Restore debug toggle state on load
if (localStorage.getItem('showDebug') === '1') {
  document.body.classList.add('show-debug');
  document.getElementById('debugToggle').textContent = '🔓 精简';
}

async function syncTime(mode) {
  if (mode === 2) {
    if (!confirm('提醒：时钟模式目前使用全刷实现，此功能目前多用于修复老化屏残影问题，不建议长期开启，是否继续？')) return;
  }
  const timestamp = new Date().getTime() / 1000;
  const data = new Uint8Array([
    (timestamp >> 24) & 0xFF,
    (timestamp >> 16) & 0xFF,
    (timestamp >> 8) & 0xFF,
    timestamp & 0xFF,
    -(new Date().getTimezoneOffset() / 60),
    mode
  ]);
  if (await write(EpdCmd.SET_TIME, data)) {
    addLog("时间已同步！");
    addLog("屏幕刷新完成前请不要操作。");
  }
}

async function clearScreen() {
  if (confirm('确认清除屏幕内容?')) {
    await write(EpdCmd.CLEAR);
    addLog("清屏指令已发送！");
    addLog("屏幕刷新完成前请不要操作。");
  }
}

async function sendcmd() {
  const cmdTXT = document.getElementById('cmdTXT').value;
  if (cmdTXT == '') return;
  const bytes = hex2bytes(cmdTXT);
  await write(bytes[0], bytes.length > 1 ? bytes.slice(1) : null);
}

function convertUC8159(blackWhiteData, redWhiteData) {
  const halfLength = blackWhiteData.length;
  let payloadData = new Uint8Array(halfLength * 4);
  let payloadIdx = 0;
  let black_data, color_data, data;
  for (let i = 0; i < halfLength; i++) {
    black_data = blackWhiteData[i];
    color_data = redWhiteData[i];
    for (let j = 0; j < 8; j++) {
      if ((color_data & 0x80) == 0x00) data = 0x04;  // red
      else if ((black_data & 0x80) == 0x00) data = 0x00;  // black
      else data = 0x03;  // white
      data = (data << 4) & 0xFF;
      black_data = (black_data << 1) & 0xFF;
      color_data = (color_data << 1) & 0xFF;
      j++;
      if ((color_data & 0x80) == 0x00) data |= 0x04;  // red
      else if ((black_data & 0x80) == 0x00) data |= 0x00;  // black
      else data |= 0x03;  // white
      black_data = (black_data << 1) & 0xFF;
      color_data = (color_data << 1) & 0xFF;
      payloadData[payloadIdx++] = data;
    }
  }
  return payloadData;
}

async function sendimg() {
  if (cropManager.isCropMode()) {
    alert("请先完成图片裁剪！发送已取消。");
    return;
  }

  const canvasSize = document.getElementById('canvasSize').value;
  const ditherMode = document.getElementById('ditherMode').value;
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];

  if (selectedOption.getAttribute('data-size') !== canvasSize) {
    if (!confirm("警告：画布尺寸和驱动不匹配，是否继续？")) return;
  }
  if (selectedOption.getAttribute('data-color') !== ditherMode) {
    if (!confirm("警告：颜色模式和驱动不匹配，是否继续？")) return;
  }

  startTime = new Date().getTime();
  const status = document.getElementById("status");
  status.parentElement.style.display = "block";

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, ditherMode);

  updateButtonStatus(true);

  await write(EpdCmd.INIT);

  if (ditherMode === 'threeColor') {
    const halfLength = Math.floor(processedData.length / 2);
    const blackWhiteData = processedData.slice(0, halfLength);
    const redWhiteData = processedData.slice(halfLength);
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      await writeImage(convertUC8159(blackWhiteData, redWhiteData), 'bw');
    } else {
      await writeImage(blackWhiteData, 'bw');
      await writeImage(redWhiteData, 'red');
    }
  } else if (ditherMode === 'blackWhiteColor') {
    if (epdDriverSelect.value === '08' || epdDriverSelect.value === '09') {
      const emptyData = new Uint8Array(processedData.length).fill(0xFF);
      await writeImage(convertUC8159(processedData, emptyData), 'bw');
    } else {
      await writeImage(processedData, 'bw');
    }
  } else if (ditherMode === 'sixColor') {
    // E6屏: splitE6Phases + sendE6HS (Heatshrink, 自带两次 REFRESH)
    if (!hasCap(CAP_HEATSHRINK) || !hasCap(CAP_E6_CMAP)) {
      addLog('当前固件未反馈 E6/Heatshrink 支持，无法发送六色图。');
      updateButtonStatus();
      return;
    }
    if (!e6_cmap_loaded) await loadE6Cmap();
    const { phase1, phase2 } = splitE6Phases(processedData, e6_cmap1, e6_cmap2);
    await sendE6HS(phase1, phase2);
    updateButtonStatus();
    const sendTime = (new Date().getTime() - startTime) / 1000.0;
    addLog(`发送完成！耗时: ${sendTime}s`);
    setStatus(`发送完成！耗时: ${sendTime}s`);
    addLog("屏幕刷新完成前请不要操作。");
    setTimeout(() => { status.parentElement.style.display = "none"; }, 5000);
    return;  // sendE6HS 已处理全部刷新
  } else if (ditherMode === 'fourColor') {
    await writeImage(processedData, 'bw');
  } else {
    addLog("当前固件不支持此颜色模式。");
    updateButtonStatus();
    return;
  }

  await write(EpdCmd.REFRESH);
  updateButtonStatus();

  const sendTime = (new Date().getTime() - startTime) / 1000.0;
  addLog(`发送完成！耗时: ${sendTime}s`);
  setStatus(`发送完成！耗时: ${sendTime}s`);
  addLog("屏幕刷新完成前请不要操作。");
  setTimeout(() => {
    status.parentElement.style.display = "none";
  }, 5000);
}

function downloadDataArray() {
  if (cropManager.isCropMode()) {
    alert("请先完成图片裁剪！下载已取消。");
    return;
  }

  const mode = document.getElementById('ditherMode').value;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const processedData = processImageData(imageData, mode);

  if (mode === 'sixColor' && processedData.length !== canvas.width * canvas.height) {
    console.log(`错误：预期${canvas.width * canvas.height}字节，但得到${processedData.length}字节`);
    addLog('数组大小不匹配。请检查图像尺寸和模式。');
    return;
  }

  const dataLines = [];
  for (let i = 0; i < processedData.length; i++) {
    const hexValue = (processedData[i] & 0xff).toString(16).padStart(2, '0');
    dataLines.push(`0x${hexValue}`);
  }

  const formattedData = [];
  for (let i = 0; i < dataLines.length; i += 16) {
    formattedData.push(dataLines.slice(i, i + 16).join(', '));
  }

  const colorModeValue = mode === 'sixColor' ? 0 : mode === 'fourColor' ? 1 : mode === 'blackWhiteColor' ? 2 : 3;
  const arrayContent = [
    'const uint8_t imageData[] PROGMEM = {',
    formattedData.join(',\n'),
    '};',
    `const uint16_t imageWidth = ${canvas.width};`,
    `const uint16_t imageHeight = ${canvas.height};`,
    `const uint8_t colorMode = ${colorModeValue};`
  ].join('\n');

  const blob = new Blob([arrayContent], { type: 'text/plain' });
  const link = document.createElement('a');
  link.download = 'imagedata.h';
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
}

function updateButtonStatus(forceDisabled = false) {
  const connected = gattServer != null && gattServer.connected;
  const status = forceDisabled ? 'disabled' : (connected ? null : 'disabled');
  document.getElementById("reconnectbutton").disabled = (gattServer == null || gattServer.connected) ? 'disabled' : null;
  document.getElementById("sendcmdbutton").disabled = status;
  document.getElementById("calendarmodebutton").disabled = status;
  document.getElementById("clockmodebutton").disabled = status;
  document.getElementById("clearscreenbutton").disabled = status;
  document.getElementById("sendimgbutton").disabled = status;
  document.getElementById("setDriverbutton").disabled = status;
}

function disconnect() {
  updateButtonStatus();
  resetVariables();
  addLog('已断开连接.');
  document.getElementById("connectbutton").innerHTML = '连接';
}

function buildRequestOptions() {
  const filters = [];
  if (document.getElementById("filterNRF").checked) filters.push({ namePrefix: 'NRF' });
  if (document.getElementById("filterTLSR").checked) filters.push({ namePrefix: 'TLSR' });
  if (document.getElementById("filterDLG").checked) filters.push({ namePrefix: 'DLG' });
  const custom = document.getElementById("filterCustom").value.trim();
  if (custom) filters.push({ namePrefix: custom });

  const options = {
    // 62750001 = EPD 服务; 0000fe59 = Buttonless DFU 服务 (OTA 用); 0000221f = Telink OTA 服务
    optionalServices: ['62750001-d828-918d-fb46-b6c11c675aec', '0000fe59-0000-1000-8000-00805f9b34fb', '0000221f-0000-1000-8000-00805f9b34fb']
  };
  if (filters.length > 0) {
    options.filters = filters;
    addLog("设备过滤: " + filters.map(f => "“" + f.namePrefix + "”").join(", "));
  } else {
    options.acceptAllDevices = true;
  }
  return options;
}

async function preConnect() {
  if (gattServer != null && gattServer.connected) {
    if (bleDevice != null && bleDevice.gatt.connected) {
      bleDevice.gatt.disconnect();
    }
  }
  else {
    resetVariables();
    try {
      bleDevice = await navigator.bluetooth.requestDevice(buildRequestOptions());
    } catch (e) {
      console.error(e);
      if (e.message) addLog("requestDevice: " + e.message);
      addLog("请检查蓝牙是否已开启，且使用的浏览器支持蓝牙！建议使用以下浏览器：");
      addLog("• 电脑: Chrome/Edge");
      addLog("• Android: Chrome/Edge");
      addLog("• iOS: Bluefy 浏览器");
      return;
    }

    await bleDevice.addEventListener('gattserverdisconnected', disconnect);
    setTimeout(async function () { await connect(); }, 300);
  }
}

async function reConnect() {
  if (bleDevice != null && bleDevice.gatt.connected)
    bleDevice.gatt.disconnect();
  resetVariables();
  addLog("正在重连");
  setTimeout(async function () { await connect(); }, 300);
}

async function handleNotify(value, idx) {
  const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (idx == 0) {
    addLog(`收到配置：${bytes2hex(data)}`);
    const epdpins = document.getElementById("epdpins");
    const epddriver = document.getElementById("epddriver");
    epdpins.value = bytes2hex(data.slice(0, 7));
    if (data.length > 10) epdpins.value += bytes2hex(data.slice(10, 11));
    epddriver.value = bytes2hex(data.slice(7, 8));
    updateDitcherOptions();
    if (data.length > 13) {
      document.getElementById('ganzhiEnable').checked = data[13] !== 0;
    }
  } else if (data.length === 32 && !e6_cmap_loaded) {
    // E6 cmap 数据 (GET_CMAP 回复)
    e6_cmap1 = Array.from(data.slice(0, 16));
    e6_cmap2 = Array.from(data.slice(16, 32));
    e6_cmap_loaded = true;
    addLog(`已加载E6 cmap: phase1=${bytes2hex(data.slice(0,16))}`);
    if (e6_cmapResolver) { e6_cmapResolver(); e6_cmapResolver = null; }
  } else if (data[0] === 0xA1 && data.length >= 2) {
    // 屏型号列表 (GET_MODELS 回复): [0xA1, count, id0, id1, ...]
    const count = data[1];
    fwModels = Array.from(data.slice(2, 2 + count));
    addLog(`型号协商: ${fwModels.length} 个 (${fwModels.map(x => x.toString(16).padStart(2,'0').toUpperCase()).join(', ')})`);
    applyModelFilter();
    if (modelsResolver) { modelsResolver(); modelsResolver = null; }
  } else if (data[0] === 0xA2) {
    // 诊断日志分片 (GET_DLOG 回复): [0xA2, off_lo, off_hi, len, data...]
    const off = data[1] | (data[2] << 8);
    const len = data[3];
    if (len > 0) {
      if (textDecoder == null) textDecoder = new TextDecoder();
      dlogChunks.push(textDecoder.decode(data.slice(4, 4 + len)));
      const nextOff = off + len;
      await write(EpdCmd.GET_DLOG, nextOff.toString(16).padStart(4, '0'), true, true);
    } else if (dlogResolver) {
      dlogResolver(); dlogResolver = null;
    }
  } else {
    if (textDecoder == null) textDecoder = new TextDecoder();
    const msg = textDecoder.decode(data);
    addLog(msg, '⇓');
    if (msg.startsWith('mtu=') && msg.length > 4) {
      const mtuSize = parseInt(msg.substring(4));
      document.getElementById('mtusize').value = mtuSize;
      addLog(`MTU 已更新为: ${mtuSize}`);
    } else if (msg.startsWith('t=') && msg.length > 2) {
      const t = parseInt(msg.substring(2)) + new Date().getTimezoneOffset() * 60;
      addLog(`远端时间: ${new Date(t * 1000).toLocaleString()}`);
      addLog(`本地时间: ${new Date().toLocaleString()}`);
    }
  }
}

async function connect() {
  if (bleDevice == null || epdCharacteristic != null) return;

  try {
    addLog("正在连接: " + bleDevice.name);
    gattServer = await bleDevice.gatt.connect();
    addLog('  找到 GATT Server');
    epdService = await gattServer.getPrimaryService('62750001-d828-918d-fb46-b6c11c675aec');
    addLog('  找到 EPD Service');
    epdCharacteristic = await epdService.getCharacteristic('62750002-d828-918d-fb46-b6c11c675aec');
    addLog('  找到 Characteristic');
  } catch (e) {
    console.error(e);
    if (e.message) addLog("connect: " + e.message);
    disconnect();
    return;
  }

  let versionData = null;
  try {
    const versionCharacteristic = await epdService.getCharacteristic('62750003-d828-918d-fb46-b6c11c675aec');
    versionData = await versionCharacteristic.readValue();
    appVersion = versionData.getUint8(0);
    if (versionData.byteLength >= 3) {
      // 新协议: [大版本, 小版本, 能力低字节, 能力高字节]
      fwMajor = versionData.getUint8(0);
      fwMinor = versionData.getUint8(1);
      fwCaps = versionData.getUint8(2) | ((versionData.byteLength >= 4 ? versionData.getUint8(3) : 0) << 8);
    } else {
      // 旧固件(原仓库单字节版本): 按版本兜底能力表
      fwMajor = versionData.getUint8(0);
      fwMinor = 0;
      fwCaps = fwCapsFromVersion(fwMajor);
    }
    addLog(`固件版本: ${fwMajor}.${fwMinor} (0x${fwMajor.toString(16)})`);
    addLog(`固件能力: ${capNames(fwCaps)} | 前端版本: ${WEB_VER}`);
  } catch (e) {
    console.error(e);
    appVersion = 0x15;
  }

  // 版本段判定（0x60 升级后路由）:
  //   - 多字节 0x1B（旧私有固件 1b+小版本号）→ 跳旧版上位机（保底收留, /etags/v1b/）
  //   - 多字节 0x60（当前固件）→ 正常使用
  //   - 单字节 ≥0x16（开源固件 / 只有 1b 无小版本号）→ 跳转开源页面
  //   - 单字节 <0x16 → 极旧固件 → 走下方旧版提示
  if (versionData && versionData.byteLength >= 3 && fwMajor === 0x1B) {
    const oldVerURL = "https://luochen7452.github.io/etags/v1b/";
    alert(`检测到旧版固件 (1b.${fwMinor})。\n本页面已升级，仅支持新版固件 (60.x)。\n即将跳转旧版上位机…`);
    location.href = oldVerURL;
    return;
  }
  if (versionData && versionData.byteLength < 3 && fwMajor >= 0x16) {
    const openSrcURL = "https://tsl0922.github.io/EPD-nRF5/?debug=true";
    alert("检测到开源版本固件（单字节版本，无小版本号）。\n本页面仅支持私有协议固件。\n即将跳转开源版上位机…");
    location.href = openSrcURL;
    return;
  }

  if (appVersion < 0x16) {
    const oldURL = "https://tsl0922.github.io/EPD-nRF5/v1.5";
    alert("!!!注意!!!\n当前固件版本过低，可能无法正常使用部分功能，建议升级到最新版本。");
    if (confirm('是否访问旧版本上位机？')) location.href = oldURL;
    setTimeout(() => {
      addLog(`如遇到问题，可访问旧版本上位机: ${oldURL}`);
    }, 500);
  }

  try {
    await epdCharacteristic.startNotifications();
    epdCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
      handleNotify(event.target.value, msgIndex++);
    });
  } catch (e) {
    console.error(e);
    if (e.message) addLog("startNotifications: " + e.message);
  }

  // 型号协商：查询固件支持的屏型号，过滤驱动下拉（旧固件无 GET_MODELS 则跳过）
  try {
    await loadModels();
  } catch (e) { console.error(e); }

  await write(EpdCmd.INIT);

  document.getElementById("connectbutton").innerHTML = '断开';
  updateButtonStatus();
}

function setStatus(statusText) {
  document.getElementById("status").innerHTML = statusText;
}

function addLog(logTXT, action = '') {
  const log = document.getElementById("log");
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ":" +
    String(now.getMinutes()).padStart(2, '0') + ":" +
    String(now.getSeconds()).padStart(2, '0') + " ";

  const logEntry = document.createElement('div');
  const timeSpan = document.createElement('span');
  logEntry.className = 'log-line';
  timeSpan.className = 'time';
  timeSpan.textContent = time;
  logEntry.appendChild(timeSpan);

  if (action !== '') {
    const actionSpan = document.createElement('span');
    actionSpan.className = 'action';
    actionSpan.innerHTML = action;
    logEntry.appendChild(actionSpan);
  }
  logEntry.appendChild(document.createTextNode(logTXT));

  log.appendChild(logEntry);
  log.scrollTop = log.scrollHeight;

  while (log.childNodes.length > 20) {
    log.removeChild(log.firstChild);
  }
}

function clearLog() {
  document.getElementById("log").innerHTML = '';
}

function fillCanvas(style) {
  ctx.fillStyle = style;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function setCanvasTitle(title) {
  const canvasTitle = document.querySelector('.canvas-title');
  if (canvasTitle) {
    canvasTitle.innerText = title;
    canvasTitle.style.display = title && title !== '' ? 'block' : 'none';
  }
}

function updateImage() {
  const imageFile = document.getElementById('imageFile');
  if (imageFile.files.length == 0) {
    // 没选文件：清掉底图，回退到白底模式
    if (paintManager) {
      paintManager.clearBackgroundImage();
      // 切尺寸时画布被重置成白底，模板数据如还在内存里要按新尺寸重绘
      if (paintManager.scheduleData) {
        paintManager.calculateScheduleDimensions();
      }
      if (paintManager.todoData) {
        paintManager.calculateTodoDimensions();
      }
      paintManager.redrawAll();
    } else {
      fillCanvas('white');
    }
    return;
  }

  const image = new Image();
  image.onload = function () {
    URL.revokeObjectURL(this.src);
    if (image.width / image.height == canvas.width / canvas.height) {
      if (cropManager.isCropMode()) cropManager.exitCropMode();
      // 存到底图：模板/笔迹重绘时会自动以这张图为底
      if (paintManager) {
        paintManager.setBackgroundImage(image, { width: image.width, height: image.height });
      }
      // 画布尺寸可能已变，模板 cell 尺寸需要按新画布重算
      if (paintManager && paintManager.scheduleData) paintManager.calculateScheduleDimensions();
      if (paintManager && paintManager.todoData) paintManager.calculateTodoDimensions();
      ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, canvas.width, canvas.height);
      convertDithering();
    } else {
      alert(`图片宽高比例与画布不匹配，将进入裁剪模式。\n请放大图片后移动图片使其充满画布, 再点击"完成"按钮。`);
      paintManager.setActiveTool(null, '');
      cropManager.initializeCrop();
    }
  };
  image.src = URL.createObjectURL(imageFile.files[0]);
}

function updateCanvasSize() {
  const selectedSizeName = document.getElementById('canvasSize').value;
  const selectedSize = canvasSizes.find(size => size.name === selectedSizeName);

  canvas.width = selectedSize.width;
  canvas.height = selectedSize.height;

  updateImage();
}

function updateDitcherOptions() {
  const epdDriverSelect = document.getElementById('epddriver');
  const selectedOption = epdDriverSelect.options[epdDriverSelect.selectedIndex];
  const colorMode = selectedOption.getAttribute('data-color');
  const canvasSize = selectedOption.getAttribute('data-size');

  if (colorMode) document.getElementById('ditherMode').value = colorMode;
  if (canvasSize) document.getElementById('canvasSize').value = canvasSize;

  updateCanvasSize(); // always update image
}

function rotateCanvas() {
  const currentWidth = canvas.width;
  const currentHeight = canvas.height;

  // Capture current canvas content
  const imageData = ctx.getImageData(0, 0, currentWidth, currentHeight);

  // Swap canvas dimensions
  canvas.width = currentHeight;
  canvas.height = currentWidth;

  // Create temporary canvas for rotation
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = currentWidth;
  tempCanvas.height = currentHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.putImageData(imageData, 0, 0);

  // Draw rotated image on the resized canvas
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(90 * Math.PI / 180);
  ctx.drawImage(tempCanvas, -currentWidth / 2, -currentHeight / 2);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform

  paintManager.clearHistory(); // Clear history as canvas size changed
  paintManager.clearElements(); // Clear stored text positions and line segments
  paintManager.clearBackgroundImage(); // 底图引用是原方向的；旋转后画布像素已经旋转过，但 ref 未旋转，再触发 redrawAll 会画错方向
  paintManager.saveToHistory(); // Save rotated canvas to history
}

function clearCanvas() {
  if (confirm('清除画布内容?（底图将保留，笔迹/文字/模板会清掉）')) {
    // 不再 fillCanvas(white) — 让 redrawAll 重新铺底图/白底
    paintManager.clearElements(); // Clear stored text/line segments + 模板数据
    if (cropManager.isCropMode()) cropManager.exitCropMode();
    paintManager.redrawAll();
    paintManager.saveToHistory();
    return true;
  }
  return false;
}

function convertDithering() {
  // 用 redrawAll 一次性叠加：底图 + 笔迹 + 文字 + 课表 + 待办（全在 dither 之前）
  // 注意：paintManager.redrawAll() 内部会先按 cover 画底图，再叠加各层；
  // 即使刚刚 ctx.drawImage 过一遍画布，这里再画一次也安全（结果相同）
  paintManager.redrawAll();

  const contrast = parseFloat(document.getElementById('ditherContrast').value);
  const currentImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const imageData = new ImageData(
    new Uint8ClampedArray(currentImageData.data),
    currentImageData.width,
    currentImageData.height
  );

  adjustContrast(imageData, contrast);

  const alg = document.getElementById('ditherAlg').value;
  const strength = parseFloat(document.getElementById('ditherStrength').value);
  const mode = document.getElementById('ditherMode').value;
  const processedData = processImageData(ditherImage(imageData, alg, strength, mode), mode);
  const finalImageData = decodeProcessedData(processedData, canvas.width, canvas.height, mode);
  ctx.putImageData(finalImageData, 0, 0);

  // dither 之后 putImageData 会把上层（文字/线/模板）盖掉；这里重画一次让画布上能看到最终叠加效果
  // （不写入 history——history 用的是上面 finalImageData 那一刻的状态）
  paintManager.redrawTextElements();
  paintManager.redrawLineSegments();
  if (paintManager.scheduleData && paintManager.scheduleData.length > 0) paintManager.drawSchedule();
  if (paintManager.todoData && paintManager.todoData.length > 0) paintManager.drawTodoList();

  paintManager.saveToHistory(); // Save dithered image to history
}

function applyDither() {
  cropManager.finishCrop(() => convertDithering());
}

function initEventHandlers() {
  document.getElementById("ditherStrength").addEventListener("input", (e) => {
    document.getElementById("ditherStrengthValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
  document.getElementById("ditherContrast").addEventListener("input", (e) => {
    document.getElementById("ditherContrastValue").innerText = parseFloat(e.target.value).toFixed(1);
    applyDither();
  });
}

function checkDebugMode() {
  const link = document.getElementById('debug-toggle');
  const urlParams = new URLSearchParams(window.location.search);
  const debugMode = urlParams.get('debug');

  if (debugMode === 'true') {
    document.body.classList.add('dark-mode');
    link.innerHTML = '正常模式';
    link.setAttribute('href', window.location.pathname);
    addLog("注意：开发模式功能已开启！不懂请不要随意修改，否则后果自负！");
  } else {
    document.body.classList.remove('dark-mode');
    link.innerHTML = '开发模式';
    link.setAttribute('href', window.location.pathname + '?debug=true');
  }
}

document.body.onload = () => {
  textDecoder = null;
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext("2d");

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  paintManager = new PaintManager(canvas, ctx);
  cropManager = new CropManager(canvas, ctx, paintManager);

  paintManager.initPaintTools();
  cropManager.initCropTools();
  initEventHandlers();
  initTemplateGenerator();
  updateButtonStatus();
  checkDebugMode();
  initOTA();

  const webVerEl = document.getElementById('webVer');
  if (webVerEl) webVerEl.textContent = 'v' + WEB_VER;
}
function toggleSettings(open) {
  const panel = document.getElementById('settingsPanel');
  const backdrop = document.getElementById('settingsBackdrop');
  if (!panel || !backdrop) return;
  const show = (typeof open === 'boolean') ? open : !panel.classList.contains('open');
  panel.classList.toggle('open', show);
  backdrop.style.display = show ? 'block' : 'none';
  panel.setAttribute('aria-hidden', show ? 'false' : 'true');
}

// ========================================================================
// 模板生成（课程表 / 待办事项）
// ========================================================================
function generateSchedule() {
  if (!paintManager) return;
  paintManager.createSchedule();
  renderScheduleEditorTable();
  addLog('✅ 已生成课程表，编辑后点发送图片即可传屏');
}

function generateTodo() {
  if (!paintManager) return;
  paintManager.createTodoList();
  renderTodoEditorTable();
  addLog('✅ 已生成待办事项，编辑后点发送图片即可传屏');
}

function clearTemplate() {
  if (!paintManager) return;
  // 只清模板（课表/待办），保留底图 + 笔迹/文字
  paintManager.scheduleData = null;
  paintManager.todoData = null;
  paintManager.clearScheduleCache();
  paintManager.clearTodoCache();
  paintManager.redrawAll();
  paintManager.saveToHistory();
  renderScheduleEditorTable();
  renderTodoEditorTable();
  addLog('🗑 已清除课程表/待办模板（底图与笔迹保留）');
}

// 渲染课程表编辑器网格（输入表 = 课表形状）
function renderScheduleEditorTable() {
  const container = document.getElementById('sch-editor');
  if (!container) return;
  if (!paintManager || !paintManager.scheduleData) {
    container.innerHTML = '';
    return;
  }
  const data = paintManager.scheduleData;
  const cols = data[0].length;
  const rows = data.length;
  let html = `<div class="editor-grid" style="grid-template-columns: repeat(${cols}, minmax(28px, 1fr));">`;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const value = data[i][j] || '';
      const placeholder = (i === 0 && j === 0) ? '·' : '';
      let cls = 'editor-cell-input';
      if (i === 0 || j === 0) cls += ' editor-cell-header';
      if (i === 0 && j === 0) cls += ' editor-cell-corner';
      html += `<input class="${cls}" type="text" data-row="${i}" data-col="${j}" value="${escapeHtml(value)}" placeholder="${placeholder}">`;
    }
  }
  html += '</div>';
  container.innerHTML = html;
  // 绑定 input 事件
  container.querySelectorAll('input[data-row]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const r = parseInt(e.target.dataset.row);
      const c = parseInt(e.target.dataset.col);
      paintManager.updateScheduleCell(r, c, e.target.value);
    });
  });
}

// 渲染待办列表编辑器（一行一输入框 + 复选框）
function renderTodoEditorTable() {
  const container = document.getElementById('todo-editor');
  if (!container) return;
  if (!paintManager || !paintManager.todoData) {
    container.innerHTML = '';
    return;
  }
  const data = paintManager.todoData;
  let html = '';
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const checked = item.done ? 'checked' : '';
    html += `<div class="editor-row">
      <label class="editor-done" title="标记完成"><input type="checkbox" data-idx="${i}" ${checked}></label>
      <input class="editor-cell-input" type="text" data-idx="${i}" value="${escapeHtml(item.text || '')}" placeholder="待办 ${i + 1}">
    </div>`;
  }
  container.innerHTML = html;
  // 绑定事件
  container.querySelectorAll('input[type="text"][data-idx]').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      paintManager.updateTodoCell(idx, e.target.value);
    });
  });
  container.querySelectorAll('input[type="checkbox"][data-idx]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      paintManager.updateTodoDone(idx, e.target.checked);
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function initTemplateGenerator() {
  // 启动时尝试从 localStorage 恢复（先 schedule，再 todo，后者会覆盖前者在画布上的绘制）
  if (paintManager) {
    const hadSchedule = paintManager.loadScheduleFromLocalStorage();
    const hadTodo = paintManager.loadTodoFromLocalStorage();
    if (hadSchedule) renderScheduleEditorTable();
    if (hadTodo) renderTodoEditorTable();
    if (hadSchedule) addLog('📋 已从缓存恢复课程表');
    if (hadTodo) addLog('☑️ 已从缓存恢复待办事项');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('settingsPanel')?.classList.contains('open')) {
    toggleSettings(false);
  }
});
