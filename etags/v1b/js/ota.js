/**
 * ota.js — nRF52 Secure DFU 网页固件升级 (仅 nRF52/52811)
 *
 * 依赖 main.js 的全局函数: addLog / setStatus (同一全局作用域)
 * 协议: Nordic Secure DFU (SDK17 nrf_dfu_ble, 协议 v2)
 *   - DFU 服务 0xFE59, 控制点 8ec90001-..., 数据包 8ec90002-...
 *   - 应用侧 buttonless 特征 8ec90003-... (写 [0x01] 进入 bootloader)
 * 已验证固件参数 (见 SDK/17.1.0_ddde560/components/libraries/bootloader/):
 *   - OP: CREATE=0x01 RECEIPT_NOTIF_SET=0x02 CRC_GET=0x03 EXECUTE=0x04 SELECT=0x06 RESPONSE=0x60
 *   - 控制点写入前必须开启 CCCD 通知, 否则写入被拒
 *   - 数据包特征仅支持 writeWithoutResponse, 用 PRN 回执做流控
 */
'use strict';

/* ================= 常量 ================= */
const DFU = {
  // 0xFE59 是 16 位蓝牙 base UUID, Web Bluetooth 需完整 128 位形式
  SERVICE: '0000fe59-0000-1000-8000-00805f9b34fb',
  CTRL_PT: '8ec90001-f315-4f60-9fb8-838830daea50',
  PKT:     '8ec90002-f315-4f60-9fb8-838830daea50',
  BUTTONLESS:      '8ec90003-f315-4f60-9fb8-838830daea50',
  BUTTONLESS_BOND: '8ec90004-f315-4f60-9fb8-838830daea50',
  NAME: 'DfuTarg',

  OP_PROTOCOL_VERSION: 0x00,
  OP_CREATE: 0x01,
  OP_RECEIPT_NOTIF_SET: 0x02,
  OP_CRC_GET: 0x03,
  OP_EXECUTE: 0x04,
  OP_SELECT: 0x06,
  OP_MTU_GET: 0x07,
  OP_ABORT: 0x0C,
  OP_RESPONSE: 0x60,

  OBJ_COMMAND: 1,
  OBJ_DATA: 2,

  RES_SUCCESS: 0x01,
  RES_INVALID_OBJECT: 0x05,
  RES_EXT_ERROR: 0x0B,

  // 初始数据包净荷长度。bootloader MTU=247 理论上支持 244, 但本固件 balloc
  // 缓冲池仅 17 个 (CODE_PAGE_SIZE/MAX_DFU_PKT_LEN+1=4096/244+1), 且每个 244B
  // 包需拆成 13 次 20B flash 写 (NRF_FSTORAGE_SD_MAX_WRITE_SIZE=20), 消化速度
  // 远低于网页发送速度。若一开始就用 244B, 极易在对象边界 (EXECUTE 触发擦除/
  // 提交) 叠加时压爆缓冲池 → on_write() 静默丢包 → 回执超时 → 固件 flash 阻塞
  // SoftDevice 事件 → 6s 连接监督超时 → 设备物理断连 (见实测日志 offset=4340)。
  // 初始取 128B (4 次 20B 写), 更贴近固件消化能力, 降低断连概率; 失败时
  // Smart Speed 还会逐级降到 64/32/20。connect() 会按协商 MTU 进一步收敛。
  PKT_SIZE: 128,
  // PRN=1: 每发送一个数据包就等待一次固件 CRC 回执(逐包确认)。
  // 固件端 balloc 缓冲池只有 DATA_OBJECT_MAX_SIZE/MAX_DFU_PKT_LEN+1=17 个,
  // buffer 要等 flash 写入完成(20B/次)才释放, 但固件的回执在数据入队 flash 时就发出。
  // 若 PRN>1 且无足够节流, 网页发送速度远超固件消化速度 → 缓冲耗尽 → on_write()
  // 中 nrf_balloc_alloc 失败后静默丢包且不回执 → 网页等回执超时。
  // PRN=1 逐包确认最稳妥: 固件每收到 1 包必发 1 次回执, 任何丢包都会导致
  // 偏移校验失败, 网页立即报错而不是 15 秒超时。代价是速度较慢但足够可靠。
  PRN: 1,
  // 每次 ATT 写入后的节流延时 (ms)。PRN=1 已有逐包确认, 此值只需很小。
  // 但固件每收到一包要: on_write 入队 → fstorage 把 128B 拆成 7 次 20B flash 写
  // (每次 2-4ms) → 缓冲等 flash 写完才释放。连接间隔 15ms (连接事件每 15ms 一次)。
  // 太小会让缓冲池 (17 个) 累积耗尽 → 静默丢包。取 5ms 给 CPU/SoftDevice 喘息。
  WRITE_INTERVAL_MS: 5,
  // 对象提交后 (下一个 CREATE 触发页擦除前) 的额外安全等待 (ms)。
  // 原因: nrf_fstorage_sd 的 m_fifo 队列只有 NRF_FSTORAGE_SD_QUEUE_SIZE=16 个
  // 元素; 每个数据包在固件端要拆成 MAX_WRITE_SIZE=20B 的多次 sd_flash_write,
  // 每个 128B 包会占用 7 个队列元素 (多包排队时最多累积 16 个元素)。
  // 更关键的是: sd_flash_page_erase 与 sd_flash_write 是排队串行执行, 擦除典型
  // 20-90ms、写入每 20B 约 1-3ms。如果网页在 EXECUTE 后立即发下一个 CREATE,
  // 新的页擦除会排在上一个对象尚未完成的收尾写之后, 叠加后单页提交耗时可达
  // 400-600ms; 若网页又立即高速发包, fstorage 队列 (16) 先满, 随后 balloc 缓冲
  // (17 个) 耗尽 → on_write() 静默丢包不回执 → 网页等回执超时; 同时 SoftDevice
  // 被连续 flash 占用导致连接事件无法处理 → 6s 连接监督超时 → 物理断连。
  // 该等待放在 _commitWaitMs 之上, 作为「排空上一对象收尾写 + 准备下一页擦除」的
  // 额外裕量, 是防止对象边界断连的关键。
  OBJ_COMMIT_MARGIN_MS: 200,
  // 收到回执后给固件 flash 写入消化缓冲的时间 (ms)。128B 包需拆成 20B 的 4 次
  // flash 写, 每次约 2-4ms; 留出时间避免缓冲池耗尽。
  // 初始值取 40, 若仍出现丢包 (回执超时/偏移不匹配), Smart Speed 会逐步增大。
  WRITE_SETTLE_MS: 40,
  // 单个数据对象传输失败后的最大重试次数 (含首次之外的重试)。
  // 借鉴参考库 @thib3113/web-bluetooth-dfu: 重试时降速, 且固件端 CREATE 会重置
  // 对象偏移, 重建对象重传是安全的。
  MAX_OBJECT_RETRIES: 4,
  // 重试前的退避延时 (ms): 给固件时间消化排空 fstorage 队列与 balloc 缓冲池。
  RETRY_BACKOFF_MS: 300,
  // 对象边界 EXECUTE 后的提交等待 (ms)。EXECUTE 回执只表示"数据已入队并确认",
  // 固件仍需在后台把整个对象写入 flash (fstorage 队列逐块 20B 写)。
  // 更关键的是下一个对象 CREATE 时会触发 4KB 页擦除 (见固件
  // on_data_obj_create_request → nrf_dfu_flash_erase), 页擦除期间 SoftDevice
  // 被占用、balloc 缓冲 (仅 17 个) 不释放, 若网页端立即高速发包:
  //   1) 缓冲耗尽 → on_write() 静默丢包不回执 → 网页等回执超时
  //   2) flash 连续写阻塞 SoftDevice 事件 → 超过 6s 连接监督超时 → 物理断连
  // 实测日志正是如此: 第一对象(4KB)32 包全成功, EXECUTE 后第二对象第一包
  // 成功回执, 第二包后固件 6s 无回执 → GATT 断连。
  // 这里在对象边界额外等待固定提交时间, 让固件完成页擦除+收尾 flash 写,
  // 避免下一个对象首包入队失败导致回执超时与断连。
  OBJ_COMMIT_MS: 300,
  // CREATE 后等待页擦除完成的时间 (ms)。nRF52 4KB 页擦除典型 20ms、最大约 89ms,
  // 但若 fstorage 队列里还残留上一个对象的收尾写, 擦除会被推迟到队列排空之后,
  // 实际耗时远超标称值。此处给足裕量, 避免擦除期间 SoftDevice 被 flash 持续占用
  // 导致连接事件无法处理 → 6s 连接监督超时 → 物理断连 (实测日志: 第二个对象 CREATE
  // 后 6s 无回执即断连)。250ms 覆盖最坏情况下的擦除启动延迟。
  CREATE_ERASE_MS: 250,
  // EXECUTE 后等待对象提交写 flash 的基础时间 (ms)。EXECUTE 回执只表示数据已入队,
  // 固件仍需把整个对象逐块 (20B/次) 写入 flash 并提交元数据。4KB 对象约 205 次
  // 20B 写, 每次 1-3ms (含 softdevice timeslot 调度), 累计 400-600ms。若此等待不足,
  // 下一个对象 CREATE 的页擦除会与残留写叠加, 同样触发连接监督超时断连。
  // 800ms 为基础值, 实际等待会按对象大小动态增大 (见 _commitWaitMs)。
  EXECUTE_COMMIT_MS: 800,
  // 断连自动重连续传参数。DFU bootloader 断连后不复位 (进度保留在 RAM),
  // 会重新广播 DfuTarg; 网页可 device.gatt.connect() 重连后从固件确认偏移续传。
  // 这是「保证不硬件断连」的最终兜底: 即使 6s 监督超时 (固件写死) 触发物理断连,
  // 也能自动重连并从对象边界继续, 而不是从头开始。
  MAX_RECONNECTS: 10,        // 断连后最大自动重连次数
  RECONNECT_BACKOFF_MS: 800, // 重连失败后的退避延时 (设备重新广播需时间)

  // ---- nRF52811 S112 预编译 bootloader 的 OTA 容量上限 ----
  // 逆向自 bl_nrf52811_xxaa_s112.hex (cache_prepare)：
  //   DFU_REGION_END = 0x29000 - NRF_DFU_APP_DATA_AREA_SIZE(0x2000, 8KB) = 0x27000
  //   最大可 OTA 固件 = 0x27000 - bank0_start(0x19000) = 0xE000 = 57344 B (56KB)
  // 超过上限固件返回 NRF_DFU_RES_CODE_INSUFFICIENT_RESOURCES(4)，
  // 网页表现为「写第一个包后回执无响应 → 超时断连」（并非真正的断连问题）。
  // 与 device 当前跑的旧固件大小无关（bootloader 允许删旧 app 用满整段）。
  MAX_APP_SIZE_NRF52811_S112: 0xE000, // 57344 B
};

function dfuOpName(op) {
  const names = { 0x00: 'PROTOCOL_VERSION', 0x01: 'CREATE', 0x02: 'RECEIPT_NOTIF_SET', 0x03: 'CRC_GET', 0x04: 'EXECUTE', 0x06: 'SELECT', 0x07: 'MTU_GET', 0x0C: 'ABORT' };
  return names[op] || ('0x' + op.toString(16));
}
function dfuResultName(r) {
  const names = { 0x00: 'INVALID', 0x01: 'SUCCESS', 0x02: 'NOT_SUPPORTED', 0x03: 'INVALID_PARAMETER', 0x04: 'INSUFFICIENT_RESOURCES', 0x05: 'INVALID_OBJECT', 0x07: 'UNSUPPORTED_TYPE', 0x08: 'NOT_PERMITTED', 0x0A: 'FAILED', 0x0B: 'EXT_ERROR' };
  return names[r] || ('0x' + r.toString(16));
}
function hexBytes(u8) { return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(''); }

/* ================= Telink OTA (TLSR EPD 应用内升级, 兼容 MiaoPaper 协议) =================
 * 服务 0x221f / 特征 0x331f; 命令 0x00重启 0x01擦扇区 0x02写bank 0x03写缓冲 0x04/05读回 0x06校验和 0x07烧录
 * 与 EPD-TLSR 固件约定: 地址/魔数统一 4 字节大端; bank 256B; 16 位字节累加校验和
 */
const TLK_OTA = {
  SERVICE: '0000221f-0000-1000-8000-00805f9b34fb',
  CHAR:    '0000331f-0000-1000-8000-00805f9b34fb',
  BANK_START: 0x20000,  // OTA 区起始
  AREA_SIZE:  0x20000,  // 128K
  BANK_SIZE:  0x100,    // 256 字节/bank
  SECTOR:     0x1000,   // 4K/扇区
  WRITE_CHUNK: 240,     // 单次 ATT 写入净荷上限 (MTU 247-3)
};

// 16 位字节累加校验和 (与固件 ota_crc_out 一致)
function fwSum16(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xffff;
  return sum;
}

class TelinkOtaClient {
  constructor(device, gatt) {
    this.device = device;
    this.gatt = gatt || null;
    this.char = null;
    this._notifyWait = null;
  }

  async connect() {
    if (!this.gatt) this.gatt = await this.device.gatt.connect();
    const svc = await this.gatt.getPrimaryService(TLK_OTA.SERVICE);
    this.char = await svc.getCharacteristic(TLK_OTA.CHAR);
    await this.char.startNotifications();
    this.char.addEventListener('characteristicvaluechanged', (ev) => {
      const data = new Uint8Array(ev.target.value.buffer);
      if (this._notifyWait) {
        clearTimeout(this._notifyWait.timer);
        const w = this._notifyWait;
        this._notifyWait = null;
        w.resolve(data);
      }
    });
  }

  // 带/不带应答写: 数据包(0x03)用无响应写提速, 擦除/落盘/校验/烧录保持带应答写
  async cmd(bytes, withResponse = true) {
    if (withResponse) await this.char.writeValueWithResponse(bytes);
    else await this.char.writeValueWithoutResponse(bytes);
  }

  // 等待下一次 notify (超时返回 null)
  waitNotify(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      this._notifyWait = { resolve, timer };
    });
  }

  // 等待 GATT 断开 (设备复位重启会断连), 用于确认 0x07 烧录指令已生效
  waitDisconnect(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      const onDisc = () => {
        clearTimeout(timer);
        this.device.removeEventListener('gattserverdisconnected', onDisc);
        resolve(true);
      };
      this.device.addEventListener('gattserverdisconnected', onDisc);
    });
  }

  // 请求设备端累计校验和 (cmd 6)
  async getCrc() {
    await this.cmd(Uint8Array.of(0x06));
    const resp = await this.waitNotify(2000);
    if (resp && resp.length >= 3) return ((resp[1] << 8) | resp[2]) & 0xffff;
    return null;
  }

  async flash(fwBytes) {
    if (fwBytes.length > TLK_OTA.AREA_SIZE) {
      throw new Error(`固件 ${(fwBytes.length / 1024).toFixed(1)}KB 超过 OTA 区 128KB`);
    }
    const area = TLK_OTA.AREA_SIZE;
    addLog(`Telink OTA: 固件 ${(fwBytes.length / 1024).toFixed(1)}KB, 写入 0x20000 (128K)`);

    // 1) 擦除 OTA 区 (32 × 4K)
    setOtaStatus('擦除 OTA 区 (0x20000)...');
    for (let addr = TLK_OTA.BANK_START; addr < TLK_OTA.BANK_START + area; addr += TLK_OTA.SECTOR) {
      await this.cmd(Uint8Array.of(0x01,
        (addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff));
      setOtaProgress(Math.round(((addr - TLK_OTA.BANK_START) / area) * 30));
    }
    addLog('擦除完成');

    // 2) 上传固件 (256B/bank, cmd 3 缓冲 + cmd 2 落盘)
    const banks = Math.ceil(fwBytes.length / TLK_OTA.BANK_SIZE);
    for (let b = 0; b < banks; b++) {
      const off = b * TLK_OTA.BANK_SIZE;
      const chunk = fwBytes.subarray(off, off + TLK_OTA.BANK_SIZE);
      for (let o = 0; o < chunk.length; o += TLK_OTA.WRITE_CHUNK) {
        const slice = chunk.subarray(o, o + TLK_OTA.WRITE_CHUNK);
        const pkt = new Uint8Array(slice.length + 1);
        pkt[0] = 0x03; pkt.set(slice, 1);
        await this.cmd(pkt, false);   // 数据包无需应答, 提速关键 (丢包由末尾校验和兜底)
      }
      const addr = TLK_OTA.BANK_START + off;
      await this.cmd(Uint8Array.of(0x02,
        (addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff));
      setOtaProgress(30 + Math.round(((b + 1) / banks) * 60));
      if ((b & 7) === 7 || b === banks - 1) {
        addLog(`上传中... ${(off / 1024).toFixed(0)}/${(fwBytes.length / 1024).toFixed(0)}KB`);
      }
    }
    addLog('上传完成');

    // 3) 校验: 比较设备累计校验和与本地
    const localSum = fwSum16(fwBytes);
    setOtaStatus('校验中...');
    const devSum = await this.getCrc();
    if (devSum !== null && devSum !== localSum) {
      throw new Error(`校验和不匹配 (设备 0x${devSum.toString(16)} vs 本地 0x${localSum.toString(16)}), 已中止`);
    }
    if (devSum === null) addLog('⚠ 未收到设备校验和, 直接烧录 (固件侧仍会二次校验)');
    else addLog(`校验和一致 (0x${localSum.toString(16)})`);

    // 4) 结束: magic + 校验和 → 固件拷贝主区并重启
    // 注意: 0x07 必须用无响应写 — 设备收到后会禁中断擦主区+拷贝固件并直接复位,
    //      不会回 ATT 应答; 用带应答写会在设备复位时被 Chrome 误报 "GATT operation failed"
    setOtaStatus('校验通过, 写入主区并重启...');
    await this.cmd(Uint8Array.of(0x07, 0xC0, 0x01, 0xCE, 0xED,
      (localSum >>> 8) & 0xff, localSum & 0xff), false);
    setOtaProgress(100);

    // 确认设备确实复位重启 (擦主区+拷贝 128KB 约 5s; 旧固件可能更久)
    addLog('等待设备重启确认...');
    if (await this.waitDisconnect(25000)) {
      addLog('✅ 已检测到设备重启, 固件应用成功');
      return true;
    }
    addLog('⚠ 未检测到设备重启: 若设备版本未更新, 请重新点「开始升级」(指令可能丢失)');
    return false;
  }
}

/* ================= CRC32 (标准 IEEE, 兼容 zlib / nrf_crc32) ================= */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(data) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ================= DEFLATE 解压 (RFC1951) ================= */
function inflateRaw(input) {
  let inPos = 0, inBit = 0;
  const out = [];

  function readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (inPos >= input.length) throw new Error('DEFLATE: 数据不足');
      const bit = (input[inPos] >> inBit) & 1;
      v |= bit << i;
      inBit++;
      if (inBit === 8) { inBit = 0; inPos++; }
    }
    return v;
  }

  function buildTree(lengths) {
    let maxBits = 0;
    for (const l of lengths) if (l > maxBits) maxBits = l;
    const blCount = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) blCount[l]++;
    let code = 0;
    const nextCode = [];
    for (let b = 1; b <= maxBits; b++) {
      code = (code + blCount[b - 1]) << 1;
      nextCode[b] = code;
    }
    const table = new Map();
    for (let sym = 0; sym < lengths.length; sym++) {
      const l = lengths[sym];
      if (l === 0) continue;
      let rev = 0;
      const canon = nextCode[l]++;
      for (let i = 0; i < l; i++) rev = (rev << 1) | ((canon >> i) & 1);
      table.set((l << 16) | rev, sym);
    }
    return { table, maxBits };
  }

  function decodeSym(tree) {
    let code = 0;
    for (let i = 0; i < tree.maxBits; i++) {
      code |= readBits(1) << i;
      const sym = tree.table.get(((i + 1) << 16) | code);
      if (sym !== undefined) return sym;
    }
    throw new Error('DEFLATE: 哈夫曼解码失败');
  }

  const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const CL_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  const fixedLengths = new Array(288).fill(0);
  for (let i = 0; i <= 143; i++) fixedLengths[i] = 8;
  for (let i = 144; i <= 255; i++) fixedLengths[i] = 9;
  for (let i = 256; i <= 279; i++) fixedLengths[i] = 7;
  for (let i = 280; i <= 287; i++) fixedLengths[i] = 8;
  const FIXED_LIT = buildTree(fixedLengths);
  const FIXED_DIST = buildTree(new Array(32).fill(5));

  let final = false;
  while (!final) {
    final = readBits(1) === 1;
    const type = readBits(2);
    if (type === 0) {
      if (inBit !== 0) { inBit = 0; inPos++; }
      if (inPos + 4 > input.length) throw new Error('DEFLATE: stored 块长度不足');
      const len = input[inPos] | (input[inPos + 1] << 8);
      inPos += 4;
      if (inPos + len > input.length) throw new Error('DEFLATE: stored 块数据不足');
      for (let i = 0; i < len; i++) out.push(input[inPos + i]);
      inPos += len;
    } else {
      let litTreeX, distTreeX;
      if (type === 2) {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = readBits(3);
        const clTree = buildTree(clLengths);
        const lengths = new Array(hlit + hdist).fill(0);
        let idx = 0;
        while (idx < hlit + hdist) {
          const sym = decodeSym(clTree);
          if (sym < 16) {
            lengths[idx++] = sym;
          } else if (sym === 16) {
            const rep = readBits(2) + 3;
            if (idx === 0) throw new Error('DEFLATE: 无效的重复');
            const prev = lengths[idx - 1];
            for (let k = 0; k < rep; k++) lengths[idx++] = prev;
          } else if (sym === 17) {
            idx += readBits(3) + 3;
          } else if (sym === 18) {
            idx += readBits(7) + 11;
          }
        }
        litTreeX = buildTree(lengths.slice(0, hlit));
        distTreeX = buildTree(lengths.slice(hlit));
      } else {
        litTreeX = FIXED_LIT;
        distTreeX = FIXED_DIST;
      }

      while (true) {
        const sym = decodeSym(litTreeX);
        if (sym < 256) {
          out.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          const length = LEN_BASE[li] + readBits(LEN_EXTRA[li]);
          const distSym = decodeSym(distTreeX);
          const dist = DIST_BASE[distSym] + readBits(DIST_EXTRA[distSym]);
          if (dist > out.length) throw new Error('DEFLATE: 距离超出窗口');
          for (let k = 0; k < length; k++) out.push(out[out.length - dist]);
        }
      }
    }
  }
  return new Uint8Array(out);
}

/* ================= ZIP 解析 (STORE + DEFLATE) ================= */
function zipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const min = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件');
  const entryCount = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  let pos = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break;
    const method = dv.getUint16(pos + 10, true);
    const compSize = dv.getUint32(pos + 20, true);
    const uncompSize = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localOffset = dv.getUint32(pos + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP 本地头损坏: ' + name);
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRaw(raw);
    else throw new Error('不支持的 ZIP 压缩方式: ' + method);
    if (data.length !== uncompSize) {
      throw new Error('ZIP 解压长度不符: ' + name + ' (' + data.length + ' != ' + uncompSize + ')');
    }
    entries.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ================= DFU 包解析 ================= */
let otaPackage = null;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* ---- .dat init 包 protobuf 解析 (dfu-cc.proto, 轻量手写解码) ----
 * 新版 nrfutil pkg generate 生成的 manifest.json 只有 bin_file/dat_file,
 * fw_version/hw_version/sd_req 等元数据编码在 .dat init 包 (protobuf) 里。
 * 实测嵌套路径: Packet.command(2) -> command.info(1) -> info.init(2)
 * init{ fw_version(1 varint), hw_version(2 varint), sd_req(3 packed),
 *       type(4), sd_size(5), bl_size(6), app_size(7), hash(8), is_debug(9),
 *       boot_validation(10) }
 * 本函数只提取显示所需字段, 失败时返回 null (不阻塞解析流程)。
 */
function parseDfuInitInfo(initBytes) {
  if (!initBytes || initBytes.length < 4) return null;
  const b = initBytes;
  let i = 0;
  function readVarint() {
    let v = 0, shift = 0;
    while (i < b.length) {
      const byte = b[i++];
      v |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return v >>> 0;
      shift += 7;
      if (shift > 28) throw new Error('varint 过长');
    }
    throw new Error('varint 截断');
  }
  function skip(len) { i += len; }
  // 在当前层级找到 field 号为 nestedField 的 bytes 字段并返回其内容边界
  function enterField(nestedField) {
    while (i < b.length) {
      const tag = readVarint();
      const field = tag >>> 3;
      const wt = tag & 7;
      if (field === nestedField && wt === 2) {
        const len = readVarint();
        const end = i + len;
        const start = i;
        return { start, end, len };
      }
      if (wt === 0) readVarint();
      else if (wt === 2) skip(readVarint());
      else if (wt === 5) i += 4;
      else if (wt === 1) i += 8;
      else throw new Error('未知 wire type ' + wt);
    }
    throw new Error('未找到 field ' + nestedField);
  }

  try {
    const cmd = enterField(2);   // Packet.command
    i = cmd.start;
    const wrap = enterField(1);  // command.info (包裹层)
    i = wrap.start;
    const init = enterField(2);  // info.init
    i = init.start;
    const end = init.end;
    const info = {};
    while (i < end) {
      const tag = readVarint();
      const field = tag >>> 3;
      const wt = tag & 7;
      if (wt === 0) {
        const v = readVarint();
        if (field === 1) info.fw_version = v;
        else if (field === 2) info.hw_version = v;
        else if (field === 4) info.type = v;
        else if (field === 5) info.sd_size = v;
        else if (field === 6) info.bl_size = v;
        else if (field === 7) info.app_size = v;
        else if (field === 9) info.is_debug = !!v;
      } else if (wt === 2) {
        const len = readVarint();
        if (field === 3) {
          // sd_req packed repeated uint32
          const sdEnd = i + len;
          const sdReq = [];
          while (i < sdEnd) sdReq.push(readVarint());
          info.sd_req = sdReq;
        } else {
          i += len;
        }
      } else if (wt === 5) i += 4;
      else if (wt === 1) i += 8;
      else throw new Error('未知 wire type ' + wt);
    }
    // 校验: 至少解析到关键字段才算成功 (防止 fallback 到错误层级)
    if (info.fw_version === undefined && info.app_size === undefined) return null;
    return info;
  } catch (e) {
    return null;
  }
}

// 由固件类型枚举值转可读名称 (dfu-cc.proto FwType)
function dfuFwTypeName(t) {
  const names = ['应用固件', 'SoftDevice', 'Bootloader', 'SD+BL', '外部应用'];
  return names[t] || ('类型 ' + t);
}

function intelHexToBytes(hexText) {
  const data = new Map();
  let maxAddr = 0;
  for (const line of hexText.split(/\r?\n/)) {
    if (!line || line[0] !== ':') continue;
    const count = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);
    if (type === 0) {
      for (let i = 0; i < count; i++) {
        data.set(addr + i, parseInt(line.substr(9 + i * 2, 2), 16));
        maxAddr = Math.max(maxAddr, addr + i);
      }
    }
  }
  const buf = new Uint8Array(maxAddr + 1);
  for (const [a, b] of data) buf[a] = b;
  return buf;
}

async function otaSelectFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/\.(zip|bin)$/i.test(file.name)) { addLog('请选择 .zip (nRF5) 或 .bin (Telink) 固件'); return; }
  try {
    const buf = new Uint8Array(await file.arrayBuffer());

    // Telink TLSR 裸固件 (.bin) — 应用内 OTA, 无需 init 包
    if (/\.bin$/i.test(file.name)) {
      otaPackage = { file, type: 'telink', fwName: file.name, fwBytes: buf };
      const info = document.getElementById('otaInfo');
      if (info) info.innerHTML =
        `<div>固件: <b>${file.name}</b> (${(buf.length / 1024).toFixed(1)} KB)</div>` +
        `<div>类型: <b>Telink TLSR 固件</b> (应用内 OTA, 无 init 包)</div>`;
      addLog(`Telink 固件已加载: ${file.name} ${(buf.length / 1024).toFixed(1)}KB`);
      return;
    }

    addLog(`解析 OTA 包: ${file.name} (${(file.size / 1024).toFixed(1)} KB)...`);
    const entries = zipEntries(buf);
    if (!entries.has('manifest.json')) throw new Error('包内没有 manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
    const m = manifest.manifest || manifest;
    const app = m.application;
    if (!app) throw new Error('该 OTA 包不是 application 固件（仅支持应用升级）');

    const binName = app.bin_file || app.hex_file;
    const datName = app.dat_file;
    let fwBytes = entries.get(binName);
    if (!fwBytes) throw new Error(`包内缺少固件文件: ${binName}`);
    if (/\.hex$/i.test(binName)) fwBytes = intelHexToBytes(new TextDecoder().decode(fwBytes));

    let initBytes;
    if (datName && entries.has(datName)) initBytes = entries.get(datName);
    else if (app.init_packet_data) initBytes = base64ToBytes(app.init_packet_data);
    if (!initBytes) throw new Error('包内缺少 init 包 (.dat)');

    otaPackage = { file, type: 'zip', manifest, fwName: binName, fwBytes, initBytes };

    // 新版 nrfutil (v7+) pkg generate 生成的 manifest.json 只有 bin_file/dat_file,
    // fw_version/sd_req 编码在 .dat init 包 (protobuf) 里。优先用 manifest 字段,
    // 缺失时从 init 包解析 (解析失败则显示"未知")。
    let fwVersion = app.fw_version != null ? ('0x' + Number(app.fw_version).toString(16)) : null;
    let sdReq = app.sd_req ? app.sd_req.join(',') : null;
    let fwType = null;
    let hwVersion = null;
    let appSize = null;
    const initInfo = parseDfuInitInfo(initBytes);
    if (initInfo) {
      if (fwVersion === null && initInfo.fw_version != null) fwVersion = '0x' + Number(initInfo.fw_version).toString(16);
      if (sdReq === null && initInfo.sd_req && initInfo.sd_req.length) sdReq = initInfo.sd_req.map(v => '0x' + Number(v).toString(16)).join(',');
      if (initInfo.type != null) fwType = dfuFwTypeName(initInfo.type);
      if (initInfo.hw_version != null) hwVersion = initInfo.hw_version;
      if (initInfo.app_size != null) appSize = initInfo.app_size;
    }
    fwVersion = fwVersion || '未知';
    sdReq = sdReq || '未知';

    const info = document.getElementById('otaInfo');
    if (info) {
      let meta = `<div>应用版本: ${fwVersion}`;
      if (hwVersion != null) meta += ` | 硬件版本: ${hwVersion}`;
      meta += ` | 要求 SoftDevice: ${sdReq} | init 包: ${initBytes.length} B</div>`;
      if (fwType) meta += `<div>固件类型: ${fwType}`;
      if (appSize != null) meta += ` | 固件大小: ${(appSize / 1024).toFixed(1)} KB`;
      meta += '</div>';
      info.innerHTML =
        `<div>固件: <b>${binName}</b> (${(fwBytes.length / 1024).toFixed(1)} KB)</div>` + meta;
    }
    // ---- nRF52811 S112 固件大小上限提示 (提前拦截, 避免 DFU 返回
    // INSUFFICIENT_RESOURCES(4) 表现为「写第一个包后断连」的假象) ----
    if (fwBytes.length > DFU.MAX_APP_SIZE_NRF52811_S112) {
      const warn = `⚠ 固件大小 ${(fwBytes.length / 1024).toFixed(1)} KB 超过 nRF52811 S112 bootloader 的 OTA 上限 ` +
        `${(DFU.MAX_APP_SIZE_NRF52811_S112 / 1024).toFixed(1)} KB (${DFU.MAX_APP_SIZE_NRF52811_S112} B)。` +
        '升级会失败: 写第一个包后无回执→超时断连。请精简固件（如移除 RTT 日志）使其 ≤ 56.0 KB。';
      addLog(warn);
      const info2 = document.getElementById('otaInfo');
      if (info2) info2.insertAdjacentHTML('beforeend', `<div style="color:#e06c75;font-weight:bold">${warn}</div>`);
    } else {
      addLog(`固件大小 ${(fwBytes.length / 1024).toFixed(1)} KB ≤ 上限 ${(DFU.MAX_APP_SIZE_NRF52811_S112 / 1024).toFixed(1)} KB，可以 OTA`);
    }
    addLog(`OTA 包解析成功: 固件 ${binName} ${(fwBytes.length / 1024).toFixed(1)}KB, init ${initBytes.length}B`);
  } catch (e) {
    console.error(e);
    otaPackage = null;
    const info = document.getElementById('otaInfo');
    if (info) info.innerHTML = '';
    addLog('OTA 包解析失败: ' + e.message);
  }
}

/* ================= Secure DFU 客户端 ================= */
function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// 断连错误: 用于区分「物理断连」(可重连续传) 与普通传输失败 (对象级重试)。
class DfuDisconnectError extends Error {
  constructor(msg) {
    super(msg || 'GATT 连接已断开 (设备物理断连)');
    this.name = 'DfuDisconnectError';
  }
}
function isDfuDisconnectError(e) {
  return !!e && (e instanceof DfuDisconnectError ||
    (e.name === 'DfuDisconnectError') ||
    (typeof e.message === 'string' && e.message.indexOf('GATT 连接已断开') >= 0));
}

class DfuClient {
  constructor(device) {
    this.device = device;
    this.gatt = null;
    this.ctrlPt = null;
    this.pkt = null;
    this.respQueue = [];
    this.respWaiters = [];
    this._writeQueue = Promise.resolve();
    // 断连检测: 固件在高速写入期间可能因 flash 阻塞 SoftDevice 事件处理超过
    // 连接监督超时(固件 NRF_DFU_BLE_CONN_SUP_TIMEOUT_MS=6000ms=6s)而物理断连。
    // 若不做检测, 网页会一直等到 15s 回执超时才报 "GATT Server is disconnected",
    // 浪费大量时间且误导 (真正原因在固件消化速度)。这里监听断连事件并立即
    // 拒绝所有挂起的响应等待, 让升级快速失败并提示真正的处理方向。
    this._disconnected = false;
    this._disconnectErr = null;
    this._disconnectListener = null;
    // 运行时可调参数: 数据包长度 / 消化延时 (Smart Speed 降级时修改)
    this.pktSize = DFU.PKT_SIZE;
    this.settleMs = DFU.WRITE_SETTLE_MS;
    this.objIdx = 0;
    // 断连自动重连状态
    this.reconnectCount = 0;
  }

  async connect() {
    this.gatt = await this.device.gatt.connect();
    this._disconnected = false;
    // 注册断连监听: 立即把等待中的响应全部以明确错误拒绝 (不等 15s 超时)
    this._disconnectListener = () => this.handleDisconnect();
    this.device.addEventListener('gattserverdisconnected', this._disconnectListener);
    addLog(`已连接 DFU 设备: ${this.device.name || '(无名称)'}`);
    // 读取协商后的 ATT MTU, 自适应数据包净荷长度。
    // 若数据包净荷超过实际 MTU, writeValueWithoutResponse 会把一个块拆成多次
    // ATT 写入, 导致 PRN 计数错位 (固件按 ATT 写入事件计数)。
    // 这里主动按协商 MTU 对齐, 避免拆分。MTU 不可用时退回默认 PKT_SIZE。
    await this._configurePktSize();
    const svc = await this.gatt.getPrimaryService(DFU.SERVICE);
    this.ctrlPt = await svc.getCharacteristic(DFU.CTRL_PT);
    this.pkt = await svc.getCharacteristic(DFU.PKT);
    // 必须先开启 CCCD 通知, 否则控制点写入会被固件拒绝
    await this.ctrlPt.startNotifications();
    this.ctrlPt.addEventListener('characteristicvaluechanged', (e) => {
      this.onNotify(new Uint8Array(e.target.value.buffer));
    });
  }

  // 按协商 MTU 自适应数据包净荷长度 (防止一个块被拆成多次 ATT 写入导致 PRN 错位)
  async _configurePktSize() {
    let mtu = 0;
    try { if (this.gatt && this.gatt.getMTU) mtu = await this.gatt.getMTU(); } catch (e) { /* 忽略 */ }
    // 净荷长度 = MTU - 3 (ATT 头), 并对齐到 4 字节 (固件 flash 写入按 word 对齐)。
    // 同时取 min(PKT_SIZE) 作为上限: 即使 MTU 支持 244B, 也先按保守的 128B 起步,
    // 避免一次性压爆固件 balloc 缓冲池导致断连。Smart Speed 会在失败时进一步降档。
    if (mtu >= 23) {
      const mtuPkt = Math.max(20, Math.floor((mtu - 3) / 4) * 4);
      this.pktSize = Math.min(DFU.PKT_SIZE, mtuPkt);
    } else {
      this.pktSize = DFU.PKT_SIZE;
    }
    addLog(`ATT MTU: ${mtu || '未知'} → 数据包净荷 ${this.pktSize}B`);
  }

  // 确保已连接; 若断连则自动重连并重新初始化服务/特征/通知。
  // DFU bootloader 断连后不复位 (进度保留在 RAM), 会重新广播 DfuTarg,
  // 因此同一 device 对象可直接 gatt.connect() 重连。
  async ensureConnected() {
    if (this.gatt && this.gatt.connected) return true;
    if (!this.device) throw new DfuDisconnectError('无设备引用, 无法自动重连');
    addLog('正在自动重连 DFU 设备...');
    let attempts = Math.max(1, DFU.MAX_RECONNECTS);
    while (attempts > 0) {
      attempts--;
      try {
        this.gatt = await this.device.gatt.connect();
        this._disconnected = false;
        const svc = await this.gatt.getPrimaryService(DFU.SERVICE);
        this.ctrlPt = await svc.getCharacteristic(DFU.CTRL_PT);
        this.pkt = await svc.getCharacteristic(DFU.PKT);
        await this.ctrlPt.startNotifications();
        this.ctrlPt.addEventListener('characteristicvaluechanged', (e) => {
          this.onNotify(new Uint8Array(e.target.value.buffer));
        });
        if (!this._disconnectListener) {
          this._disconnectListener = () => this.handleDisconnect();
          this.device.addEventListener('gattserverdisconnected', this._disconnectListener);
        }
        await this._configurePktSize();
        this.resetWriteQueue();
        addLog('✅ 自动重连成功');
        return true;
      } catch (e) {
        addLog(`重连失败 (剩余 ${attempts} 次): ${e.message || e}`);
        if (attempts <= 0) throw new DfuDisconnectError('自动重连失败: ' + (e.message || e));
        await new Promise(r => setTimeout(r, DFU.RECONNECT_BACKOFF_MS));
      }
    }
    throw new DfuDisconnectError('自动重连失败');
  }

  // 断连处理: 标记断连, 拒绝所有等待中的响应 (让等待方立即失败而不是超时)
  handleDisconnect() {
    if (this._disconnected) return;
    this._disconnected = true;
    this._disconnectErr = new DfuDisconnectError();
    addLog('⚠ 检测到 GATT 连接断开 (设备可能因 flash 写入阻塞导致连接监督超时), 将尝试自动重连续传');
    // 拒绝所有挂起的 response waiter
    while (this.respWaiters.length) this.respWaiters.shift().reject(this._disconnectErr);
    this.respQueue = [];
  }

  disconnect() {
    if (this._disconnectListener) {
      try { this.device.removeEventListener('gattserverdisconnected', this._disconnectListener); } catch (e) { /* ignore */ }
      this._disconnectListener = null;
    }
    try { if (this.gatt && this.gatt.connected) this.gatt.disconnect(); } catch (e) { /* ignore */ }
  }

  onNotify(bytes) {
    // 诊断: 记录收到的固件通知帧 (op + offset), 用于排查 PRN 回执是否/何时到达
    try {
      if (bytes.length >= 3 && bytes[0] === DFU.OP_RESPONSE) {
        const op = bytes[1];
        const off = (bytes.length >= 7) ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(3, true) : -1;
        addLog(`[RX] op=0x${op.toString(16)} (${dfuOpName(op)}) offset=${off}`);
      }
    } catch (e) { /* 忽略 */ }
    if (this.respWaiters.length) this.respWaiters.shift().resolve(bytes);
    else this.respQueue.push(bytes);
  }

  waitResponse() {
    return new Promise((resolve, reject) => {
      if (this.respQueue.length) resolve(this.respQueue.shift());
      else if (this._disconnected) reject(this._disconnectErr || new Error('GATT 连接已断开'));
      else this.respWaiters.push({ resolve, reject });
    });
  }

  parseResponse(resp, expectedOp) {
    if (resp.length < 3 || resp[0] !== DFU.OP_RESPONSE) throw new Error('非法响应帧: ' + hexBytes(resp));
    const op = resp[1];
    const result = resp[2];
    if (result !== DFU.RES_SUCCESS) {
      let msg = `DFU 操作 ${dfuOpName(op)} 失败: ${dfuResultName(result)}`;
      if (result === DFU.RES_EXT_ERROR && resp.length >= 4) msg += ` (扩展错误 0x${resp[3].toString(16)})`;
      if (result === DFU.RES_INVALID_OBJECT) msg += ' — 请确认 OTA 包是用与设备匹配的 make-ota 生成（硬件版本/SoftDevice/签名/应用版本正确）';
      throw new Error(msg);
    }
    const dv = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    if (op === DFU.OP_SELECT) return { op, maxSize: dv.getUint32(3, true), offset: dv.getUint32(7, true), crc: dv.getUint32(11, true) };
    if (op === DFU.OP_CRC_GET) return { op, offset: dv.getUint32(3, true), crc: dv.getUint32(7, true) };
    return { op };
  }

  async ctrlOp(opCode, args = []) {
    // 借鉴参考库 @thib3113/web-bluetooth-dfu 的 sendOperation:
    // 控制点写入串行化, 消除 "GATT operation already in progress" 错误。
    // 固件的每条响应都是独立的 characteristicvaluechanged 通知, 由 onNotify
    // 单独入队, 这里只需等一条即可 (响应帧结构与等待目标由调用方保证串行)。
    await this.queuedWrite(this.ctrlPt, Uint8Array.from([opCode, ...args]));
    const parsed = await withTimeout(this.waitResponse(), 10000, '等待 DFU 响应超时 (' + dfuOpName(opCode) + ')');
    return this.parseResponse(parsed, opCode);
  }

  // 排队串行化写入: 同一连接上所有 GATT 写 (控制点/数据包) 共享一个 Promise 链,
  // 一次只允许一个 ATT 写进行, 从根本上消除 Web Bluetooth 的
  // "GATT operation already in progress" 错误 (数据包用 writeWithoutResponse,
  // 底层也可能因跨特征并发写被拒绝)。参考 @thib3113/web-bluetooth-dfu 的
  // queuedWrite: 遇 "in progress" 错误等待后重试最多 15 次。
  queuedWrite(char, value) {
    if (this._disconnected) return Promise.reject(this._disconnectErr || new Error('GATT 连接已断开'));
    const op = this._writeQueue.then(async () => {
      let attempts = 15;
      while (attempts > 0) {
        try {
          if (char === this.pkt) await char.writeValueWithoutResponse(value);
          else await char.writeValueWithResponse(value);
          return value;
        } catch (e) {
          // 断连错误 (GATT Server is disconnected / NetworkError) 立即抛出, 不重试
          if (e && e.message && (e.message.indexOf('in progress') >= 0)) {
            attempts--;
            await new Promise(r => setTimeout(r, 150));
          } else {
            throw e;
          }
        }
      }
      throw new Error('GATT 写入失败 (Device Busy): 连续 15 次 "operation in progress"');
    });
    // 链式串行化: 无论成功失败都要让后续写继续排队, 失败错误由当前调用者 catch
    this._writeQueue = op.catch(() => {});
    return op;
  }

  // 每次传输 (对象) 开始前重置写队列, 保证重试路径也串行
  resetWriteQueue() { this._writeQueue = Promise.resolve(); }

  // 向固件查询指定类型对象的当前偏移 (SELECT), 用于失败后确认固件端真实进度,
  // 决定整个对象重传还是跳过已确认完成的块。
  async selectOffset(objectType) {
    const sel = await this.ctrlOp(DFU.OP_SELECT, [objectType]);
    return { maxSize: sel.maxSize, offset: sel.offset, crc: sel.crc };
  }

  // Smart Speed 降级: 先逐档降低数据包长度 (缓解 MTU/缓冲压力), 到底后
  // 再递增「收到回执后的消化延时」, 给固件 flash 写入留更多时间。
  // 借鉴参考库 SAFE_TIERS 逐级降档思想, 但针对本固件 (balloc 缓冲池仅 17 个)
  // 以「消化时间」为最终手段, 因为这是固件静默丢包的真正原因。
  degradeSpeed(reason) {
    // 降档序列从当前值开始; 初始 128, 逐级降到 64/32/20
    const tiers = [128, 64, 32, 20];
    const idx = tiers.indexOf(this.pktSize);
    if (idx >= 0 && idx < tiers.length - 1) {
      this.pktSize = tiers[idx + 1];
      this.settleMs = Math.max(this.settleMs, 40);
      addLog(`⚠ 降速: 数据包 ${tiers[idx]}→${this.pktSize}B (${reason})`);
    } else {
      // MTU 已到底, 递增消化延时给 flash 更多消化时间 (每次 +60ms, 上限 500ms)
      this.settleMs = Math.min(this.settleMs + 60, 500);
      addLog(`⚠ 降速: 包长 ${this.pktSize}B 已达下限, 消化延时 ${this.settleMs}ms (${reason})`);
    }
  }

  // 写数据包 (整段, 内部按 pktSize 分块), 每块通过写互斥队列发送。
  // 返回本次实际发起的 ATT 写入次数 —— 固件端 PRN 按「每个 ATT 写入事件」递减计数,
  // 网页端必须用同样的粒度计数, 否则 PRN 回执时机错位导致流控失效。
  async writePacket(part) {
    const len = this.pktSize || DFU.PKT_SIZE;
    let off = 0;
    let written = 0;
    while (off < part.length) {
      if (this._disconnected) {
        throw new DfuDisconnectError();
      }
      const chunk = part.subarray(off, off + len);
      await this.queuedWrite(this.pkt, chunk);
      off += chunk.length;
      written++;
      // 节流: 给固件留出处理 (入队 flash) 的时间
      await new Promise(r => setTimeout(r, DFU.WRITE_INTERVAL_MS));
    }
    return written;
  }

  // 发送一段数据, 按 PRN 间隔等待固件 CRC 回执并校验偏移。
  // baseOffset 为全局固件偏移 (固件回执返回全局累计偏移)。
  // 抛错时由调用者 (transferObject) 决定是否重试整个对象。
  async writeData(bytes, baseOffset = 0) {
    const prn = DFU.PRN;
    let off = 0;
    let since = 0;   // 距上次回执以来的 ATT 写入次数 (与固件端计数粒度一致)
    while (off < bytes.length) {
      if (this._disconnected) {
        throw new DfuDisconnectError();
      }
      const part = bytes.subarray(off, off + (this.pktSize || DFU.PKT_SIZE));
      const n = await this.writePacket(part);
      off += part.length;
      since += n;
      if (prn > 0 && since >= prn) {
        // 固件每收到 PRN 个 ATT 写入会回一个 CRC 响应 (op=CRC_GET), 用作流控。
        // 固件的回执在数据「入队 flash」时就发出(不等 flash 写完), 因此收到回执后
        // 再额外等待 settleMs, 让固件有时间完成 flash 写并释放 balloc 缓冲,
        // 否则累积超过缓冲池(17)会被 on_write() 静默丢弃(不回执)导致超时。
        // 固件回执入队即发(通常几 ms 内), 若长时间未到多半是断连或固件卡死。
        // 断连时 handleDisconnect 会立即 reject; 这里超时设 8s 已足够宽容
        // flash 写入的暂时阻塞, 同时避免像之前那样傻等 15s 才暴露断连。
        const resp = await this.waitResponseWithTimeout(8000);
        const crc = this.parseResponse(resp, DFU.OP_CRC_GET);
        // 校验回执偏移 (固件返回的是全局累计偏移), 防止响应错位
        if (crc.offset !== baseOffset + off) {
          throw new Error(`PRN 回执偏移不匹配 (期望 ${baseOffset + off}, 收到 ${crc.offset}) — 固件可能已静默丢包`);
        }
        await new Promise(r => setTimeout(r, this.settleMs));
        since = 0;
      }
    }
  }

  // 带超时的 waitResponse: 超时后把残留 waiter 从队列移除, 避免之后到来的
  // 回执被无主 waiter 吞掉导致下一次等待永远超时。断连时立即拒绝。
  waitResponseWithTimeout(ms) {
    if (this._disconnected) return Promise.reject(this._disconnectErr || new Error('GATT 连接已断开'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.respWaiters.indexOf(waiter);
        if (i >= 0) this.respWaiters.splice(i, 1);
        reject(new Error('等待 PRN 回执超时'));
      }, ms);
      const waiter = {
        resolve: (bytes) => { clearTimeout(timer); resolve(bytes); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
      if (this.respQueue.length) waiter.resolve(this.respQueue.shift());
      else if (this._disconnected) waiter.reject(this._disconnectErr || new Error('GATT 连接已断开'));
      else this.respWaiters.push(waiter);
    });
  }

  // 对象 EXECUTE 后的提交等待: 按对象大小动态估算 flash 提交耗时。
  // 4KB 对象 4096/20 ≈ 205 次 20B flash 写, 每次 1-3ms, 叠加 softdevice timeslot
  // 调度与页擦除, 单对象提交可达 400-600ms; 128KB 大对象 (若 maxObject 较大)
  // 则按比例增大, 上限封顶避免一个对象等太久。等待不足会导致下一个对象 CREATE
  // 的页擦除与残留写叠加 → 连接监督超时断连。
  _commitWaitMs(objSize) {
    const flashWrites = Math.ceil(objSize / 20);
    const est = flashWrites * 2 + 50;   // 每次 20B 写约 2ms, 加上提交元数据开销
    return Math.min(Math.max(est, DFU.EXECUTE_COMMIT_MS), 1200);
  }

  // 传输一个数据对象 (CREATE → 写数据 → CRC_GET → EXECUTE), 作为可重试单元。
  // 借鉴参考库 transferObject: 失败时降速 (degradeSpeed) 后重建对象重传,
  // 并先 SELECT 确认固件端真实进度, 避免重复写入已确认完成的块。
  // 固件端 on_data_obj_create_request 每次 CREATE 都会把偏移重置回对象起点,
  // 因此重建对象重传是安全的 (参考库同样采用整个对象重传策略)。
  async transferObject(bytes, baseOffset, maxSize) {
    const objIdx = this.objIdx++;
    let attempt = 0;
    let lastError = null;
    while (attempt <= DFU.MAX_OBJECT_RETRIES) {
      attempt++;
      // 断连: 抛出断连错误, 由 flash() 层自动重连续传 (不在此处降速重试,
      // 因为物理断连后 SELECT/CREATE/write 全部会失败, 且对象可能已部分接收)
      if (this._disconnected) {
        throw new DfuDisconnectError();
      }
      if (attempt > 1) {
        addLog(`重试固件块 ${objIdx} (第 ${attempt}/${DFU.MAX_OBJECT_RETRIES + 1} 次): ${lastError}`);
        // 给固件时间消化排空, 并降速
        await new Promise(r => setTimeout(r, DFU.RETRY_BACKOFF_MS));
        this.degradeSpeed(lastError);
        this.resetWriteQueue();
        // 重试前查询固件端真实进度: 若上一对象已完整执行 (offset 越过本对象),
        // 说明失败发生在 EXECUTE 回执丢失, 无需重传本对象。
        let st = null;
        try { st = await this.selectOffset(DFU.OBJ_DATA); } catch (e) { /* SELECT 失败则按全量重传 */ }
        if (st && st.offset >= baseOffset + bytes.length) {
          addLog(`固件已确认块 ${objIdx} 完成 (offset=${st.offset}), 跳过重传`);
          return;
        }
        if (st && st.offset > baseOffset) {
          // 固件端已写入部分数据但对象未完成, 重建对象只能从头传
          addLog(`固件端块 ${objIdx} 已部分写入 (offset=${st.offset}), 需重建对象从头重传`);
        }
      }

      try {
        await this.ctrlOp(DFU.OP_CREATE, [DFU.OBJ_DATA, bytes.length & 0xFF, (bytes.length >> 8) & 0xFF, (bytes.length >> 16) & 0xFF, (bytes.length >> 24) & 0xFF]);
        // CREATE 回执不代表页擦除完成! 固件 on_data_obj_create_request 会
        // nrf_dfu_flash_erase() 擦除本对象对应的 4KB flash 页 (异步入队后立即回执)。
        // 页擦除期间 (nRF52 ~20-90ms) SoftDevice 被占用、balloc 缓冲不释放。
        // 若立即写第一包, 擦除 + 写叠加会瞬间压爆 17 个缓冲 → 静默丢包 → 断连。
        // 这里在 CREATE 后、写第一包前等待, 给页擦除完成的时间。等待时间取
        // CREATE_ERASE_MS (250ms), 覆盖最坏情况下擦除被 fstorage 残留写推迟的情况。
        await new Promise(r => setTimeout(r, DFU.CREATE_ERASE_MS));
        await this.writeData(bytes, baseOffset);
        await this.ctrlOp(DFU.OP_CRC_GET);
        await this.ctrlOp(DFU.OP_EXECUTE);
        // EXECUTE 回执只表示"数据已入队并确认", 固件仍需在后台把整个对象写入 flash
        // (fstorage 队列逐块 20B 写)。若立即开始下一个对象, 缓冲池可能仍被占用,
        // 下一个对象 CREATE 的页擦除会与残留写叠加 → 同样压爆缓冲池导致断连。
        // 这里在 EXECUTE 后等待对象提交写 flash 完成, 等待时间按对象大小动态估算,
        // 再叠加一个固定裕量 (排空收尾写 + 准备下一页擦除), 彻底避免对象边界断连。
        await new Promise(r => setTimeout(r, this._commitWaitMs(bytes.length) + DFU.OBJ_COMMIT_MARGIN_MS));
        return;
      } catch (e) {
        // 断连错误不重试: 抛给 flash() 层自动重连续传
        if (isDfuDisconnectError(e)) {
          throw new DfuDisconnectError('传输中断连: ' + (e.message || ''));
        }
        lastError = e.message;
        if (attempt > DFU.MAX_OBJECT_RETRIES) throw new Error(`固件块 ${objIdx} 传输失败 (重试 ${DFU.MAX_OBJECT_RETRIES} 次): ${e.message}`);
      }
    }
  }

  async flash(fwBytes, initBytes) {
    // 重置运行时流控参数, 避免上次升级的降速状态残留 (connect 已按 MTU 设好 pktSize)
    this.settleMs = DFU.WRITE_SETTLE_MS;
    this.objIdx = 0;
    this.reconnectCount = 0;

    // 0) 前置校验: 固件超过 bootloader 容量上限则直接中止
    //    (超过上限 → DFU 返回 INSUFFICIENT_RESOURCES(4) → 表现为写第一包后断连)
    if (fwBytes.length > DFU.MAX_APP_SIZE_NRF52811_S112) {
      throw new Error(`固件大小 ${(fwBytes.length / 1024).toFixed(1)} KB 超过 OTA 上限 ` +
        `${(DFU.MAX_APP_SIZE_NRF52811_S112 / 1024).toFixed(1)} KB (${DFU.MAX_APP_SIZE_NRF52811_S112} B)。` +
        '请精简固件（如移除 RTT 日志）使其 ≤ 56.0 KB 后再升级。');
    }

    // 1) 读取当前状态 (对象上限 / 偏移)
    let sel;
    try {
      sel = await this.ctrlOp(DFU.OP_SELECT, [DFU.OBJ_DATA]);
    } catch (e) {
      if (e.message && e.message.indexOf('FAILED') >= 0) {
        addLog('DFU 状态异常, 尝试复位设备后重试');
      }
      throw e;
    }
    const maxObject = sel.maxSize;
    addLog(`DFU 数据对象上限: ${maxObject} 字节, 当前偏移: ${sel.offset}`);
    if (sel.offset > 0) {
      addLog(`检测到未完成的传输 (offset=${sel.offset}), 从该偏移继续...`);
    }

    // 1) PRN 流控
    await this.ctrlOp(DFU.OP_RECEIPT_NOTIF_SET, [DFU.PRN & 0xFF, (DFU.PRN >> 8) & 0xFF]);

    // 2) init (command) 对象: 若固件已有有效 init (SELECT command offset>0) 则跳过
    let cmdOffset = 0;
    try {
      const cmdSel = await this.ctrlOp(DFU.OP_SELECT, [DFU.OBJ_COMMAND]);
      cmdOffset = cmdSel.offset || 0;
    } catch (e) { /* 忽略 */ }
    if (cmdOffset > 0) {
      addLog(`固件已有 init 包 (offset=${cmdOffset}), 跳过 init 发送`);
    } else {
      addLog('发送 init 包...');
      await this.ctrlOp(DFU.OP_CREATE, [DFU.OBJ_COMMAND, initBytes.length & 0xFF, (initBytes.length >> 8) & 0xFF, (initBytes.length >> 16) & 0xFF, (initBytes.length >> 24) & 0xFF]);
      await this.writeData(initBytes, 0);
      await this.ctrlOp(DFU.OP_CRC_GET);
      await this.ctrlOp(DFU.OP_EXECUTE);
      // init 对象执行后会触发固件校验 init 包 + 准备固件区 (擦除所有固件页), 给足提交时间
      // (擦除固件区耗时与固件大小成正比, 使用动态估算), 再叠加固定裕量确保排空 flash 队列
      await new Promise(r => setTimeout(r, this._commitWaitMs(fwBytes.length) + DFU.OBJ_COMMIT_MARGIN_MS));
      addLog('init 包已执行, 开始发送固件...');
    }

    // 3) firmware (data) 对象: 每个对象是一个可重试单元, 失败时降速重传;
    //    断连时自动重连, 重连后 SELECT 确认固件端真实偏移, 从对象边界续传。
    let offset = sel.offset || 0;   // 起始偏移 = 固件端已确认的全局偏移
    // 若固件偏移已到文件末尾则直接完成 (例如上次已完成但 EXECUTE 回执丢失)
    if (offset >= fwBytes.length) {
      addLog(`固件偏移 ${offset} 已 >= 固件长度, 无需传输`);
      setOtaProgress(100);
      this.disconnect();
      return;
    }
    // 对齐到对象边界: 固件 CREATE 会把偏移重置到最后一个已 EXECUTE 对象末尾
    const objBase = Math.floor(offset / maxObject) * maxObject;
    if (objBase !== offset) {
      addLog(`固件偏移 ${offset} 不在对象边界, 对齐到 ${objBase}`);
      offset = objBase;
    }

    while (offset < fwBytes.length) {
      const size = Math.min(maxObject, fwBytes.length - offset);
      const objIdx = Math.floor(offset / maxObject);
      setOtaStatus(`固件块 ${objIdx}: ${offset}/${fwBytes.length} (${Math.round(offset / fwBytes.length * 100)}%)`);
      try {
        await this.transferObject(fwBytes.subarray(offset, offset + size), offset, maxObject);
      } catch (e) {
        if (isDfuDisconnectError(e)) {
          // 断连: 自动重连, 重连后查询固件端真实偏移
          this.reconnectCount++;
          if (this.reconnectCount > DFU.MAX_RECONNECTS) {
            throw new Error(`断连重连续传失败 (已重连 ${this.reconnectCount - 1} 次), 请手动重新连接后重试: ${e.message}`);
          }
          addLog(`⚠ 传输中断连, 尝试自动重连续传 (第 ${this.reconnectCount}/${DFU.MAX_RECONNECTS} 次)...`);
          await this.ensureConnected();
          // 重连后确认固件端真实进度
          let st = null;
          try { st = await this.selectOffset(DFU.OBJ_DATA); } catch (e2) { /* SELECT 失败则从头传当前对象 */ }
          if (st) {
            // 固件偏移可能已越过本对象 (EXECUTE 回执丢失但已执行) → 跳过一个对象
            if (st.offset >= offset + size) {
              addLog(`重连后固件偏移 ${st.offset} 已越过当前块, 跳到下一块`);
              offset += size;
              setOtaProgress(Math.round(offset / fwBytes.length * 100));
              continue;
            }
            // 固件偏移回退到对象边界: 更新 offset, 重新对齐 (若固件在对象中途断连,
            // 其 offset 指向对象内位置, 但 CREATE 会重置回对象起点 → 从对象起点重传)
            const newBase = Math.floor((st.offset || 0) / maxObject) * maxObject;
            if (newBase > offset) offset = newBase;
            else if (newBase < offset) {
              addLog(`固件偏移回退 ${st.offset}→对象起点 ${newBase}, 重传该对象`);
              offset = newBase;
            }
          }
          // 重连后继续循环, transferObject 内部会重新 CREATE 并从对象起点重传
          continue;
        }
        throw e;
      }
      offset += size;
      setOtaProgress(Math.round(offset / fwBytes.length * 100));
    }
    setOtaProgress(100);
    addLog('固件传输完成! 设备将自动校验并重启...');
    // 升级完成: 移除断连监听, 防止后续重连时重复注册 (设备即将重启)
    this.disconnect();
  }
}

/* ================= 升级流程 ================= */
let otaBusy = false;
// 通过「连接 DFU 设备」按钮选中的 DFU 设备引用 (requestDevice 必须在用户手势内执行,
// 因此不能在 otaRun 的异步流程中再 requestDevice, 需先在独立点击中选中并缓存)
let otaDfuDevice = null;
let otaDfuClient = null;
// TLSR 应用内 OTA: 通过「选择 TLSR 设备」按钮缓存的设备/客户端引用
// (requestDevice 必须在用户手势内执行, 因此独立按钮点击中选中并缓存;
//  TLSR 一旦被主界面连接就不再广播, 届时再 requestDevice 会弹出空列表)
let otaTlkDevice = null;
let otaTlkClient = null;

function setOtaStatus(text) {
  const el = document.getElementById('otaStatus');
  if (el) el.textContent = text;
}
function setOtaProgress(pct) {
  const el = document.getElementById('otaProgress');
  if (el) el.value = pct;
  const wrap = document.getElementById('otaProgressWrap');
  if (wrap) wrap.style.display = 'flex';
}

// 判断是否为 TLSR 移植版设备 (根据设备名; TLSR_EPD_XXXX / 旧 EPD_8258)
function otaIsTlsr() {
  const name = (typeof bleDevice !== 'undefined' && bleDevice && bleDevice.name) || '';
  return /^TLSR/i.test(name) || /^EPD_825/i.test(name);
}

async function otaTriggerButtonless() {
  if (!gattServer || !gattServer.connected) {
    addLog('当前未连接设备（若设备已处于 DFU 模式, 可直接点“开始升级”）');
    return false;
  }
  if (otaIsTlsr()) {
    addLog('❌ TLSR 设备不支持 Nordic DFU；请在“选择固件”中选择 .bin 文件使用 Telink OTA。');
    return 'unsupported';
  }
  let svc;
  try {
    svc = await gattServer.getPrimaryService(DFU.SERVICE);
  } catch (e) {
    console.error(e);
    addLog('❌ 当前设备不支持网页 OTA：未检测到 Nordic DFU/Buttonless 服务 (0xFE59)。TLSR 等非 Nordic 移植版暂不支持。');
    return 'unsupported';
  }
  try {
    const chars = await svc.getCharacteristics();
    const buttonless = chars.find((c) => {
      const u = c.uuid.toLowerCase();
      return u === DFU.BUTTONLESS || u === DFU.BUTTONLESS_BOND;
    });
    if (!buttonless) {
      addLog('设备上未找到 Buttonless DFU 特征（可能固件不支持 OTA 或已处于 DFU 模式）');
      return false;
    }
    addLog('触发设备进入 DFU 模式, 设备将重启...');
    // SDK17 的 buttonless 控制点是延迟写(授权写), 固件会先检查该特征 CCCD 指示是否开启,
    // 未开启则返回 CCCD_CONFIG_ERROR(表现为 "GATT Error Unknown")。
    // 因此写入前必须先 startNotifications() 开启 CCCD 指示 (Web Bluetooth 自动识别 notify/indicate)。
    try { await buttonless.startNotifications(); } catch (e) { /* 非致命, 继续尝试 */ }
    await buttonless.writeValueWithResponse(Uint8Array.of(0x01));
    return true;
  } catch (e) {
    console.error(e);
    addLog('触发进入 DFU 失败: ' + e.message);
    return false;
  }
}

async function otaRequestDfuDevice() {
  return await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: DFU.NAME }],
    optionalServices: [DFU.SERVICE],
  });
}

// OTA 前两次确认: ① 大体提示当前在做什么 ② 确认恢复办法并承担后果。任一取消即停止
function otaPreflightConfirm() {
  const isTelink = otaPackage.type === 'telink';

  // ① 第一次: 整体提示
  const summary = isTelink
    ? `即将进行 Telink 应用内 OTA 升级\n\n` +
      `设备类型: TLSR_EPD 系列 (TLSR8258)\n` +
      `固件: ${otaPackage.fwName}\n` +
      `大小: ${(otaPackage.fwBytes.length / 1024).toFixed(1)} KB\n` +
      `流程: 上传到 OTA 区 (0x20000) → 校验 → 覆盖主区 → 重启\n\n` +
      `升级期间请勿关闭页面、断开连接或断电。`
    : `即将进行 nRF52 固件升级 (Secure DFU OTA)\n\n` +
      `设备类型: nRF52/52811\n` +
      `固件: ${otaPackage.fwName}\n` +
      `大小: ${(otaPackage.fwBytes.length / 1024).toFixed(1)} KB\n` +
      `流程: 触发进入 DFU 模式 → 推送固件 → 重启\n\n` +
      `升级期间请勿关闭页面、断开连接或断电。`;

  if (!confirm(`⚠️ 固件升级 (OTA)\n\n${summary}\n\n点击「确定」继续 / 「取消」停止`)) {
    addLog('已取消 OTA：未通过升级前确认。');
    return false;
  }

  // ② 第二次: 恢复办法 + 承担后果
  const risk = isTelink
    ? `升级风险确认\n\nTLSR 应用内 OTA 没有独立引导程序 (bootloader)：\n` +
      `· 上传/校验阶段中断：主区仍是旧固件，可重新升级；\n` +
      `· 覆盖主区过程中断电：设备可能无法启动，需用烧录器 (J-Link/tc32) 恢复。\n\n` +
      `我已了解以上风险，并同意自行承担升级后果。`
    : `升级风险确认\n\nnRF52 依赖 DFU 模式 (DfuTarg)，升级中断通常可重新进入 DFU 模式重试恢复：\n` +
      `· 若多次中断/断电，极端情况下可能需用 J-Link 重新烧录恢复。\n\n` +
      `我已了解以上风险，并同意自行承担升级后果。`;

  if (!confirm(`⚠️ ${risk}\n\n点击「确定」= 同意并继续升级 / 「取消」= 停止`)) {
    addLog('已取消 OTA：未接受升级风险。');
    return false;
  }
  return true;
}

async function otaRun() {
  if (!otaPackage) { addLog('请先选择 OTA 包'); return; }
  if (otaBusy) return;

  // 两次确认: 任一取消即停止, 不进入升级流程
  if (!otaPreflightConfirm()) return;

  otaBusy = true;
  setOtaStatus('准备升级...');
  setOtaProgress(0);
  const startBtn = document.getElementById('otaStartBtn');
  if (startBtn) startBtn.disabled = true;
  let client = null;
  try {
    // Telink 固件 (.bin) → 走 TLSR 应用内 OTA
    if (otaPackage.type === 'telink') {
      await otaRunTelink();
      return;
    }

    // 1) 若已连接应用, 触发进入 bootloader; 若设备不支持则直接中止。
    //    (若设备已处于 DFU 模式则跳过触发, otaTriggerButtonless 会返回 false)
    const trig = await otaTriggerButtonless();
    if (trig === 'unsupported') {
      setOtaStatus('该设备不支持网页 OTA');
      throw new Error('设备不支持网页 OTA (TLSR/非 Nordic DFU)');
    }

    // 2) 复用通过「连接 DFU 设备」按钮缓存的 DFU 设备。
    //    requestDevice 必须在用户手势内调用, 不能在异步流程中发起,
    //    因此需先点「连接 DFU 设备」选择 DfuTarg 设备。
    if (otaDfuDevice && otaDfuClient && otaDfuClient.gatt && otaDfuClient.gatt.connected) {
      client = otaDfuClient;
      addLog('复用已连接的 DFU 设备');
    } else {
      addLog('请先点「连接 DFU 设备」选择 DFU 模式下的设备 (DfuTarg)');
      setOtaStatus('请先连接 DFU 设备');
      throw new Error('未连接 DFU 设备：请先点「连接 DFU 设备」选择 DfuTarg');
    }

    // 3) 推送固件
    if (!client.ctrlPt || !client.pkt) {
      addLog('重新初始化 DFU 特征...');
      await client.connect();
    }
    await client.flash(otaPackage.fwBytes, otaPackage.initBytes);
    addLog('✅ 固件升级完成！设备正在重启...');
    setOtaStatus('升级完成, 设备重启中...');
    // 升级完成: 清空缓存的 DFU 设备引用, 设备即将重启, 避免下次复用旧连接
    otaDfuClient = null;
    otaDfuDevice = null;
    setTimeout(() => {
      addLog('如设备未自动重启, 请手动复位; 也可点“重连”重新连接新固件。');
      setOtaStatus('');
    }, 6000);
  } catch (e) {
    console.error(e);
    addLog('❌ 升级失败: ' + e.message);
    setOtaStatus('升级失败: ' + e.message);
    // 断连导致的失败: 提示可重新连接后续传
    if (isDfuDisconnectError(e)) {
      addLog('提示: 若设备仍处于 DFU 模式 (DfuTarg), 可再次点「开始升级」从断点续传 (固件已保存进度)。');
    }
  } finally {
    otaBusy = false;
    if (startBtn) startBtn.disabled = false;
  }
}

// Telink OTA 流程: 优先复用「选择 TLSR 设备」缓存连接, 其次复用主界面连接
async function otaRunTelink() {
  addLog('Telink OTA: 准备 TLSR 设备...');
  setOtaStatus('正在连接 TLSR OTA 设备...');
  let client = null;

  // 1) 优先复用通过「选择 TLSR 设备」按钮缓存的连接 (已在独立手势中 requestDevice)
  if (otaTlkClient && otaTlkClient.gatt && otaTlkClient.gatt.connected) {
    client = otaTlkClient;
    addLog('复用已连接的 TLSR OTA 设备: ' + (otaTlkDevice && otaTlkDevice.name ? otaTlkDevice.name : '(无名称)'));
  }
  // 2) 其次复用主界面连接 (需 optionalServices 含 TLK_OTA.SERVICE)
  else if (typeof gattServer !== 'undefined' && gattServer && gattServer.connected) {
    try {
      await gattServer.getPrimaryService(TLK_OTA.SERVICE);
      client = new TelinkOtaClient(bleDevice, gattServer);
      await client.connect();
      addLog('复用主界面已连接的 TLSR 设备: ' + ((bleDevice && bleDevice.name) || '(无名称)'));
    } catch (e) {
      console.error(e);
      addLog('⚠ 当前连接的 OTA 服务 (0x221f) 不可用: ' + e.message);
      addLog('→ 请先断开并重连 TLSR 设备, 或点「选择 TLSR 设备」按钮重新连接后再试。');
      setOtaStatus('请先选择 TLSR 设备');
      throw new Error('未找到 OTA 服务 (0x221f): 请点「选择 TLSR 设备」重新连接');
    }
  } else {
    setOtaStatus('请先选择 TLSR 设备');
    throw new Error('未连接 TLSR 设备: 请点「选择 TLSR 设备」按钮连接 TLSR_EPD 设备');
  }

  const rebooted = await client.flash(otaPackage.fwBytes);
  if (rebooted) {
    addLog('✅ Telink OTA 完成！设备已重启进入新固件');
    setOtaStatus('升级完成');
  } else {
    addLog('ℹ 设备未确认重启, 请重新连接后查看版本; 必要时再点「开始升级」');
    setOtaStatus('请验证设备版本');
  }
  // 升级后设备重启, 连接失效, 清空缓存
  otaTlkClient = null;
  otaTlkDevice = null;
  setTimeout(() => {
    addLog('如设备未自动重启, 请手动复位; 稍后可重新连接新固件。');
    setOtaStatus('');
  }, 6000);
}

// 「选择 TLSR 设备」按钮: 在独立用户手势内 requestDevice + 连接, 缓存复用
async function otaProbeTlk() {
  if (otaBusy) return;
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'TLSR' }],
      optionalServices: [TLK_OTA.SERVICE],
    });
    otaTlkDevice = device;
    const client = new TelinkOtaClient(device, null);
    await client.connect();
    otaTlkClient = client;
    addLog('✅ 已连接 TLSR OTA 设备: ' + (device.name || '(无名称)'));
    setOtaStatus('TLSR 设备已连接, 可选 .bin 后点「开始升级」');
  } catch (e) {
    console.error(e);
    otaTlkDevice = null;
    otaTlkClient = null;
    addLog('连接 TLSR 设备失败: ' + e.message);
  }
}

async function otaProbeDfu() {
  if (otaBusy) return;
  try {
    // requestDevice 必须发生在用户手势内 (此处为「连接 DFU 设备」按钮的独立点击), 允许同步调用
    const device = await otaRequestDfuDevice();
    otaDfuDevice = device;
    const client = new DfuClient(device);
    await client.connect();
    otaDfuClient = client;
    const sel = await client.ctrlOp(DFU.OP_SELECT, [DFU.OBJ_DATA]);
    addLog(`DFU 设备就绪: 数据对象上限 ${sel.maxSize}B, 当前偏移 ${sel.offset}B`);
    addLog('✅ 已选中 DFU 设备, 可直接点「开始升级」推送固件');
    setOtaStatus('DFU 设备已就绪, 可开始升级');
  } catch (e) {
    console.error(e);
    otaDfuDevice = null;
    otaDfuClient = null;
    addLog('连接 DFU 设备失败: ' + e.message);
  }
}

function initOTA() {
  const el = document.getElementById('otaFile');
  if (el) el.addEventListener('change', () => otaSelectFile(el));
}
