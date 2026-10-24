// P1.3 · 持久化任务队列（架构 §3.4 / 数据模型 §1.6 jobs 表）。
// 状态机：pending → running → done | need_confirm | failed（失败 retries≤1 自动重排队）。
// 并发=1（B 站侧串行）；SW 重启恢复：recover() 把 stale running 重排 pending。
// 任务语义（选轨/字幕/LLM）由注入的 executor 承担——任务 1.4 提供 SUMMARIZE 实现。
import type { CompanionDB, JobRow, JobStage, JobType } from '../storage';

export interface JobError {
  code: string;
  msg: string; // 脱敏后
}

export type JobOutcome =
  | { result: 'done' }
  | { result: 'need_confirm' } // 如 SUMMARIZE 无字幕轨 → 等 ASR 用户确认（F6）
  | { result: 'failed'; error: JobError }
  /** P2.6 F11 断网挂起：网络级失败 → 回 pending 不烧重试（不报错轰炸），恢复后续跑。 */
  | { result: 'wait'; error: JobError };

export interface JobContext {
  /** 执行中更新 stage/progress（进度动画数据源，落库持久化）。 */
  update: (patch: { stage?: JobStage; progress?: number }) => Promise<void>;
}

export interface PipelineHandlers {
  execute: (job: JobRow, ctx: JobContext) => Promise<JobOutcome>;
}

export interface PipelineOptions {
  /** 自动重试上限（数据模型 §1.6：≤1）。 */
  maxRetries?: number;
  now?: () => number;
  /** 状态迁移回调（日志/Port 广播用；异常忽略）。 */
  onTransition?: (job: JobRow) => void;
}

const ACTIVE_STATUSES: JobRow['status'][] = ['pending', 'running', 'need_confirm'];
const rand4 = () => Math.random().toString(36).slice(2, 6);

export class Pipeline {
  readonly #db: CompanionDB;
  readonly #handlers: PipelineHandlers;
  readonly #maxRetries: number;
  readonly #now: () => number;
  readonly #onTransition?: (job: JobRow) => void;
  #busy = false;

  constructor(db: CompanionDB, handlers: PipelineHandlers, opts: PipelineOptions = {}) {
    this.#db = db;
    this.#handlers = handlers;
    this.#maxRetries = opts.maxRetries ?? 1;
    this.#now = opts.now ?? Date.now;
    this.#onTransition = opts.onTransition;
  }

  /**
   * 入队。幂等：同 videoKey+type(+segIndex) 已有活动任务（pending/running/need_confirm）时返回现有行，
   * 不重复建（20s 触发与按需打开并发、双标签页并发触发均在此收口；F13 同视频不同段互不去重）。
   * 'rw' 事务封查后写竞态。
   */
  async enqueue(input: { type: JobType; videoKey: string; sessionId: string; segIndex?: number }): Promise<JobRow> {
    return this.#db.transaction('rw', this.#db.jobs, async () => {
      const active = await this.#db.jobs
        .where('videoKey')
        .equals(input.videoKey)
        .filter(
          (j) =>
            j.type === input.type &&
            (j.segIndex ?? null) === (input.segIndex ?? null) &&
            ACTIVE_STATUSES.includes(j.status),
        )
        .first();
      if (active) return active;
      const now = this.#now();
      const row: JobRow = {
        id: `j_${now}_${rand4()}`,
        type: input.type,
        videoKey: input.videoKey,
        sessionId: input.sessionId,
        ...(input.segIndex !== undefined ? { segIndex: input.segIndex } : {}),
        status: 'pending',
        progress: 0,
        retries: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.#db.jobs.put(row);
      this.#emit(row);
      return row;
    });
  }

  /** SW 启动时调用：stale running（上次 SW 中途死亡）重排 pending。返回重排数。 */
  async recover(): Promise<number> {
    const stale = await this.#db.jobs.where('status').equals('running').toArray();
    for (const j of stale) {
      const row: JobRow = { ...j, status: 'pending', updatedAt: this.#now() };
      await this.#db.jobs.put(row);
      this.#emit(row);
    }
    return stale.length;
  }

  /**
   * 取最早的 pending 执行到底；无任务返回 false，网络挂起返回 'wait'（drain 据此停轮——
   * 否则 wait 回 pending 会被立即重取，热循环空转）。
   */
  async tick(): Promise<boolean | 'wait'> {
    const job = (await this.#db.jobs.where('status').equals('pending').sortBy('createdAt'))[0];
    if (!job) return false;
    await this.#set({ ...job, status: 'running', updatedAt: this.#now() });
    const ctx: JobContext = {
      update: async (patch) => {
        const cur = await this.#db.jobs.get(job.id);
        // 执行期间被清除（F10 wipe）不写回；终态后迟到的进度消息（如 done 落库后的 90 回包）不覆盖
        if (!cur || cur.status !== 'running') return;
        await this.#set({ ...cur, ...patch, updatedAt: this.#now() });
      },
    };
    let outcome: JobOutcome;
    try {
      outcome = await this.#handlers.execute({ ...job, status: 'running' }, ctx);
    } catch (e) {
      outcome = {
        result: 'failed',
        error: { code: 'EXEC_ERROR', msg: String(e).slice(0, 200) },
      };
    }
    const fresh = await this.#db.jobs.get(job.id);
    if (!fresh) return true; // 同上：不复活已清除的任务
    if (outcome.result === 'done') {
      await this.#set({ ...fresh, status: 'done', progress: 100, updatedAt: this.#now() });
    } else if (outcome.result === 'need_confirm') {
      await this.#set({ ...fresh, status: 'need_confirm', updatedAt: this.#now() });
    } else if (outcome.result === 'wait') {
      // P2.6 F11：网络级失败挂起——回 pending 不烧重试（徽章保持「生成中」，不 failed 轰炸）；
      // 续跑时机由调用方触发（SW online 事件/面板 LIST_QUERY/alarms 兜底）。
      // 静默写回（审查 P1-1）：running→pending 的 onTransition 广播 SUMMARY_UPDATED 会被
      // 开着的面板（刷新→LIST_QUERY→drainUnlessPaused）放大成 ~10次/s 的全链重试热循环
      await this.#set({ ...fresh, status: 'pending', updatedAt: this.#now() }, true);
      return 'wait';
    } else if (fresh.retries < this.#maxRetries && fresh.type !== 'ASR_SUMMARIZE') {
      // P2.3 审查 P2-4：ASR 链失败不自动重排——重跑=重新下载+重新转写（真实计费）；
      // 用户显式再点【调用 ASR 解析】才会重试（F11 重试由用户发起的同口径）
      await this.#set({ ...fresh, status: 'pending', retries: fresh.retries + 1, updatedAt: this.#now() });
    } else {
      // error 随终态落 job 行：摘要失败的权威源仍是 summaries.error（任务 1.4），
      // 但分段解读 NO_OUTLINE/NO_VIDEO 早退等执行体不写注记的路径，终态广播靠此兜底不丢错误码
      await this.#set({ ...fresh, status: 'failed', error: outcome.error, updatedAt: this.#now() });
    }
    return true;
  }

  /** 串行清空 pending（并发=1；重入时等当前轮结束再补一轮；网络挂起即停轮）。 */
  async drain(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (;;) {
        const r = await this.tick();
        if (!r || r === 'wait') break; // wait=网络挂起，等恢复后续跑
      }
    } finally {
      this.#busy = false;
    }
  }

  /** need_confirm → pending（ASR 确认流 F6 的恢复入口，任务 2.3 接线）。 */
  async resume(jobId: string): Promise<void> {
    const job = await this.#db.jobs.get(jobId);
    if (!job || job.status !== 'need_confirm') return;
    await this.#set({ ...job, status: 'pending', updatedAt: this.#now() });
  }

  /** 手动重试失败任务（F11 列表红色徽章可点重试）：retries 归零重新排队。 */
  async retry(jobId: string): Promise<void> {
    const job = await this.#db.jobs.get(jobId);
    if (!job || job.status !== 'failed') return;
    await this.#set({ ...job, status: 'pending', retries: 0, updatedAt: this.#now() });
  }

  async #set(row: JobRow, silent = false): Promise<void> {
    // 审查 P2-3：error 只在 failed 终态随行——done/need_confirm/重排 pending 一律清除，
    // 防重试成功的 done 行带着旧 error（语义陷阱；单点在 #set 收口覆盖所有迁移路径）
    if (row.status !== 'failed' && row.error !== undefined) {
      const { error: _stale, ...rest } = row;
      row = rest as JobRow;
    }
    await this.#db.jobs.put(row);
    if (!silent) this.#emit(row); // wait→pending 静默：徽章本就「生成中」，广播只喂热循环
  }

  #emit(row: JobRow): void {
    try {
      this.#onTransition?.(row);
    } catch {
      /* 广播失败不影响队列 */
    }
  }
}
