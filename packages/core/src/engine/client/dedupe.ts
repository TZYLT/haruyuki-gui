/**
 * 出站去重表：同一次调用不被发两遍。
 *
 * 判据 `V-9`（docs/26 §5.1）：灌入超过上限的不同 `request_id`，表大小不超过
 * 4096，且淘汰顺序为 LRU。
 *
 * ## 这张表防什么、不防什么
 *
 * **防**：调用方 bug（同一个 `request_id` 在一拍内被提交两次），以及将来 B3 做
 * 显式重试时「同一次调用」的识别。
 *
 * **不防**：网络重发。TCP 不重复投递，引擎侧也不按 `request_id` 去重
 * （`message-router.ts` 只回带，无 seen 集合），所以这里**不是**一个幂等层。
 *
 * **不复刻**引擎的 `client_message_id` 半去重：那层只覆盖 `input`、
 * 只在排队路径生效、上限也是 4096。复刻它等于把引擎的实现细节变成我们的契约。
 *
 * ## 为什么是 LRU 而不是 FIFO
 *
 * 一次重试的时机通常紧跟在原调用之后。FIFO 在持续流量下会把「最近刚发过的」
 * 先挤掉，恰好淘汰掉最可能被重试的那一条；LRU 把「最近用过」留在表里。
 *
 * ## 为什么这张表不接收无 `request_id` 的命令
 *
 * 5 条命令在 wire 上没有 `request_id`。它们**不该进任何
 * 去重表**，因为「连按两次 `a`」是两个 `a`——去重会吃掉一个真实按键。调用方
 * 在这种情况下传 `undefined`，本表如实拒绝跟踪。
 */

/** 表的上限；照引擎 `acceptedInputDispositions` 的量级。 */
export const DEDUPE_LIMIT = 4096;

/**
 * 一次去重的判定结果。
 *
 * 三态而不是布尔：调用方需要区分「第一次见」「重复」「无法跟踪」，因为三种的
 * 后续动作完全不同——照常发、拦下并回报、还是根本不检查。
 */
export type DedupeVerdict =
  { readonly kind: "first" } | { readonly kind: "duplicate" } | { readonly kind: "untracked" };

/**
 * 有界的 `request_id` 记忆表，LRU 淘汰。
 *
 * 只记「这个 id 我已经发过」，不记内容——`request_id` 是唯一交换物，
 * 所以表里存 id 就够了。存内容会让一个 4096 项的表变成潜在的内存放大器。
 */
export class OutboundDedupe {
  /**
   * `Map` 的迭代顺序就是插入顺序，删了再插会排到末尾，所以它天然是 LRU：
   * 命中时先 `delete` 再 `set`，最旧的永远在首位。
   */
  readonly #seen = new Map<string, true>();

  constructor(private readonly limit: number = DEDUPE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError(`dedupe limit must be a positive integer, got ${String(limit)}`);
    }
  }

  /** 当前记住多少个 id。 */
  get size(): number {
    return this.#seen.size;
  }

  /** 上限；测试与诊断要读。 */
  get capacity(): number {
    return this.limit;
  }

  /**
   * 登记一次即将发出的调用。
   *
   * @param requestId 线上要用的请求编号；`undefined` 表示这条命令没有编号
   * @returns `first` 表示可以发，`duplicate` 表示这次是重复，`untracked` 表示无编号
   */
  claim(requestId: string | undefined): DedupeVerdict {
    if (requestId === undefined) {
      // 无编号的命令不进表：它们如实执行，连按两次就是两次。
      return { kind: "untracked" };
    }

    if (this.#seen.has(requestId)) {
      // 命中即刷新：把它挪到队尾，这样持续的重复不会让它被自己挤掉。
      this.#seen.delete(requestId);
      this.#seen.set(requestId, true);
      return { kind: "duplicate" };
    }

    this.#seen.set(requestId, true);

    // 只在超限时淘汰一个，所以表在稳态下不会长于 `limit`。
    while (this.#seen.size > this.limit) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#seen.delete(oldest.value);
    }

    return { kind: "first" };
  }

  /** 某 id 是否在表里（不刷新 LRU——这是只读查询，不是一次使用）。 */
  has(requestId: string): boolean {
    return this.#seen.has(requestId);
  }

  /** 清空；`closeAll` 与测试用。 */
  clear(): void {
    this.#seen.clear();
  }
}
