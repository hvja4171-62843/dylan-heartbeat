function isHourInWindow(hour, start, end) {
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeDeadline(lastUserTime, wakeAfterMinutes) {
  const last = lastUserTime instanceof Date ? lastUserTime : new Date(lastUserTime);
  const minutes = Number(wakeAfterMinutes);
  if (Number.isNaN(last.getTime()) || !Number.isFinite(minutes)) return null;
  return new Date(last.getTime() + minutes * 60 * 1000);
}

function isQuietWindowExceptionDue({
  lastUserTime,
  now,
  wakeAfterMinutes,
  getHour,
  start,
  end,
  activeWindowOnly = true
}) {
  if (!activeWindowOnly || typeof getHour !== "function") return false;

  const current = now instanceof Date ? now : new Date(now);
  const deadline = getWakeDeadline(lastUserTime, wakeAfterMinutes);
  if (!deadline || Number.isNaN(current.getTime())) return false;

  const currentIsActive = isHourInWindow(getHour(current), start, end);
  const deadlineIsActive = isHourInWindow(getHour(deadline), start, end);
  return !currentIsActive && !deadlineIsActive && current >= deadline;
}

function countPushesSince(messages, since, options) {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) return 0;

  const {
    getContentText,
    isSuccessfulPushEventContent,
    parseTimestamp
  } = options;

  return (Array.isArray(messages) ? messages : []).reduce((count, message) => {
    if (message?.role !== "assistant") return count;
    const content = getContentText(message.content);
    if (!isSuccessfulPushEventContent(content)) return count;
    const eventTime = parseTimestamp(content);
    return eventTime && eventTime > since ? count + 1 : count;
  }, 0);
}

function reconcileWakeState(storedState, userMarker, timelinePushCount) {
  const timelineCount = Number.isInteger(timelinePushCount) && timelinePushCount >= 0
    ? timelinePushCount
    : 0;
  const storedCount = Number.isInteger(storedState?.unanswered_pushes) && storedState.unanswered_pushes >= 0
    ? storedState.unanswered_pushes
    : 0;
  const sameUserMessage = storedState?.last_user_marker === userMarker;

  return {
    last_user_marker: userMarker,
    unanswered_pushes: sameUserMessage ? Math.max(storedCount, timelineCount) : timelineCount
  };
}

module.exports = {
  countPushesSince,
  getWakeDeadline,
  isHourInWindow,
  isQuietWindowExceptionDue,
  reconcileWakeState
};
