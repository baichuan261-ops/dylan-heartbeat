// A quiet conversation may be reconsidered after a bounded cooldown.
// This only allows a model decision; it never forces a notification.
function remainingWakeCooldownMs(lastUserTime, latestPushTime, now, minutes = 240) {
  if (!latestPushTime) return 0;
  const user = new Date(lastUserTime).getTime();
  const push = new Date(latestPushTime).getTime();
  const current = new Date(now).getTime();
  if (![user, push, current].every(Number.isFinite) || push < user) return 0;
  const duration = Number.isFinite(minutes) && minutes >= 1 ? minutes : 240;
  return Math.max(0, push + duration * 60000 - current);
}

module.exports = { remainingWakeCooldownMs };
