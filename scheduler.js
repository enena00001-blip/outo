const cron = require('node-cron');
const { db, getSetting } = require('./db');
const { publishPost, publishReply, getMediaInsights } = require('./threadsApi');

// 링크를 안내문구 템플릿에 끼워서 댓글용 텍스트 생성
function buildCommentText(link) {
  const template = getSetting('COUPANG_DISCLOSURE_TEMPLATE') || '{link}';
  return template.replace('{link}', link);
}

// 본문 발행 성공 직후 호출: 링크가 있고 자동댓글이 켜져 있으면 안내문구+링크를 댓글로 등록
async function postAffiliateComment(post, parentMediaId) {
  if (!post.link || !post.auto_comment_enabled) return;
  try {
    const commentText = buildCommentText(post.link);
    const commentMediaId = await publishReply(parentMediaId, commentText);
    db.prepare(
      `UPDATE posts SET comment_status = 'posted', comment_media_id = ?, comment_posted_at = ? WHERE id = ?`
    ).run(commentMediaId, new Date().toISOString(), post.id);
    console.log(`[댓글 등록 완료] post #${post.id} -> comment ${commentMediaId}`);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    db.prepare(`UPDATE posts SET comment_status = 'failed', comment_error_message = ? WHERE id = ?`).run(
      msg,
      post.id
    );
    console.error(`[댓글 등록 실패] post #${post.id}:`, msg);
  }
}

// 1분마다: 발행 시각이 지난 pending 글을 발행 (+ 링크 있으면 댓글에 안내문구 자동 등록)
function startPublishJob() {
  cron.schedule('* * * * *', async () => {
    const now = new Date().toISOString();
    const duePosts = db
      .prepare(
        `SELECT * FROM posts WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC`
      )
      .all(now);

    for (const post of duePosts) {
      try {
        const mediaId = await publishPost({
          text: post.text,
          imageUrl: post.image_url,
        });
        db.prepare(
          `UPDATE posts SET status = 'posted', threads_media_id = ?, posted_at = ? WHERE id = ?`
        ).run(mediaId, new Date().toISOString(), post.id);
        db.prepare(
          `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes) VALUES (?, 0, 0, 0, 0, 0)
           ON CONFLICT(post_id) DO NOTHING`
        ).run(post.id);
        console.log(`[발행 완료] post #${post.id} -> media ${mediaId}`);

        // 스레드는 원글 발행이 반영되는 데 약간 시간이 걸릴 수 있어 잠깐 대기 후 댓글 등록
        await new Promise((r) => setTimeout(r, 3000));
        await postAffiliateComment(post, mediaId);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(
          msg,
          post.id
        );
        console.error(`[발행 실패] post #${post.id}:`, msg);
      }
    }
  });
}

// 10분마다: 오늘 발행된 글들의 인사이트(조회수 등) 갱신
function startInsightsJob() {
  cron.schedule('*/10 * * * *', async () => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const postedToday = db
      .prepare(
        `SELECT * FROM posts WHERE status = 'posted' AND posted_at >= ? AND threads_media_id IS NOT NULL`
      )
      .all(startOfDay.toISOString());

    for (const post of postedToday) {
      try {
        const stats = await getMediaInsights(post.threads_media_id);
        db.prepare(
          `INSERT INTO insights (post_id, views, likes, replies, reposts, quotes, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(post_id) DO UPDATE SET
             views = excluded.views, likes = excluded.likes, replies = excluded.replies,
             reposts = excluded.reposts, quotes = excluded.quotes, updated_at = excluded.updated_at`
        ).run(
          post.id,
          stats.views || 0,
          stats.likes || 0,
          stats.replies || 0,
          stats.reposts || 0,
          stats.quotes || 0,
          new Date().toISOString()
        );
      } catch (err) {
        console.error(`[인사이트 갱신 실패] post #${post.id}:`, err.response?.data || err.message);
      }
    }
  });
}

module.exports = { startPublishJob, startInsightsJob };
