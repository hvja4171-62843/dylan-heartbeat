// 批注 2026-08-10：特殊事件必须从“带时间戳的事件消息开头”识别；
// 普通回答即使讨论了推送、Bark 或自动唤醒，也不能被截成真实事件反复注入。
const SPECIAL_EVENT_PREFIX = /^\s*[（(]\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}(?::\d{2})?\s+(?:自动唤醒：本次未发送(?:\s*(?:Bark|推送))?|刚刚发送了推送|刚刚给(?:宝宝|用户)发了\s*(?:Bark|ntfy)?\s*推送|刚刚给(?:宝宝|用户)发了\s*Bark)(?:[：:｜|）)]|\s|$)/i;
const SUCCESSFUL_PUSH_EVENT_PREFIX = /^\s*[（(]\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]?)\d{1,2}[:：]\d{2}(?::\d{2})?\s+(?:刚刚发送了推送|刚刚给(?:宝宝|用户)发了\s*(?:Bark|ntfy)?\s*推送|刚刚给(?:宝宝|用户)发了\s*Bark)(?:[：:｜|）)]|\s|$)/i;

function isSpecialEventContent(content) {
  return SPECIAL_EVENT_PREFIX.test(String(content || ""));
}

function isSuccessfulPushEventContent(content) {
  return SUCCESSFUL_PUSH_EVENT_PREFIX.test(String(content || ""));
}

module.exports = {
  isSpecialEventContent,
  isSuccessfulPushEventContent,
  SPECIAL_EVENT_PREFIX,
  SUCCESSFUL_PUSH_EVENT_PREFIX
};
