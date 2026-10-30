// P1.1 · IndexedDB 存储层（02-数据模型 §1）：v1.0 六表（五张业务表 + jobs 队列）。
// chats 表属 v1.1（Phase 4 · F14），届时以 Dexie version(2) 迁移新增，不在本轮引入。
import Dexie, { type Table } from 'dexie';

// ---- 行类型（对齐 02-数据模型 §1.1–§1.6） ----------------------------------

export type SessionState = 'ACTIVE' | 'GRACE' | 'EXPIRED_PENDING_CONFIRM' | 'CLOSED';

export interface SessionRow {
  id: string; // s_<timestamp>_<rand4>
  state: SessionState;
  startedAt: number;
  closedAt?: number;
  lastActiveAt: number;
  restoredAt?: number;
}

export interface VideoRow {
  key: string; // `${bvid}:${cid}`
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  cover: string;
  owner: string;
  duration: number; // 秒
  page: number; // 分 P 序号
  fetchedAt: number; // 元信息缓存 24h
}

export interface VisitRow {
  id?: number; // ++id
  sessionId: string;
  videoKey: string;
  firstSeenAt: number;
  lastSeenAt: number;
  watchedSeconds: number; // 有效观看累计（前台+播放中）
  watchedByTracker?: Record<string, number>; // 各监听实例已计入的秒数，刷新/多标签去重累计
  progressPct: number; // 0–100
  triggered: 0 | 1; // 20s 阈值是否已触发
}

export type TranscriptSource = 'manual_sub' | 'ai_sub' | 'asr';

/** 归一化字幕 cue（02-数据模型 §1.4：{from,to,text}；B 站原字段 content 在链路层归一）。 */
export interface StoredCue {
  from: number;
  to: number;
  text: string;
}

export interface TranscriptRow {
  key: string; // `${bvid}:${cid}`
  source: TranscriptSource;
  lan: string;
  cues: StoredCue[];
  charCount: number;
  cachedAt: number; // 缓存 24h
  asrComplete?: boolean; // 缺省为旧版完整转写，false 表示仅有已完成片段。
  asrParts?: { start: number; end: number; result: import('../asr/doubao').DoubaoResult; cues: StoredCue[]; whole?: boolean; serviceDurationMs?: number }[];
  asrDuration?: number; // 本次实际音轨处理范围，可能与视频整数时长略有差异。
  asrPending?: { start: number; end: number }; // 发送中或中断后计费状态不明的片段
}

export type SummaryStatus = 'streaming' | 'done' | 'failed' | 'need_asr';

export interface SummaryError {
  code: string;
  msg: string; // 脱敏后
}

export interface SegmentNote {
  text: string;
  status: 'streaming' | 'done' | 'failed';
  createdAt: number;
  error?: SummaryError; // 失败原因（脱敏后；F13 失败可见可重试）
  truncated?: boolean; // 超长段按字符上限截断解读（UI 标注）
}

export interface SummaryRow {
  key: string; // `${bvid}:${cid}:${modelId}`
  videoKey: string;
  source: TranscriptSource;
  summary: string;
  outline: { time: number; text: string }[];
  evaluation: string;
  rating: number;
  modelId: string;
  persona: string;
  segmentNotes?: { [segIndex: number]: SegmentNote }; // F13（任务 1.11）
  asrProgress?: { sessionId?: string; processedUntil: number; targetDuration: number; status: 'running' | 'partial' | 'done'; parts: { from: number; to: number; text: string }[]; unconfirmed?: { from: number; to: number; text: string }[]; warning?: string };
  status: SummaryStatus;
  error?: SummaryError;
  createdAt: number;
  /** 另一模型的摘要仍基于恢复前的旧语音转写。 */
  asrOutdated?: boolean;
}

export interface AsrRecovery {
  /** 期望的原始数据快照：仅在其未被修改时提交候选。 */
  original: TranscriptRow;
  candidate?: TranscriptRow;
  progress?: SummaryRow['asrProgress'];
  pending?: boolean;
  committed?: boolean;
}

export type JobType = 'SUMMARIZE' | 'ASR_SUMMARIZE' | 'REGENERATE' | 'SEGMENT_ANALYZE';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'need_confirm';
export type JobStage = 'subtitle' | 'audio' | 'asr' | 'llm_map' | 'llm_reduce';

export interface JobRow {
  id: string;
  type: JobType;
  videoKey: string;
  sessionId: string;
  segIndex?: number; // SEGMENT_ANALYZE 的段下标（幂等键一部分，F13）
  prio?: number; // -1=用户主动摘要；缺省/0=常规；1=分段预取。数字越小越优先。
  status: JobStatus;
  runId?: string; // 每次实际执行的租约；恢复或重试后，旧执行体不得再写任务状态。
  stage?: JobStage;
  progress: number; // 0–100
  retries: number; // ≤1 自动重试
  error?: { code: string; msg: string }; // 失败原因（failed 终态写入；摘要以 summaries.error 为权威，分段早退等执行体未写注记的路径由终态广播读此兜底）
  createdAt: number;
  updatedAt: number;
  recovery?: AsrRecovery;
}

// ---- Dexie schema ----------------------------------------------------------

export class CompanionDB extends Dexie {
  sessions!: Table<SessionRow, string>;
  videos!: Table<VideoRow, string>;
  visits!: Table<VisitRow, number>;
  transcripts!: Table<TranscriptRow, string>;
  summaries!: Table<SummaryRow, string>;
  jobs!: Table<JobRow, string>;

  constructor(name = 'doubao-companion', options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      sessions: 'id, state',
      videos: 'key, bvid, fetchedAt',
      visits: '++id, sessionId, videoKey, [sessionId+lastSeenAt]',
      transcripts: 'key, cachedAt',
      summaries: 'key, videoKey, status, createdAt',
      jobs: 'id, type, videoKey, status, updatedAt',
    });
  }
}

type DexieOptions = ConstructorParameters<typeof Dexie>[1];
