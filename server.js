// AI 三国杀 — 上帝视角围观台（5 人身份局，LLM 互坑）
// 简化规则：60 张牌堆、无装备/距离/判定，杀/闪/桃/决斗/无中生有/过河拆桥/顺手牵羊
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = cfg.port || 8901;
const MAX_ROUNDS = cfg.maxRounds || 10;      // 轮数上限，防拖局
const HAND_LIMIT = 4;                        // 回合结束保底牌数（简化）
const BOARD_FILE = path.join(ROOT, 'board.json');
const GAMES_DIR = path.join(ROOT, 'games');

if (!Array.isArray(cfg.players) || cfg.players.length !== 5) {
  console.error('[配置错误] config.json 里 players 必须恰好 5 名'); process.exit(1);
}
if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

// ---------- 牌堆 ----------
const CARD_DEFS = [['杀',20],['闪',15],['桃',10],['决斗',5],['无中生有',5],['过河拆桥',5],['顺手牵羊',5]];
function buildDeck() {
  const d = [];
  for (const [name, n] of CARD_DEFS) for (let i = 0; i < n; i++) d.push(name);
  return shuffle(d);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------- 身份 ----------
// 1主公 1忠臣 2反贼 1内奸；主公公开，其余暗置（上帝视角可见）
function buildRoles() { return shuffle(['lord', 'loyal', 'rebel', 'rebel', 'traitor']); }
const ROLE_NAME = { lord: '主公', loyal: '忠臣', rebel: '反贼', traitor: '内奸' };
const ROLE_COLOR = { lord: '#f6c344', loyal: '#6fbf5a', rebel: '#e05555', traitor: '#9b7fd4' };

// ---------- 游戏状态 ----------
let state = null;
let bet = null;               // { choice: 'lord'|'rebel'|'traitor', amount }
let clients = [];             // SSE 订阅
let running = false;

function log(type, text, extra) {
  const ev = { t: Date.now(), type, text, ...extra };
  state.events.push(ev);
  broadcast({ kind: 'event', event: ev, snapshot: snapshot() });
  return ev;
}
function snapshot() {
  return {
    round: state.round, phase: state.phase, winner: state.winner, bet,
    players: state.players.map(p => ({
      seat: p.seat, general: p.general, name: p.name, role: p.role,
      hp: p.hp, maxHp: p.maxHp, alive: p.alive,
      hand: p.hand.slice(), handCount: p.hand.length, thinking: p.thinking || ''
    }))
  };
}
function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch (e) {} }
}

// ---------- LLM 调用 ----------
async function callModel(p, messages) {
  const body = { model: p.model, messages, max_tokens: 1200, temperature: 0.7 };
  const r = await fetch(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + p.key },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  let text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (typeof text !== 'string') text = '';
  return text;
}
// 提取 ACTION/RESPOND 协议行；失败兜底 PASS
function extractDirective(text) {
  const m = text.match(/(?:ACTION|RESPOND)[:：]\s*(.+)/);
  if (!m) return null;
  let s = m[1].trim();
  s = s.split('\n')[0].trim();
  return s.length >= 2 ? s : null;
}

function seatList(state_) {
  return state_.players.map(p =>
    `${p.seat}号${p.general}（${ROLE_NAME[p.role]}，体力${p.hp}/${p.maxHp}${p.alive ? '' : '，已阵亡'}，手牌${p.hand.length}张）`
  ).join('\n');
}
function roleHint(role) {
  if (role === 'lord') return '你是主公。忠臣会护你，反贼和内奸都想杀你。尽量除掉可疑者，但要小心误伤忠臣。';
  if (role === 'loyal') return '你是忠臣，唯一胜利方式是保住主公、消灭所有反贼和内奸。主公是公开身份。';
  if (role === 'rebel') return '你是反贼，另一个反贼是你的同伴（你知道他是谁）。胜利方式是杀死主公。';
  return '你是内奸，全场没人知道你的身份。你要先帮反贼削弱忠臣，最后和主公单挑，活到最后一个死即胜（清场时你必须是唯一存活者以外的最后一人时 killing lord 会让反贼赢，所以要先灭反贼再杀主公）。胜利条件：成为除你之外只剩主公时，亲手杀死主公。';
}

function playPrompt(p) {
  const others = state.players.filter(x => x.seat !== p.seat && x.alive);
  return [
    `你是三国杀 ${p.seat}号 ${p.general}，当前体力 ${p.hp}/${p.maxHp}。`,
    roleHint(p.role),
    `你的手牌：${p.hand.join('、') || '（无）'}`,
    `场上信息：\n${seatList(state)}`,
    `最近战况：\n${state.events.slice(-6).map(e => e.text).join('\n') || '（开局）'}`,
    `出牌规则：回合内可以打出若干张牌（有牌即可反复出），出完选择结束。`,
    `可出：杀 [目标号]（每回合限1次）；无中生有（摸2）；过河拆桥 [目标号]（弃其1张随机手牌）；顺手牵羊 [目标号]（拿其1张随机手牌）；桃（体力已满时不要吃）。`,
    `只能回复一行协议指令，格式严格如下（四选一）：`,
    `ACTION: 杀 3号`,
    `ACTION: 无中生有`,
    `ACTION: 过河拆桥 4号`,
    `ACTION: PASS`
  ].join('\n');
}
function respondPrompt(p, situation) {
  return [
    `你是三国杀 ${p.seat}号 ${p.general}（体力 ${p.hp}/${p.maxHp}）。${roleHint(p.role)}`,
    `你的手牌：${p.hand.join('、') || '（无）'}`,
    `场上信息：\n${seatList(state)}`,
    `最近战况：\n${state.events.slice(-4).map(e => e.text).join('\n')}`,
    situation,
    `只能回复一行协议指令，格式严格如下（二选一）：`,
    `RESPOND: 出`
  ].join('\n');
}

// ---------- 决策：主动出牌 ----------
async function decidePlay(p) {
  p.thinking = '思考中…';
  broadcast({ kind: 'snapshot', snapshot: snapshot() });
  let raw = '';
  try {
    raw = await callModel(p, [
      { role: 'system', content: '你是三国杀玩家，只输出协议指令，不要解释，不要思考过程。' },
      { role: 'user', content: playPrompt(p) }
    ]);
  } catch (e) {
    log('sys', `${p.seat}号 ${p.general} 掉线（${e.message}），跳过出牌`);
    p.thinking = '';
    return null;
  }
  p.thinking = '';
  const dir = extractDirective(raw) || 'PASS';
  broadcast({ kind: 'snapshot', snapshot: snapshot() });
  return dir;
}
// ---------- 决策：响应（闪/杀/桃） ----------
async function decideRespond(p, kind) {
  const situation = kind === 'sha' ? `你正被「杀」指定为目标，有「闪」可以抵消，否则体力-1。`
    : kind === 'duel' ? `你正身处「决斗」，需要打出「杀」，否则体力-1。`
    : `你（或濒死的队友）体力归零，有「桃」可以救。`;
  let raw = '';
  try {
    raw = await callModel(p, [
      { role: 'system', content: '你是三国杀玩家，只输出协议指令，不要解释。' },
      { role: 'user', content: respondPrompt(p, situation) }
    ]);
  } catch (e) { return 'PASS'; }
  const dir = extractDirective(raw) || 'PASS';
  return dir.includes('出') && !dir.includes('不出') ? '出' : 'PASS';
}

function discardRandom(p) {
  if (!p.hand.length) return null;
  const i = Math.floor(Math.random() * p.hand.length);
  return p.hand.splice(i, 1)[0];
}
function drawCards(p, n) {
  for (let i = 0; i < n; i++) {
    if (!state.deck.length) {
      state.deck = shuffle(state.discard.splice(0));
      if (!state.deck.length) break;
      log('sys', '牌堆摸空，弃牌堆洗回');
    }
    p.hand.push(state.deck.pop());
  }
}
function useCard(p, card) {
  const i = p.hand.indexOf(card);
  if (i >= 0) { p.hand.splice(i, 1); state.discard.push(card); }
}
function giveCard(from, to) {
  const c = discardRandom(from);
  if (c) to.hand.push(c);
  return c;
}

// ---------- 濒死结算 ----------
async function dyingPhase(p) {
  if (p.hp > 0) return;
  const askers = state.players.filter(x => x.alive && x.hand.includes('桃'));
  for (const asker of askers) {
    // 自己或别人出桃均可救（简化：任何人可救任何人）
    const dir = await decideRespond(asker, 'tao');
    if (dir === '出' && asker.hand.includes('桃')) {
      useCard(asker, '桃');
      p.hp = 1;
      log('tao', `${asker.seat}号 ${asker.general} 打出【桃】，救回 ${p.seat}号 ${p.general}（体力回复到 1）`);
      return;
    }
  }
  p.alive = false;
  state.discard.push(...p.hand); p.hand = [];
  log('death', `☠ ${p.seat}号 ${p.general}（${ROLE_NAME[p.role]}）体力耗尽，阵亡！`, { death: p.seat });
  checkWin();
}

// ---------- 杀 ----------
async function resolveSha(src, tgt) {
  useCard(src, '杀');
  log('sha', `${src.seat}号 ${src.general} 对 ${tgt.seat}号 ${tgt.general} 打出【杀】`);
  const dir = tgt.hand.includes('闪') ? await decideRespond(tgt, 'sha') : 'PASS';
  if (dir === '出' && tgt.hand.includes('闪')) {
    useCard(tgt, '闪');
    log('dodge', `${tgt.seat}号 ${tgt.general} 打出【闪】，躲过了【杀】`);
  } else {
    tgt.hp -= 1;
    log('hit', `${tgt.seat}号 ${tgt.general} 没有闪，体力 -1 → ${tgt.hp}/${tgt.maxHp}`);
    await dyingPhase(tgt);
  }
}
// ---------- 决斗 ----------
async function resolveDuel(src, tgt) {
  useCard(src, '决斗');
  log('duel', `${src.seat}号 ${src.general} 对 ${tgt.seat}号 ${tgt.general} 使用【决斗】！（对方先出杀，轮流出杀，不出者 -1 体力）`);
  let attacker = tgt, defender = src;
  while (true) {
    const dir = attacker.hand.includes('杀') ? await decideRespond(attacker, 'duel') : 'PASS';
    if (dir === '出' && attacker.hand.includes('杀')) {
      useCard(attacker, '杀');
      log('duel-fight', `${attacker.seat}号 ${attacker.general} 打出【杀】应战`);
      [attacker, defender] = [defender, attacker];
    } else {
      attacker.hp -= 1;
      log('duel-lose', `${attacker.seat}号 ${attacker.general} 决斗落败，体力 -1 → ${attacker.hp}/${attacker.maxHp}`);
      await dyingPhase(attacker);
      break;
    }
    if (state.winner) break;
  }
}

// ---------- 出牌解析 ----------
function parseAction(dir, p) {
  dir = dir.trim();
  if (/^PASS$/i.test(dir)) return null;
  const tgtM = dir.match(/(\d+)\s*号?$/);
  const tgtSeat = tgtM ? parseInt(tgtM[1], 10) : null;
  if (dir.includes('杀') && !dir.includes('决斗')) {
    if (p.playedShaThisTurn) return { error: '杀每回合限一次' };
    if (!p.hand.includes('杀')) return { error: '手里没有杀' };
    if (!tgtSeat || tgtSeat === p.seat) return { error: '杀需要指定别的玩家' };
    const tgt = state.players.find(x => x.seat === tgtSeat);
    if (!tgt || !tgt.alive) return { error: '目标无效' };
    return { type: 'sha', tgt };
  }
  if (dir.includes('决斗')) {
    if (!p.hand.includes('决斗')) return { error: '手里没有决斗' };
    if (!tgtSeat || tgtSeat === p.seat) return { error: '决斗需要指定目标' };
    const tgt = state.players.find(x => x.seat === tgtSeat);
    if (!tgt || !tgt.alive) return { error: '目标无效' };
    return { type: 'duel', tgt };
  }
  if (dir.includes('无中生有')) {
    if (!p.hand.includes('无中生有')) return { error: '手里没有无中生有' };
    return { type: 'draw2' };
  }
  if (dir.includes('过河拆桥')) {
    if (!p.hand.includes('过河拆桥')) return { error: '手里没有过河拆桥' };
    if (!tgtSeat || tgtSeat === p.seat) return { error: '拆桥需要指定目标' };
    const tgt = state.players.find(x => x.seat === tgtSeat);
    if (!tgt || !tgt.alive || !tgt.hand.length) return { error: '目标无效或没手牌' };
    return { type: 'dismantle', tgt };
  }
  if (dir.includes('顺手牵羊')) {
    if (!p.hand.includes('顺手牵羊')) return { error: '手里没有顺手牵羊' };
    if (!tgtSeat || tgtSeat === p.seat) return { error: '牵羊需要指定目标' };
    const tgt = state.players.find(x => x.seat === tgtSeat);
    if (!tgt || !tgt.alive || !tgt.hand.length) return { error: '目标无效或没手牌' };
    return { type: 'steal', tgt };
  }
  if (dir.includes('桃')) return { error: '出牌阶段不能吃桃（自动救）' };
  return { error: '无法识别指令' };
}

// ---------- 胜负 ----------
function checkWin() {
  const alive = state.players.filter(p => p.alive);
  const lord = state.players.find(p => p.role === 'lord');
  const traitor = state.players.find(p => p.role === 'traitor');
  if (!lord.alive) {
    if (traitor.alive && alive.length === 1) endGame('traitor');
    else endGame('rebel');
  } else if (!alive.some(p => p.role === 'rebel') && !alive.some(p => p.role === 'traitor')) {
    endGame('lord');
  }
}
function endGame(winner) {
  state.winner = winner;
  const label = { lord: '主公方（主公+忠臣）胜！', rebel: '反贼胜！', traitor: '内奸独赢，一穿四！' }[winner];
  log('win', `🏆 ${label}`);
  saveGame();
  updateBoard(winner);
  running = false;
}

// ---------- 回合主循环 ----------
async function playTurn(p) {
  if (!p.alive || state.winner) return;
  state.phase = `${p.seat}号回合`;
  p.playedShaThisTurn = false;
  drawCards(p, 2);
  log('turn', `— ${p.seat}号 ${p.general} 的回合（摸2张，手牌${p.hand.length}张）—`, { seat: p.seat });
  for (let i = 0; i < 6; i++) {
    if (state.winner || !p.alive) return;
    const dir = await decidePlay(p);
    if (!dir || /^PASS$/i.test(dir.trim())) break;
    const act = parseAction(dir, p);
    if (act && act.error) {
      log('bad', `${p.seat}号 ${p.general} 指令无效（${act.error}）：${dir}，跳过本次`);
      continue;
    }
    if (act.type === 'sha') { p.playedShaThisTurn = true; await resolveSha(p, act.tgt); }
    else if (act.type === 'duel') { await resolveDuel(p, act.tgt); }
    else if (act.type === 'draw2') { useCard(p, '无中生有'); drawCards(p, 2); log('draw', `${p.seat}号 ${p.general} 无中生有，摸2张（手牌${p.hand.length}张）`); }
    else if (act.type === 'dismantle') { useCard(p, '过河拆桥'); const c = discardRandom(act.tgt); log('dismantle', `${p.seat}号 ${p.general} 对 ${act.tgt.seat}号 使用【过河拆桥】，拆掉其 ${c ? '【' + c + '】' : '（无牌可拆）'}`); }
    else if (act.type === 'steal') { useCard(p, '顺手牵羊'); const c = giveCard(act.tgt, p); log('steal', `${p.seat}号 ${p.general} 对 ${act.tgt.seat}号 使用【顺手牵羊】，顺走 ${c ? '【' + c + '】' : '（没顺到）'}`); }
    await sleep(300);
  }
  // 简化：回合结束不弃牌（HAND_LIMIT 逻辑留空，见 README 说明）
}

async function gameLoop() {
  const GENERALS = cfg.generals || ['关羽', '张飞', '诸葛亮', '赵云', '吕布'];
  const roles = buildRoles();
  const order = shuffle([0, 1, 2, 3, 4]);
  // 主公固定坐 1 号位（三国杀惯例），其余随机
  const lordIdx = roles.indexOf('lord');
  const seats = [roles[lordIdx], ...roles.filter((_, i) => i !== lordIdx)];
  state = { players: [], deck: buildDeck(), discard: [], round: 0, phase: '开局', winner: null, events: [] };
  const playersCfg = shuffle(cfg.players.slice());
  for (let i = 0; i < 5; i++) {
    const role = seats[i];
    const pc = playersCfg[i];
    state.players.push({
      seat: i + 1, general: GENERALS[i], name: pc.name, role,
      url: pc.url, key: pc.key, model: pc.model,
      hp: role === 'lord' ? 5 : 4, maxHp: role === 'lord' ? 5 : 4,
      hand: [], alive: true, thinking: ''
    });
  }
  for (const p of state.players) drawCards(p, 4);
  log('start', `开局！${state.players.map(p => `${p.seat}号${p.general}`).join('、')}。1号是主公（公开），其余身份暗置。`);
  log('roles', `【上帝视角】身份分布：${state.players.map(p => `${p.seat}号=${ROLE_NAME[p.role]}`).join('，')}`);

  let cursor = 0;
  while (!state.winner && state.round <= MAX_ROUNDS) {
    state.round = Math.floor(cursor / 5) + 1;
    if (cursor % 5 === 0 && !state.winner) log('round', `========== 第 ${state.round} 轮 ==========`);
    await playTurn(state.players[cursor % 5]);
    cursor++;
  }
  if (!state.winner) {
    log('win', '⏱ 达到轮数上限，判定为平局（上帝视角懒得看下去了）');
    state.winner = 'draw'; running = false; saveGame();
  }
}

// ---------- 押注 ----------
function settleBet(winner) {
  if (!bet) return;
  const win = bet.choice === winner && winner !== 'draw';
  bet.result = win ? 'win' : 'lose';
  bet.payout = win ? bet.amount * ({ lord: 2.5, rebel: 2.0, traitor: 8.0 }[winner] || 0) : 0;
  bet.settledText = win
    ? `🎉 押中 ${bet.choice === 'lord' ? '主公方' : bet.choice === 'rebel' ? '反贼' : '内奸'}！赢得 ¥${bet.payout.toFixed(1)}（本金¥${bet.amount}）`
    : `💸 押错了，本金 ¥${bet.amount} 没了`;
  log('bet', bet.settledText);
}

// ---------- 持久化 ----------
function loadBoard() {
  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (e) { return { models: {}, bets: { win: 0, lose: 0, earned: 0 } }; }
}
function updateBoard(winner) {
  const b = loadBoard();
  for (const p of state.players) {
    const k = p.name;
    b.models[k] = b.models[k] || { win: 0, games: 0, roles: {} };
    b.models[k].games++;
    if ((winner === 'lord' && (p.role === 'lord' || p.role === 'loyal')) ||
        (winner === 'rebel' && p.role === 'rebel') ||
        (winner === 'traitor' && p.role === 'traitor')) b.models[k].win++;
    b.models[k].roles[p.role] = (b.models[k].roles[p.role] || 0) + 1;
  }
  if (bet) { b.bets[bet.result === 'win' ? 'win' : 'lose']++; if (bet.result === 'win') b.bets.earned += bet.payout; bet = null; }
  fs.writeFileSync(BOARD_FILE, JSON.stringify(b, null, 2));
}
function saveGame() {
  if (!state) return;
  const file = path.join(GAMES_DIR, `game-${Date.now()}.json`);
  try { fs.writeFileSync(file, JSON.stringify({ players: state.players.map(p => ({ seat: p.seat, general: p.general, name: p.name, role: p.role, hp: p.hp, alive: p.alive, hand: p.hand })), events: state.events, winner: state.winner }, null, 2)); } catch (e) {}
}

// ---------- HTTP ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  } else if (u.pathname === '/api/state') {
    json(res, 200, { snapshot: state ? snapshot() : null, running });
  } else if (u.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify({ kind: 'hello', snapshot: state ? snapshot() : null }) + '\n\n');
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
  } else if (req.method === 'POST' && u.pathname === '/api/start') {
    if (running) return json(res, 400, { error: '对局进行中' });
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { const j = body ? JSON.parse(body) : {}; if (j.choice && j.amount) bet = { choice: j.choice, amount: j.amount, result: null, payout: 0 }; } catch (e) {}
      running = true;
      json(res, 200, { ok: true });
      gameLoop().then(() => { if (bet && state && state.winner) settleBet(state.winner); }).catch(e => {
        console.error(e);
        if (state) log('sys', `💥 引擎异常：${e.message}`);
        running = false;
      });
    });
  } else if (u.pathname === '/api/board') {
    json(res, 200, loadBoard());
  } else {
    res.writeHead(404); res.end('404');
  }
});
server.listen(PORT, () => console.log(`AI 三国杀上帝视角已启动: http://localhost:${PORT}`));
