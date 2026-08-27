/**
 * 粘贴清洗。
 *
 * 从推特网页复制出来的不是一条干净的推文，而是一坨界面文本：
 *
 *   Cloudflare
 *   @Cloudflare
 *   ·
 *   2h
 *   We redesigned the Cloudflare Blog — dark mode…
 *   1.2K
 *   340
 *   89
 *   Show more
 *
 * 不清洗的话，这些行会被当成独立的「推文」进到筛选里，
 * 用户看到一屏莫名其妙的 ✗，会以为是工具坏了。
 */

/** 一行是不是界面噪音 */
function isNoise(line: string): boolean {
  const t = line.trim();
  if (!t) return false; // 空行是分隔符，不是噪音

  return (
    /^@[\w]{1,20}$/.test(t) ||                              // @handle 单独一行
    /^[·•‧・]$/.test(t) ||                                   // 分隔点
    /^\d+\s*[smhd]$/i.test(t) ||                            // 2h / 45m / 3d
    /^\d+\s*(秒|分钟|小时|天|个?月|年)前?$/.test(t) ||        // 中文相对时间
    /^[\d.,]+\s*[KMB万亿]?$/i.test(t) ||                     // 互动数：340 / 1.2K / 1.2万
    /^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i.test(t) ||       // 时间戳
    /^\d{4}年\d{1,2}月\d{1,2}日/.test(t) ||
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(,\s*\d{4})?$/i.test(t) ||
    /^(show (more|this thread)|translate post|view translation|quote|reply|repost|likes?|views?|bookmarks?|following|followers)$/i.test(t) ||
    /^(显示更多|查看此话题|翻译帖子|查看翻译|引用|回复|转推|转帖|喜欢|浏览|书签|正在关注|关注者)$/.test(t) ||
    /^[✓✔☑]$/.test(t)                                       // 认证标记
  );
}

/** @handle 行的前一行通常是显示名，一并去掉 */
function isDisplayNameBefore(lines: string[], i: number): boolean {
  const next = lines[i + 1]?.trim() ?? '';
  const self = lines[i]?.trim() ?? '';
  return /^@[\w]{1,20}$/.test(next) && self.length > 0 && self.length <= 40 && !/[.!?。！？]$/.test(self);
}

export interface CleanResult {
  tweets: string[];
  /** 清掉了多少行噪音 —— 界面上说一句，用户才知道系统做了什么 */
  removed: number;
}

/**
 * 把一大段粘贴内容切成若干条推文。
 *
 * 分隔优先用空行（从推特一条条复制时最常见）。同一条内部的换行
 * 拼成一行 —— 推文里的软换行不是句子边界，拆开会让难度打分
 * 把半句话当成一条推。
 */
export function cleanPaste(raw: string): CleanResult {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isNoise(line) || isDisplayNameBefore(lines, i)) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  const tweets = kept
    .join('\n')
    .split(/\n\s*\n+/)
    .map((block) =>
      block.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    )
    .filter((t) => t.length > 0);

  return { tweets, removed };
}
