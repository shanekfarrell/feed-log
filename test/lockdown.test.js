const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../logic.js');

const C = 'Ab3dEf6hIj9kLm2nOp5qRs8t'; // 24 base62 chars
const T = new Date(2026, 9, 16, 13).getTime();

test('validCode accepts 24 base62 chars and rejects short or spaced codes', () => {
  assert.equal(F.validCode(C), true);
  assert.equal(F.validCode(''), false);
  assert.equal(F.validCode(C.slice(0, 19)), false);
  assert.equal(F.validCode('a b'.padEnd(24, 'x')), false);
});

test('inviteLink builds the share link', () => {
  assert.equal(F.inviteLink('https://x.app/', 'abcd1234', C), 'https://x.app/?room=abcd1234&code=' + C);
});

test('parseInvite finds the link inside a pasted WhatsApp message', () => {
  assert.deepEqual(F.parseInvite('Feed Log: https://x.app/?room=abcd1234&code=' + C + ' thanks'), { room: 'abcd1234', code: C });
});

test('parseInvite accepts params in any order', () => {
  assert.deepEqual(F.parseInvite('https://x.app/?code=' + C + '&room=abcd1234'), { room: 'abcd1234', code: C });
});

test('parseInvite rejects text without a valid link', () => {
  assert.equal(F.parseInvite('hello'), null);
  assert.equal(F.parseInvite('https://x.app/?room=abcd1234'), null);
  assert.equal(F.parseInvite('https://x.app/?room=ABC&code=' + C), null);
  assert.equal(F.parseInvite(''), null);
});

test('backupFile has the documented shape', () => {
  const ev = [{ id: 'a' }];
  assert.deepEqual(F.backupFile('abcd1234', ev, T), { app: 'feed-log', version: 1, room: 'abcd1234', exported_at: new Date(T).toISOString(), events: ev });
});

test('parseBackup restores into the current room and drops junk rows', () => {
  const good = { id: 'b1', room: 'otherroom1', type: 'bottle', at: new Date(T).toISOString(), by_name: 'A', data: { ml: 60 } };
  const text = JSON.stringify({ app: 'feed-log', version: 1, room: 'otherroom1', events: [good, { id: 'x', type: 'pumped' }] });
  const r = F.parseBackup(text, 'abcd1234');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].room, 'abcd1234');
  assert.equal(r.events[0].data.ml, 60);
  assert.equal(r.skipped, 1);
});

test('parseBackup rejects files that are not Feed Log v1 backups', () => {
  assert.equal(F.parseBackup('nope', 'abcd1234'), null);
  assert.equal(F.parseBackup(JSON.stringify({ app: 'x', version: 1, events: [] }), 'abcd1234'), null);
  assert.equal(F.parseBackup(JSON.stringify({ app: 'feed-log', version: 2, events: [] }), 'abcd1234'), null);
  assert.equal(F.parseBackup(JSON.stringify({ app: 'feed-log', version: 1 }), 'abcd1234'), null);
});

const ROOM_A = 'aaaa1111', ROOM_B = 'bbbb2222', CODE_B = 'Bb3dEf6hIj9kLm2nOp5qRs8t';
test('pickRoom: a full share link (room + code) wins', () => {
  assert.deepEqual(F.pickRoom({ urlRoom: ROOM_A, urlCode: C, storedRoom: ROOM_B, storedCode: CODE_B }), { room: ROOM_A, code: C });
});
test('pickRoom: a leftover address with only a room never overrides the phone’s own log (the "Join this log" bug)', () => {
  assert.deepEqual(F.pickRoom({ urlRoom: ROOM_A, urlCode: null, storedRoom: ROOM_B, storedCode: CODE_B }), { room: ROOM_B, code: CODE_B });
});
test('pickRoom: with nothing stored, a bare room address is used (old links)', () => {
  assert.deepEqual(F.pickRoom({ urlRoom: ROOM_A, urlCode: null, storedRoom: '', storedCode: '' }), { room: ROOM_A, code: '' });
});
test('pickRoom: nothing anywhere means a new log', () => {
  assert.deepEqual(F.pickRoom({ urlRoom: null, urlCode: null, storedRoom: '', storedCode: '' }), { room: '', code: '' });
  assert.deepEqual(F.pickRoom({ urlRoom: 'BAD!', urlCode: 'x', storedRoom: 'nope', storedCode: '' }), { room: '', code: '' });
});

test('pickRoom: the built-in family log always wins, so every phone opens the same log', () => {
  const family = { room: 'familyfam1', code: 'Ff3dEf6hIj9kLm2nOp5qRs8t' };
  assert.deepEqual(F.pickRoom({ urlRoom: ROOM_A, urlCode: C, storedRoom: ROOM_B, storedCode: CODE_B, family }), family);
  assert.deepEqual(F.pickRoom({ urlRoom: null, urlCode: null, storedRoom: '', storedCode: '', family }), family);
});

test('deriveId gives a stable UUID per log and original id', async () => {
  const a = await F.deriveId('roomaaaa1', 'x'), b = await F.deriveId('roomaaaa1', 'x'), c = await F.deriveId('roombbbb2', 'x');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('rowsToMove copies a phone’s own entries into the family log, skipping history and settings rows', async () => {
  const rows = [
    { id: 'u1', room: 'oldroom11', type: 'bottle', at: '2026-10-17T08:00:00.000Z', by_name: 'S', data: { ml: 60 } },
    { id: 'h1', room: 'oldroom11', type: 'breast', at: '2026-10-10T08:00:00.000Z', by_name: 'Imported', data: { status: 'done', segments: [{ side: 'L', start: 1, end: 2 }] } },
    { id: 'b1', room: 'oldroom11', type: 'baby', at: '2026-10-17T08:00:00.000Z', by_name: 'S', data: {} },
    { id: 'w1', room: 'oldroom11', type: 'weight', at: '2026-10-20T11:00:00.000Z', by_name: 'S', data: { kg: 4.7 } },
  ];
  const out = await F.rowsToMove(rows, 'familyfam1', new Set(['h1']));
  assert.deepEqual(out.map((r) => r.type), ['bottle', 'weight']);
  assert.ok(out.every((r) => r.room === 'familyfam1'));
  assert.equal(out[0].id, await F.deriveId('familyfam1', 'u1'));   // stable: moving twice never duplicates
  assert.equal(out[0].data.ml, 60);
});

test('roomsIn lists each other log once, never the family log', () => {
  const rows = [{ room: 'oldroom11' }, { room: 'oldroom22' }, { room: 'oldroom11' }, { room: 'familyfam1' }, { room: 'BAD' }];
  assert.deepEqual(F.roomsIn(rows, 'familyfam1'), ['oldroom11', 'oldroom22']);
});
