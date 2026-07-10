// VoiceChat — сигналинг-сервер + статика + файлообмен + комнаты
// VPS-режим (за nginx):  node server.js            → http://127.0.0.1:8443
// LAN-режим (без nginx): node server.js --tls      → https://<IP>:8443 (самоподписанный)
// Установка: npm install ws selfsigned
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8443;
const HOST = process.env.HOST || (process.argv.includes('--tls') ? '0.0.0.0' : '127.0.0.1');
const USE_TLS = process.argv.includes('--tls');
const PASSWORD = 'zhopa';           // пароль входа
const ADMIN_PASS = 'superzhopa42';  // пароль админки: в чате /admin superzhopa42
const DEFAULT_ROOM = 'общий';
const CALL_PREFIX = 'звонок-';      // скрытые комнаты личных звонков
const MAX_ROOMS = 20;
const HISTORY_MAX = 500;
const FILE_TTL = 24 * 3600 * 1000;   // вложения: каждые 24 часа
const ROOM_TTL = 24 * 3600 * 1000;  // переписка: раз в сутки

const PUB = path.join(__dirname, 'public');
const UPLOADS = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS)) fs.mkdirSync(UPLOADS);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const VID_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
const AUD_MIME = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.opus': 'audio/ogg' };
const files = {};

function handler(req, res) {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'POST' && url.pathname === '/upload') {
    const id = crypto.randomBytes(8).toString('hex');
    const name = decodeURIComponent(url.searchParams.get('name') || 'file').replace(/[/\\]/g, '_');
    const fp = path.join(UPLOADS, id);
    const ws = fs.createWriteStream(fp);
    let size = 0, failed = false;
    req.on('data', c => {
      size += c.length;
      if (size > 500 * 1024 * 1024 && !failed) {
        failed = true; ws.destroy(); fs.unlink(fp, () => {});
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'file too large (max 500 MB)' }));
        req.destroy();
      }
    });
    req.on('aborted', () => { failed = true; ws.destroy(); fs.unlink(fp, () => {}); });
    req.pipe(ws);
    ws.on('error', () => { if (!failed) { failed = true; res.writeHead(500); res.end('{"error":"write failed"}'); } });
    ws.on('finish', () => {
      if (failed) return;
      const ext = path.extname(name).toLowerCase();
      files[id] = { name, size, path: fp, image: !!IMG_MIME[ext], video: !!VID_MIME[ext], audio: !!AUD_MIME[ext], ts: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, name, size, image: files[id].image, video: files[id].video, audio: files[id].audio }));
    });
    return;
  }

  if (url.pathname.startsWith('/file/')) {
    const f = files[url.pathname.slice(6)];
    if (!f) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(f.name).toLowerCase();
    const inlineMime = f.image ? IMG_MIME[ext] : f.video ? VID_MIME[ext] : f.audio ? AUD_MIME[ext] : null;
    if (f.image) {
      res.writeHead(200, { 'Content-Type': inlineMime, 'Content-Length': f.size, 'Cache-Control': 'max-age=7200' });
      fs.createReadStream(f.path).pipe(res);
    } else if (f.video || f.audio) {
      const range = req.headers.range;
      if (range) {
        const [s, e] = range.replace('bytes=', '').split('-');
        const start = parseInt(s, 10) || 0;
        const end = e ? parseInt(e, 10) : f.size - 1;
        res.writeHead(206, {
          'Content-Type': inlineMime,
          'Content-Range': `bytes ${start}-${end}/${f.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1
        });
        fs.createReadStream(f.path, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': inlineMime, 'Content-Length': f.size, 'Accept-Ranges': 'bytes' });
        fs.createReadStream(f.path).pipe(res);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': f.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`
      });
      fs.createReadStream(f.path).pipe(res);
    }
    return;
  }

  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function start() {
  let server;
  if (USE_TLS) {
    const KEY = path.join(__dirname, 'key.pem');
    const CERT = path.join(__dirname, 'cert.pem');
    if (!fs.existsSync(KEY) || !fs.existsSync(CERT)) {
      console.log('Генерирую самоподписанный сертификат...');
      const selfsigned = require('selfsigned');
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'voicechat' }], { keySize: 2048, days: 365 });
      fs.writeFileSync(KEY, pems.private);
      fs.writeFileSync(CERT, pems.cert);
    }
    server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, handler);
  } else {
    server = http.createServer(handler);
  }

  const wss = new WebSocketServer({ server });
  const peers = new Map(); // id -> { ws, name, muted, room, avatar, admin, ghost, sharing }
  const rooms = new Map(); // name -> { history: [], custom, pass }
  rooms.set(DEFAULT_ROOM, { history: [], custom: false, pass: null });

  function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function bcRoom(room, msg, except) { for (const [id, p] of peers) if (p.room === room && id !== except) send(p.ws, msg); }
  function bcAll(msg) { for (const p of peers.values()) send(p.ws, msg); }
  function roster(room) {
    return [...peers.entries()]
      .filter(([, p]) => p.room === room && !p.ghost)
      .map(([id, p]) => ({ id, name: p.name, muted: p.muted, avatar: p.avatar, sharing: p.sharing }));
  }
  function roomsInfo() {
    return [...rooms.entries()]
      .filter(([name]) => !name.startsWith(CALL_PREFIX)) // личные звонки не светим в списке
      .map(([name, r]) => ({
        name,
        count: [...peers.values()].filter(p => p.room === name && !p.ghost).length,
        locked: !!r.pass
      }));
  }
  function pushRoomsUpdate() { bcAll({ type: 'rooms', rooms: roomsInfo() }); }
  function remember(room, msg) {
    const r = rooms.get(room); if (!r) return;
    r.history.push(msg); if (r.history.length > HISTORY_MAX) r.history.shift();
  }
  function maybeDeleteCallRoom(name) {
    if (!name?.startsWith(CALL_PREFIX)) return;
    if (![...peers.values()].some(p => p.room === name)) rooms.delete(name);
  }

  function enterRoom(id, roomName, roomPass) {
    const p = peers.get(id); if (!p) return;
    roomName = String(roomName || DEFAULT_ROOM).trim().slice(0, 32) || DEFAULT_ROOM;
    const existing = rooms.get(roomName);
    if (!existing) {
      if (rooms.size >= MAX_ROOMS) { send(p.ws, { type: 'sys', text: `лимит комнат (${MAX_ROOMS})` }); return; }
      rooms.set(roomName, { history: [], custom: true, pass: roomPass ? String(roomPass).slice(0, 64) : null });
    } else if (existing.pass && !p.admin && existing.pass !== roomPass) {
      send(p.ws, { type: 'room-denied', room: roomName });
      return;
    }
    const old = p.room;
    if (old && old !== roomName) {
      if (!p.ghost) bcRoom(old, { type: 'user-left', id }, id);
      maybeDeleteCallRoom(old);
    }
    p.room = roomName;
    p.sharing = false; // демка не переезжает между комнатами
    send(p.ws, { type: 'room-joined', id, room: roomName, users: roster(roomName), history: rooms.get(roomName).history });
    if (!p.ghost) bcRoom(roomName, { type: 'user-joined', id, name: p.name, avatar: p.avatar }, id);
    pushRoomsUpdate();
  }

  // --- чистки ---
  setInterval(() => {
    for (const [fid, f] of Object.entries(files)) { fs.unlink(f.path, () => {}); delete files[fid]; }
    fs.readdir(UPLOADS, (err, list) => { if (!err) for (const n of list) fs.unlink(path.join(UPLOADS, n), () => {}); });
    for (const r of rooms.values()) r.history = r.history.filter(m => m.type !== 'file');
    bcAll({ type: 'sys', text: 'вложения очищены (авточистка раз в 2 часа)' });
    console.log('[cleanup-2h] вложения очищены');
  }, FILE_TTL);
  setInterval(() => {
    for (const [name, r] of rooms) {
      r.history.length = 0;
      const empty = ![...peers.values()].some(p => p.room === name);
      if (r.custom && empty) rooms.delete(name);
      else bcRoom(name, { type: 'clear' }, null);
    }
    pushRoomsUpdate();
    console.log('[cleanup-24h] переписка очищена, пустые комнаты удалены');
  }, ROOM_TTL);

  // --- админ-команды ---
  function clearRoomAndFiles(room) {
    for (const [fid, f] of Object.entries(files)) { fs.unlink(f.path, () => {}); delete files[fid]; }
    fs.readdir(UPLOADS, (err, list) => { if (!err) for (const n of list) fs.unlink(path.join(UPLOADS, n), () => {}); });
    const r = rooms.get(room); if (r) r.history.length = 0;
    bcRoom(room, { type: 'clear' }, null);
  }
  function adminCommand(id, ws, text) {
    const p = peers.get(id);
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const arg = args.join(' ');
    const reply = t => send(ws, { type: 'sys', text: t });
    switch (cmd) {
      case 'help':
        reply('команды: /clear · /kick имя · /list · /rooms · /delroom имя · /files · /ghost');
        break;
      case 'ghost': {
        p.ghost = !p.ghost;
        if (p.ghost) bcRoom(p.room, { type: 'user-left', id }, id);
        else bcRoom(p.room, { type: 'user-joined', id, name: p.name, avatar: p.avatar }, id);
        pushRoomsUpdate();
        send(ws, { type: 'ghost', on: p.ghost });
        reply(p.ghost ? 'невидимка ВКЛ, не забудь мут!' : 'невидимка ВЫКЛ');
        break;
      }
      case 'clear':
        clearRoomAndFiles(p.room);
        reply('комната и вложения очищены');
        break;
      case 'kick': {
        const target = [...peers.entries()].find(([pid, pr]) => pr.name.toLowerCase() === arg.toLowerCase() && pid !== id);
        if (!target) { reply(`не нашёл "${arg}"`); break; }
        send(target[1].ws, { type: 'kicked' });
        target[1].ws.close();
        reply(`${target[1].name} выгнан`);
        break;
      }
      case 'list':
        reply('онлайн: ' + ([...peers.values()].map(pr => `${pr.name} [${pr.room}]${pr.muted ? ' (мут)' : ''}${pr.ghost ? ' (призрак)' : ''}${pr.admin ? ' (админ)' : ''}`).join(', ') || 'никого'));
        break;
      case 'rooms':
        reply('комнаты: ' + [...rooms.entries()].map(([n, r]) => `${n}${r.pass ? ' 🔒' : ''} (${[...peers.values()].filter(pp => pp.room === n).length})`).join(', '));
        break;
      case 'delroom': {
        if (!rooms.has(arg)) { reply(`нет комнаты "${arg}"`); break; }
        if (arg === DEFAULT_ROOM) { reply('общий канал не удаляется'); break; }
        for (const [pid, pr] of peers) if (pr.room === arg) enterRoom(pid, DEFAULT_ROOM);
        rooms.delete(arg);
        pushRoomsUpdate();
        reply(`комната "${arg}" удалена`);
        break;
      }
      case 'files': {
        const list = Object.values(files);
        const total = list.reduce((a, f) => a + f.size, 0);
        reply(list.length ? `вложений: ${list.length}, всего ${(total / 1048576).toFixed(1)} МБ` : 'вложений нет');
        break;
      }
      default:
        reply(`не знаю команду /${cmd}, есть /help`);
    }
  }

  wss.on('connection', ws => {
    const id = crypto.randomBytes(6).toString('hex');
    let authed = false;
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }

      if (m.type === 'ping') { send(ws, { type: 'pong' }); return; }

      if (m.type === 'join') {
        if (m.password !== PASSWORD) { send(ws, { type: 'auth-fail' }); ws.close(); return; }
        authed = true;
        let avatar = null;
        if (typeof m.avatar === 'string' && m.avatar.startsWith('data:image/') && m.avatar.length < 80000) avatar = m.avatar;
        peers.set(id, { ws, name: String(m.name || 'Гость').slice(0, 32), muted: false, room: null, avatar, admin: false, ghost: false, sharing: false });
        send(ws, { type: 'rooms', rooms: roomsInfo() });
        enterRoom(id, m.room || DEFAULT_ROOM, m.roomPass);
        if (!peers.get(id).room) enterRoom(id, DEFAULT_ROOM);
        return;
      }
      if (!authed) return;
      const p = peers.get(id); if (!p) return;

      switch (m.type) {
        case 'switch-room':
          enterRoom(id, m.room, m.roomPass);
          break;
        case 'offer': case 'answer': case 'ice': {
          const t = peers.get(m.to);
          if (t && t.room === p.room) send(t.ws, { ...m, from: id });
          break;
        }
        case 'mute':
          p.muted = !!m.muted;
          bcRoom(p.room, { type: 'mute', id, muted: !!m.muted }, null);
          break;
        case 'typing':
          bcRoom(p.room, { type: 'typing', name: p.name }, id);
          break;
        case 'screen':
          p.sharing = !!m.on;
          bcRoom(p.room, { type: 'screen', id, name: p.name, on: p.sharing }, id);
          break;
        case 'call-invite': {
          const t = peers.get(m.to);
          if (!t) { send(ws, { type: 'sys', text: 'пользователь уже отключился' }); break; }
          const callRoom = CALL_PREFIX + crypto.randomBytes(3).toString('hex');
          rooms.set(callRoom, { history: [], custom: true, pass: null });
          send(t.ws, { type: 'call-invite', from: id, name: p.name, room: callRoom });
          enterRoom(id, callRoom); // зовущий сразу переходит и ждёт
          break;
        }
        case 'call-decline': {
          const t = peers.get(m.to);
          if (t) send(t.ws, { type: 'call-declined', name: p.name });
          break;
        }
        case 'react': {
          const r = rooms.get(p.room); if (!r) break;
          const msg = r.history.find(h => h.id === m.msgId); if (!msg) break;
          const emoji = String(m.emoji).slice(0, 8);
          msg.reactions = msg.reactions || {};
          const list = msg.reactions[emoji] = msg.reactions[emoji] || [];
          const i = list.indexOf(p.name);
          if (i >= 0) list.splice(i, 1); else list.push(p.name);
          if (!list.length) delete msg.reactions[emoji];
          bcRoom(p.room, { type: 'react', msgId: m.msgId, reactions: msg.reactions }, null);
          break;
        }
        case 'chat': {
          const text = String(m.text).slice(0, 4000);
          if (text.startsWith('/')) {
            if (text.startsWith('/admin ')) {
              if (text.slice(7).trim() === ADMIN_PASS) { p.admin = true; send(ws, { type: 'sys', text: 'админка активна, команды: /help' }); }
              else send(ws, { type: 'sys', text: 'команды недоступны' });
              break;
            }
            if (p.admin) adminCommand(id, ws, text);
            else send(ws, { type: 'sys', text: 'команды недоступны' });
            break;
          }
          const msg = { type: 'chat', id: crypto.randomBytes(4).toString('hex'), from: id, name: p.name, text, ts: Date.now() };
          if (m.replyTo && typeof m.replyTo === 'object') {
            msg.replyTo = { id: String(m.replyTo.id || '').slice(0, 16), name: String(m.replyTo.name || '').slice(0, 32), text: String(m.replyTo.text || '').slice(0, 120) };
          }
          remember(p.room, msg);
          bcRoom(p.room, msg, null);
          break;
        }
        case 'file': {
          const msg = { type: 'file', id: crypto.randomBytes(4).toString('hex'), from: id, name: p.name, file: m.file, ts: Date.now() };
          remember(p.room, msg);
          bcRoom(p.room, msg, null);
          break;
        }
      }
    });
    ws.on('close', () => {
      const p = peers.get(id);
      if (p) {
        peers.delete(id);
        if (!p.ghost) bcRoom(p.room, { type: 'user-left', id }, null);
        maybeDeleteCallRoom(p.room);
        pushRoomsUpdate();
      }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`\nVoiceChat запущен (${USE_TLS ? 'HTTPS, LAN-режим' : 'HTTP, за nginx'}):`);
    if (USE_TLS) {
      for (const ifs of Object.values(os.networkInterfaces()))
        for (const i of ifs) if (i.family === 'IPv4' && !i.internal) console.log(`  https://${i.address}:${PORT}`);
    } else {
      console.log(`  http://${HOST}:${PORT}  (nginx проксирует сюда)`);
    }
    console.log('');
  });
}
start();
