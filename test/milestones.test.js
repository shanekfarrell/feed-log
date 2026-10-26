const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../milestones.js');

test('week 1 starts on the day she is born', () => {
  assert.equal(M.milestones(0).now.label, 'Week 1');
  assert.equal(M.milestones(6).now.label, 'Week 1');
  assert.equal(M.milestones(7).now.label, 'Week 2');
});

test('at 24 days she is in week 4, with week 5 next', () => {
  const m = M.milestones(24);
  assert.equal(m.now.label, 'Week 4');
  assert.equal(m.next.label, 'Week 5');
  assert.ok(m.now.happening && m.now.see.length && m.now.try);
});

test('cards go week by week to 26 weeks, then months from 7 to 12', () => {
  assert.equal(M.milestones(84).now.label, 'Week 13');
  assert.equal(M.milestones(181).now.label, 'Week 26');
  assert.equal(M.milestones(181).next.label, '7 months');
  assert.equal(M.milestones(182).now.label, '7 months');
  assert.equal(M.milestones(250).now.label, '8 months');
  assert.equal(M.milestones(400).now.label, '12 months');
  assert.equal(M.milestones(400).next, null);
});

test('every entry has the three parts', () => {
  for (const e of M.ENTRIES) assert.ok(e.label && e.happening && Array.isArray(e.see) && e.see.length && e.try, e.label);
});

test('every card has a theme and one featured topic', () => {
  for (const e of M.ENTRIES) assert.ok(e.theme && e.focus.length === 2 && e.focus[0] && e.focus[1].length > 80, e.label);
  assert.equal(new Set(M.ENTRIES.map((e) => e.focus[0])).size, M.ENTRIES.length);
});

test('every entry fills every part of the card', () => {
  for (const e of M.ENTRIES) for (const s of M.SECTIONS) assert.ok(s.list ? e[s.key].length : e[s.key], `${e.label} ${s.key}`);
});

test('every part of every card names at least one source with a link', () => {
  for (const e of M.ENTRIES) for (const s of M.SECTIONS) {
    const src = M.sourcesFor(e, s.key);
    assert.ok(src.length, `${e.label} ${s.key}`);
    for (const x of src) assert.match(x.url, /^https:\/\//);
  }
});

test('an entry can add its own sources to a part, without repeats', () => {
  const w8 = M.ENTRIES.find((e) => e.label === 'Week 8');
  assert.deepEqual(M.sourcesFor(w8, 'eating').map((x) => x.name), ['NHS breastfeeding', 'NHS MenB vaccine']);
  assert.equal(M.sourcesFor(w8, 'happening')[0].name, 'NHS vaccination schedule');
  const m6 = M.ENTRIES.find((e) => e.label === 'Week 26');
  assert.equal(M.sourcesFor(m6, 'eating')[0].name, 'NHS first solid foods');
});

test('sleep and nappy guidelines change with her age', () => {
  const at = (label) => M.guide(M.ENTRIES.find((e) => e.label === label));
  assert.deepEqual(at('Week 5').sleep, [['Sleep in 24 h', '14–17 h'], ['Naps', 'Round the clock, 1–4 h each']]);
  assert.equal(at('Week 17').sleep[0][1], '12–16 h');
  assert.equal(at('12 months').sleep[0][1], '11–14 h');
  assert.equal(at('Week 3').nappies[0][1], '6 or more a day');
  assert.equal(at('Week 8').nappies[1][1], 'Several a day to one every few days');
  for (const e of M.ENTRIES) { const g = M.guide(e); assert.equal(g.sleep.length + g.nappies.length, 4, e.label); }
});

test('the boxes only show numbers that are new on that card', () => {
  const at = (label) => M.guideNew(M.ENTRIES.find((e) => e.label === label));
  assert.equal(Object.values(at('Week 1')).flat().length, 4);
  assert.deepEqual(at('Week 3'), { sleep: [['Sleep in 24 h', '14–17 h']] });
  assert.deepEqual(at('Week 5'), {});
  assert.deepEqual(at('Week 26'), { nappies: [['Poos', 'Around 2 a day on average']] });
});
