// Built-in feed history to copy into a new log once (empty here). The browser gets window.FeedHistory.
(function (root) {
  const EVENTS = [];
  const L = root.FeedLogic;
  const historyFor = async (room) => Promise.all(EVENTS.map(async (e) => ({ ...e, id: await L.deriveId(room, e.id), room })));
  const missingHistory = (evs, haveIds) => evs.filter((e, i) => !haveIds.has(e.id) && !haveIds.has(EVENTS[i].id));
  root.FeedHistory = { EVENTS, historyFor, missingHistory };
})(self);
