"use strict";
/**
 * 录制链路公共模块：FFmpeg 路径解析、共享常量。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HLS_SEGMENT_DURATION = void 0;
exports.getFfmpegPath = getFfmpegPath;
exports.registerSessionAnchor = registerSessionAnchor;
exports.getOutputTsOffset = getOutputTsOffset;
exports.resetSessionAnchors = resetSessionAnchors;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
/** 每个 HLS 切片的目标时长（秒）——与后端 hlsService.ts 保持一致 */
exports.HLS_SEGMENT_DURATION = 10;
/**
 * 解析 FFmpeg 可执行文件路径。
 * Windows：优先用项目自带的 ffmpeg.exe（确保 ddagrab/gfxcapture 支持）。
 */
function getFfmpegPath() {
    var _a;
    if (process.platform === 'win32') {
        const binName = 'ffmpeg.exe';
        if (electron_1.app.isPackaged) {
            const bundledPath = path_1.default.join((_a = process.resourcesPath) !== null && _a !== void 0 ? _a : '', 'bin', binName);
            if (fs_1.default.existsSync(bundledPath))
                return bundledPath;
        }
        else {
            // 开发/预览模式：优先使用源码目录 electron/bin/ 下的 ffmpeg.exe
            // 该目录与 electron-builder.yml 的 extraResources.from 保持一致，
            // 避免 preview 模式因未走 electron-builder 而找不到正确版本。
            const sourceBinPath = path_1.default.join(electron_1.app.getAppPath(), 'electron', 'bin', binName);
            if (fs_1.default.existsSync(sourceBinPath))
                return sourceBinPath;
            // 兼容旧路径：项目根目录 bin/ffmpeg.exe
            const legacyBinPath = path_1.default.join(__dirname, '..', '..', 'bin', binName);
            if (fs_1.default.existsSync(legacyBinPath))
                return legacyBinPath;
        }
    }
    // 其他平台 / 降级：用 ffmpeg-static
    let raw = ffmpeg_static_1.default;
    if (electron_1.app.isPackaged) {
        return raw.replace('app.asar', 'app.asar.unpacked');
    }
    return raw;
}
let sessionAnchors = [];
/**
 * 登记一次 ffmpeg 会话的时间轴锚点。同 firstSeg 重复登记会覆盖（crash 回退重拉时复用）。
 */
function registerSessionAnchor(firstSeg, startOffset) {
    const existing = sessionAnchors.find((a) => a.firstSeg === firstSeg);
    if (existing) {
        existing.startOffset = startOffset;
        return;
    }
    sessionAnchors.push({ firstSeg, startOffset });
    sessionAnchors.sort((a, b) => a.firstSeg - b.firstSeg);
}
/**
 * 计算某分片的真实输出时间轴偏移（秒）。
 * 选取 firstSeg <= segIndex 中序号最大的锚点，按 +10s/片向后推算。
 * 无任何锚点时（理论不会触发）回退旧公式，保证不回归。
 */
function getOutputTsOffset(segIndex) {
    let chosen = null;
    for (const a of sessionAnchors) {
        if (a.firstSeg <= segIndex)
            chosen = a;
        else
            break;
    }
    if (!chosen)
        return segIndex * exports.HLS_SEGMENT_DURATION;
    return chosen.startOffset + (segIndex - chosen.firstSeg) * exports.HLS_SEGMENT_DURATION;
}
/** 重置锚点表（新一次录制开始时调用，避免上次会话残留）。 */
function resetSessionAnchors() {
    sessionAnchors = [];
}
