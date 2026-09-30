(function () {
'use strict';
if (!window.supabase || !window.APP_CONFIG) {
  document.getElementById('boot').innerHTML = '<span>필요한 파일을 불러오지 못했습니다. 인터넷 연결을 확인하고, config.js가 같은 폴더에 있는지 확인하세요.</span>';
  return;
}
const { createClient } = window.supabase;
const { SUPABASE_URL, SUPABASE_ANON_KEY, ID_DOMAIN, MAX_FILE_MB, SITE_NAME } = window.APP_CONFIG;

/* ---------- 도구 ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const TZ = 'Asia/Seoul';
const kst = d => new Date(d).toLocaleString('sv-SE', { timeZone: TZ, hour12: false }).slice(0, 16); // YYYY-MM-DD HH:MM
const today = () => kst(new Date()).slice(0, 10);
const dt = iso => (iso ? kst(iso) : '—');
const monday = v => { const d = new Date(v + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const addDays = (v, n) => { const d = new Date(v + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekLabel = m => m + ' ~ ' + addDays(m, 6).slice(5);
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
const weekShort = m => `${md(m)}~${md(addDays(m, 6))}`;
function weekName(m) {
  const w0 = monday(today());
  if (m === w0) return `이번 주 (${weekShort(m)})`;
  if (m === addDays(w0, -7)) return `지난주 (${weekShort(m)})`;
  return (m.slice(0, 4) !== w0.slice(0, 4) ? m.slice(0, 4) + '년 ' : '') + weekShort(m);
}
const recentWeeks = n => { const w0 = monday(today()); return Array.from({ length: n }, (_, i) => addDays(w0, -7 * i)); };
const size = b => (b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const fromLocal = v => new Date(v + ':00+09:00').toISOString();   // datetime-local(한국시간) → ISO
const toLocal = iso => kst(iso || new Date()).replace(' ', 'T');
const BUCKET = 'report-files', BOARD_BUCKET = 'board-files';
const bucketOf = f => f.bucket || BUCKET;
const MAXB = MAX_FILE_MB * 1024 * 1024;
const email = id => `${id}@${ID_DOMAIN}`;

/* ---------- 비밀번호 잠금(암호화) ----------
   글 본문과 첨부파일을 비밀번호에서 뽑은 키로 AES-GCM 암호화한다.
   비밀번호는 어디에도 저장하지 않는다(서버엔 암호문만). 잊으면 복구 불가. */
const te = new TextEncoder(), tdc = new TextDecoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encContent(key, salt, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(str));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
async function openContent(pw, bundleStr) {   // 비밀번호로 본문 복호화 → {text, key, salt}
  const b = JSON.parse(bundleStr), salt = unb64(b.salt), key = await deriveKey(pw, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv) }, key, unb64(b.ct));
  return { text: tdc.decode(pt), key, salt };
}
async function encFileBlob(key, file) {   // 파일명·형식을 앞에 붙여 통째로 암호화 → iv(12)+암호문 Blob
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = te.encode(JSON.stringify({ name: file.name, type: file.type || '' }));
  const hl = new Uint8Array(4); new DataView(hl.buffer).setUint32(0, head.length);
  const body = new Uint8Array(await file.arrayBuffer());
  const plain = new Uint8Array(4 + head.length + body.length);
  plain.set(hl, 0); plain.set(head, 4); plain.set(body, 4 + head.length);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return new Blob([out], { type: 'application/octet-stream' });
}
async function decFileBlob(key, blob) {   // → {name, type, blob}
  const buf = new Uint8Array(await blob.arrayBuffer());
  const iv = buf.slice(0, 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf.slice(12)));
  const hl = new DataView(plain.buffer, plain.byteOffset, 4).getUint32(0);
  const head = JSON.parse(tdc.decode(plain.slice(4, 4 + hl)));
  return { name: head.name, type: head.type, blob: new Blob([plain.slice(4 + hl)], { type: head.type || 'application/octet-stream' }) };
}

$('#brand').textContent = SITE_NAME;
$('#fname').textContent = SITE_NAME;
document.title = SITE_NAME;
const initial = n => (String(n || '?').trim().charAt(0) || '?');
function extInfo(name) {
  const e = (String(name).split('.').pop() || '').toLowerCase();
  const map = { pdf: 'pdf', hwp: 'hwp', hwpx: 'hwp', xls: 'xls', xlsx: 'xls', csv: 'xls', doc: 'doc', docx: 'doc', ppt: 'ppt', pptx: 'ppt', jpg: 'img', jpeg: 'img', png: 'img', gif: 'img', webp: 'img', heic: 'img' };
  return { cls: map[e] || '', label: (e || 'FILE').slice(0, 4).toUpperCase() };
}

function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2800); }
const MSG = {
  'Invalid login credentials': '아이디 또는 비밀번호가 맞지 않습니다.',
  'User already registered': '이미 사용 중인 아이디입니다.',
  'already been registered': '이미 사용 중인 아이디입니다.',
  'Password should be': '비밀번호는 6자 이상이어야 합니다.',
  'Signups not allowed': '지금은 회원가입이 막혀 있습니다. 대표에게 문의하세요.',
  'Failed to fetch': '서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.',
  'row-level security': '권한이 없습니다. 승인된 계정인지 확인하세요.',
  'Cannot coerce the result to a single JSON object': '저장 권한이 없습니다. 새로고침 후 다시 시도하세요.',
  'Payload too large': `파일이 ${MAX_FILE_MB}MB를 넘습니다.`,
  'exceeded the maximum allowed size': `파일이 ${MAX_FILE_MB}MB를 넘습니다.`,
};
function errText(e) { const m = e?.message || String(e); for (const k in MSG) if (m.includes(k)) return MSG[k]; return m; }
async function guard(f) { try { return await f(); } catch (e) { console.error(e); toast(errText(e)); } }
function ok({ data, error }) { if (error) throw error; return data; }

/* ---------- 창 ---------- */
function openModal(html) { $('#mb').innerHTML = html; $('#ov').hidden = false; const f = $('#mb').querySelector('input,button'); if (f) f.focus(); }
function closeModal() { $('#ov').hidden = true; $('#mb').innerHTML = ''; }
$('#ov').addEventListener('click', e => { if (e.target.id === 'ov' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#cf').hidden) closeModal(); });
function askConfirm(msg, label = '확인', danger = false) {
  return new Promise(res => {
    $('#cfm').textContent = msg; const b = $('#cfok'); b.textContent = label; b.className = 'btn' + (danger ? ' danger' : ''); $('#cf').hidden = false; b.focus();
    const done = v => { $('#cf').hidden = true; b.onclick = null; $('#cfno').onclick = null; res(v); };
    b.onclick = () => done(true); $('#cfno').onclick = () => done(false);
  });
}
function show(id) { ['boot', 'lock', 'wait', 'staffApp', 'adminApp', 'board'].forEach(k => ($('#' + k).hidden = k !== id)); }
function fatal(t) { $('#boot').innerHTML = '<span>' + esc(t) + '</span>'; show('boot'); }

/* ---------- 설정 확인 ---------- */
if (SUPABASE_URL.includes('YOUR-') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  fatal('config.js에 Supabase 주소와 키를 넣어 주세요.');
  return;
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null, curWeek, people = [], fileMap = {}, repMap = {}, curView = 'reports';
const nm = id => (people.find(p => p.id === id) || {}).name || '(알 수 없음)';

/* ---------- 로그인 · 회원가입 ---------- */
function showLogin() {
  openModal(`<h2>로그인</h2>
  <form id="lf" class="fields" novalidate>
    <div><label for="li">아이디</label><input id="li" autocomplete="username" autocapitalize="off"></div>
    <div><label for="lp">비밀번호</label><input id="lp" type="password" autocomplete="current-password"></div>
    <p class="err" id="le"></p>
    <button class="btn" type="submit">로그인</button>
  </form>
  <div class="foot">계정이 없나요? <button class="link" id="gosu" type="button">회원가입</button></div>`);
  $('#gosu').onclick = showSignup;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const er = t => ($('#le').textContent = t);
    const id = $('#li').value.trim().toLowerCase(), pw = $('#lp').value;
    if (!id || !pw) return er('아이디와 비밀번호를 입력하세요.');
    er('확인 중…');
    const { error } = await sb.auth.signInWithPassword({ email: email(id), password: pw });
    if (error) return er(errText(error));
    closeModal(); await enter(); toast((me?.name || '') + '님 환영합니다');
  };
}
function showSignup() {
  openModal(`<h2>회원가입</h2>
  <form id="sf" class="fields" novalidate>
    <div><label for="sn">이름</label><input id="sn" autocomplete="name"></div>
    <div><label for="si">아이디</label><input id="si" autocomplete="username" autocapitalize="off" placeholder="영문 소문자·숫자 4~20자"></div>
    <div><label for="sp">비밀번호</label><input id="sp" type="password" autocomplete="new-password" placeholder="6자 이상"></div>
    <p class="err" id="se"></p>
    <button class="btn" type="submit">가입하기</button>
  </form>
  <div class="foot">이미 계정이 있나요? <button class="link" id="goli" type="button">로그인</button></div>`);
  $('#goli').onclick = showLogin;
  $('#sf').onsubmit = async e => {
    e.preventDefault(); const er = t => ($('#se').textContent = t);
    const name = $('#sn').value.trim(), id = $('#si').value.trim().toLowerCase(), pw = $('#sp').value;
    if (!name) return er('이름을 입력하세요.');
    if (!/^[a-z0-9_]{4,20}$/.test(id)) return er('아이디는 영문 소문자·숫자·밑줄로 4~20자입니다.');
    if (pw.length < 6) return er('비밀번호는 6자 이상입니다.');
    er('가입 중…');
    const { error } = await sb.functions.invoke('signup', { body: { name, login_id: id, password: pw } });
    if (error) {
      let msg = '가입하지 못했습니다. 잠시 후 다시 시도하세요.';
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) {}
      return er(msg);
    }
    const li = await sb.auth.signInWithPassword({ email: email(id), password: pw });
    if (li.error) return er('가입은 됐지만 로그인하지 못했습니다. 로그인 창에서 다시 시도하세요.');
    closeModal(); await enter(); toast('가입 신청을 보냈습니다');
  };
}
async function logout() { closeModal(); await sb.auth.signOut(); me = null; curView = 'reports'; renderHeader(); show('lock'); toast('로그아웃했습니다'); }

function renderHeader() {
  const active = !!(me && (me.role === 'admin' || me.approved));
  $('#nav').hidden = !active; document.body.classList.toggle('hasnav', active);
  $('#navrep').textContent = me && me.role === 'admin' ? '주간보고' : '내 보고서';
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === curView));
  const canWrite = active && (curView === 'board' || me.role !== 'admin');
  $('#wbtn').hidden = !canWrite;
  $('#wbtn span').textContent = curView === 'board' ? '글쓰기' : '작성하기';
  $('#acctl').textContent = me ? (me.role === 'admin' ? '대표 · ' + me.name : me.name) : '로그인';
  $('#acctav').innerHTML = me ? esc(initial(me.name)) : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
}
$('#acct').onclick = () => {
  if (!me) return showLogin();
  const role = me.role === 'admin' ? '대표' : me.approved ? '직원' : '승인 대기';
  openModal(`<div class="who"><span class="avatar">${esc(initial(me.name))}</span><div><h2>${esc(me.name)}</h2><span class="mu">@${esc(me.login_id)}</span></div></div>
    <div class="fvmeta"><div><span>구분</span><b>${role}</b></div><div><span>가입일</span><b>${esc(dt(me.created_at).slice(0, 10))}</b></div></div>
    <div class="row"><button class="btn ghost" type="button" data-close>닫기</button><button class="btn alt" id="lo" type="button">로그아웃</button></div>`);
  $('#lo').onclick = logout;
};
$('#lockin').onclick = showLogin;
$('#home').onclick = e => { e.preventDefault(); closeFullView(); if (me && (me.role === 'admin' || me.approved)) goView('reports'); else window.scrollTo(0, 0); };
$('#locksu').onclick = showSignup;
$('#reload').onclick = () => location.reload();
$('#waitout').onclick = logout;

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { me = null; renderHeader(); return show('lock'); }
  me = ok(await sb.from('profiles').select('*').eq('id', user.id).single());
  if (me.role !== 'admin' && !me.approved) { curView = 'reports'; renderHeader(); return show('wait'); }
  curView = 'reports'; renderHeader();
  if (me.role === 'admin') { show('adminApp'); return guard(loadAR); }
  show('staffApp'); showStaff('list'); guard(loadMyReports);
}

/* ---------- 탭 ---------- */
const LOAD = { arp: loadAR, ast: loadStaff };
$$('.tabs').forEach(nav => nav.addEventListener('click', e => {
  const b = e.target.closest('button[data-t]'); if (!b) return;
  nav.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); $('#' + x.dataset.t).hidden = x !== b; });
  guard(LOAD[b.dataset.t]);
}));

/* ---------- 직원: 내 보고서 목록 / 작성 ---------- */
let pending = [], curRep = null, curFiles = [], myReps = [], myFiles = [];
$('#flimit').textContent = `여러 개 가능 · 파일당 ${MAX_FILE_MB}MB 이하 · 한글, PDF, 워드, 엑셀, 이미지 등`;
const dateKo = d => `${d.slice(0, 4)}년 ${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일`;
function showStaff(view) { $('#slist').hidden = view !== 'list'; $('#swrite').hidden = view !== 'write'; window.scrollTo(0, 0); }
async function loadMyReports() {
  const [reps, files] = await Promise.all([
    sb.from('reports').select('*').eq('user_id', me.id).order('report_date', { ascending: false }).order('submitted_at', { ascending: false }).then(ok),
    sb.from('report_files').select('*').eq('user_id', me.id).order('uploaded_at').then(ok),
  ]);
  myReps = reps; myFiles = files;
  $('#shello').textContent = `${me.name}님의 주간보고`;
  $('#sstats').innerHTML = `<div class="stat"><b>${reps.length}</b><span>전체 보고서</span></div>`;
  $('#myreps').innerHTML = reps.length ? reps.map(r => {
    const fc = files.filter(f => f.report_id === r.id).length;
    return `<button class="card rcard" type="button" data-open="${r.id}">
      <span class="dtile"><span class="m">${r.report_date.slice(0, 4) !== today().slice(0, 4) ? esc(r.report_date.slice(2, 4)) + '년 ' : ''}${Number(r.report_date.slice(5, 7))}월</span><span class="d">${Number(r.report_date.slice(8))}</span><span class="w">${wday(r.report_date)}요일</span></span>
      <span class="rbody"><span class="rtitle">${esc(r.title || '(제목 없음)')}</span>
        <span class="meta"><span>제출일 ${esc(dateKo(r.report_date))}</span>${fc ? `<span class="pill ad">첨부 ${fc}</span>` : ''}</span>
        <span class="snip">${esc((r.content || '').slice(0, 200)) || '<span class="mu">내용 없음</span>'}</span></span></button>`;
  }).join('') : `<div class="card empty"><span class="state-ic"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></span>
      <h2 class="display">아직 쓴 보고서가 없습니다</h2><p class="mu m0">오른쪽 위 <b>작성하기</b>를 눌러 첫 보고서를 써 보세요.</p></div>`;
}
$('#myreps').addEventListener('click', e => {
  const b = e.target.closest('[data-open]'); if (!b) return;
  const r = myReps.find(x => x.id === Number(b.dataset.open));
  if (r) openFullView(r, myFiles.filter(f => f.report_id === r.id), 'staff');
});
function openWrite(r) {
  curRep = r || null; pending = [];
  $('#wtitle').textContent = r ? '보고서 수정' : '보고서 작성';
  $('#rt').value = r?.title || '';
  $('#rd').value = r?.report_date || today();
  $('#rc').value = r?.content || '';
  $('#save').textContent = r ? '수정해서 제출하기' : '제출하기';
  curFiles = r ? myFiles.filter(f => f.report_id === r.id) : [];
  renderAttach(); showStaff('write'); $('#rt').focus();
}
function renderAttach() {
  $('#myfiles').innerHTML = curFiles.map(f => fileHtml(f, 'staff')).join('');
  $('#pending').innerHTML = pending.map((f, i) => { const x = extInfo(f.name); return `<div class="file pend"><span class="ext ${x.cls}">${x.label}</span><span class="nm">${esc(f.name)}</span>
    <span class="meta">${size(f.size)} · 제출할 때 함께 올라갑니다</span>
    <button class="btn ghost sm" type="button" data-px="${i}">빼기</button></div>`; }).join('');
  $('#nofile').hidden = !!(curFiles.length || pending.length);
}
async function loadMyFiles() {   // 수정 중 기존 파일을 지웠을 때 다시 읽기
  if (!curRep) return renderAttach();
  curFiles = ok(await sb.from('report_files').select('*').eq('report_id', curRep.id).order('uploaded_at'));
  renderAttach();
}
$('#wbtn').onclick = () => { if (!me) return; closeFullView(); if (curView === 'board') openBoardWrite(null); else if (me.role !== 'admin' && me.approved) openWrite(null); };
$('#wback').onclick = async () => {
  if ((pending.length || $('#rc').value.trim() !== (curRep?.content || '').trim() || $('#rt').value.trim() !== (curRep?.title || '').trim())
      && !(await askConfirm('작성 중인 내용이 저장되지 않습니다. 목록으로 갈까요?', '목록으로'))) return;
  showStaff('list');
};
$$('#swrite button[data-rq]').forEach(b => (b.onclick = () => { $('#rd').value = addDays(today(), Number(b.dataset.rq)); }));
$('#ff').onchange = () => {
  const add = [...$('#ff').files], big = add.filter(f => f.size > MAXB);
  if (big.length) toast(`${big.map(f => f.name).join(', ')}: ${MAX_FILE_MB}MB를 넘어서 뺐습니다`);
  pending.push(...add.filter(f => f.size <= MAXB)); $('#ff').value = ''; renderAttach();
};
$('#pending').addEventListener('click', e => { const b = e.target.closest('[data-px]'); if (!b) return; pending.splice(Number(b.dataset.px), 1); renderAttach(); });
async function putFile(bucket, f) {   // 저장소에 올리고 경로를 돌려줌
  const ext = ((f.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'bin';
  const rid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const path = `${me.id}/${rid}.${ext}`;
  ok(await sb.storage.from(bucket).upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false }));
  return path;
}
async function uploadOne(f, reportId) {
  const path = await putFile(BUCKET, f);
  const ins = await sb.from('report_files').insert({ user_id: me.id, report_id: reportId, name: f.name, size: f.size, path });
  if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
}
function pickFiles(input) {   // 파일 선택창 결과에서 크기 넘는 것 걸러내기
  const add = [...input.files], big = add.filter(f => f.size > MAXB);
  if (big.length) toast(`${big.map(f => f.name).join(', ')}: ${MAX_FILE_MB}MB를 넘어서 뺐습니다`);
  input.value = ''; return add.filter(f => f.size <= MAXB);
}
const pendHtml = (f, i, attr) => { const x = extInfo(f.name); return `<div class="file pend"><span class="ext ${x.cls}">${x.label}</span><span class="nm">${esc(f.name)}</span><span class="meta">${size(f.size)}</span><button class="btn ghost sm" type="button" ${attr}="${i}">빼기</button></div>`; };
$('#save').onclick = () => guard(async () => {
  const title = $('#rt').value.trim(), rdate = $('#rd').value, content = $('#rc').value.trim();
  if (!title) { $('#rt').focus(); return toast('제목을 입력하세요'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rdate) || rdate < addDays(today(), -730) || rdate > addDays(today(), 31)) { $('#rd').focus(); return toast('제출 날짜를 확인하세요 (최근 2년 ~ 한 달 뒤까지)'); }
  if (!content && !pending.length && !curFiles.length) { $('#rc').focus(); return toast('이번 주 한 일을 쓰거나 파일을 첨부하세요'); }
  $('#save').disabled = true;
  try {
    $('#fprog').textContent = '보고서 저장 중…';
    const row = { title, report_date: rdate, content };
    curRep = curRep
      ? ok(await sb.from('reports').update(row).eq('id', curRep.id).select().single())
      : ok(await sb.from('reports').insert({ ...row, user_id: me.id }).select().single());
    $('#wtitle').textContent = '보고서 수정'; $('#save').textContent = '수정해서 제출하기';
    const total = pending.length;
    for (let n = 1; pending.length; n++) {
      $('#fprog').textContent = `파일 올리는 중… (${n}/${total}) ${pending[0].name}`;
      try { await uploadOne(pending[0], curRep.id); }
      catch (err) { err.message = `"${pending[0].name}" 파일을 올리지 못했습니다. 보고서는 저장됐으니 다시 [제출하기]를 누르세요. (${errText(err)})`; throw err; }
      pending.shift(); renderAttach();
    }
  } finally { $('#save').disabled = false; $('#fprog').textContent = ''; }
  await loadMyReports();
  const r = myReps.find(x => x.id === curRep.id) || curRep;
  toast('제출했습니다');
  showStaff('list');
  openFullView(r, myFiles.filter(f => f.report_id === r.id), 'staff');
});
async function deleteReport(r) {
  if (!(await askConfirm(`"${r.title || '제목 없음'}" 보고서를 삭제할까요? 첨부 파일도 함께 지워집니다.`, '삭제', true))) return;
  const paths = myFiles.filter(f => f.report_id === r.id).map(f => f.path);
  ok(await sb.from('reports').delete().eq('id', r.id));
  if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  closeFullView(); toast('삭제했습니다'); await loadMyReports();
}

/* ---------- 보고서 전체화면 ---------- */
function openFullView(r, files, mode) {
  const p = mode === 'staff' ? me : person(r.user_id);
  $('#fvb').innerHTML = `
    <div class="fvtop"><button class="btn ghost sm" type="button" id="fvx">← 닫기</button>
      ${mode === 'staff' ? '<span class="row" style="gap:6px"><button class="btn ghost sm" type="button" id="fvdel">삭제</button><button class="btn sm" type="button" id="fved">수정하기</button></span>' : '<span class="mu">보고서</span>'}</div>
    <article class="fvdoc">
      <div class="by"><span class="avatar">${esc(initial(p.name))}</span><div><b>${esc(p.name || '')}</b><div class="mu">@${esc(p.login_id || '')}</div></div></div>
      <h1 class="display">${esc(r.title || '(제목 없음)')}</h1>
      <div class="fvmeta"><div><span>제출일</span><b>${esc(dateKo(r.report_date))} (${wday(r.report_date)})</b></div>
        <div><span>첨부</span><b>${files.length}개</b></div></div>
      <section class="fvsec"><h2>이번 주 한 일</h2><div class="rep">${esc(r.content) || '<span class="mu">—</span>'}</div></section>
      ${files.length ? `<section class="fvsec"><h2>첨부 파일</h2><div class="files">${files.map(f => fileHtml(f, 'view')).join('')}</div></section>` : ''}
    </article>`;
  $('#fv').hidden = false; document.body.classList.add('noscroll'); $('#fv').scrollTop = 0;
  $('#fvx').onclick = closeFullView; $('#fvx').focus();
  if (mode === 'staff') {
    $('#fved').onclick = () => { closeFullView(); openWrite(r); };
    $('#fvdel').onclick = () => guard(() => deleteReport(r));
  }
}
function closeFullView() { $('#fv').hidden = true; document.body.classList.remove('noscroll'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#fv').hidden && $('#ov').hidden && $('#cf').hidden) closeFullView(); });

/* ---------- 파일 ---------- */
function fileHtml(f, mode) {
  fileMap[f.id] = f;
  const extra = mode === 'staff' ? `<button class="btn ghost sm" type="button" data-fx="${f.id}">삭제</button>` : mode === 'bedit' ? `<button class="btn ghost sm" type="button" data-bx="${f.id}">삭제</button>` : '';
  const x = f.enc ? { cls: 'lk', label: '🔒' } : extInfo(f.name);
  return `<div class="file"><span class="ext ${x.cls}">${x.label}</span><span class="nm">${esc(f.name)}</span>
    <span class="meta">${size(f.size)}</span>
    <span class="fbtns"><button class="btn ghost sm" type="button" data-vw="${f.id}">보기</button><button class="btn ghost sm" type="button" data-dl="${f.id}">받기</button>${extra}</span></div>`;
}
async function download(f) {
  if (f.enc) {
    if (!unlock.key || unlock.postId !== curPost?.id) return toast('먼저 비밀번호로 글을 여세요');
    const blob = ok(await sb.storage.from(bucketOf(f)).download(f.path));
    const dec = await decFileBlob(unlock.key, blob);
    const url = URL.createObjectURL(dec.blob), a = document.createElement('a');
    a.href = url; a.download = dec.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000); return;
  }
  const d = ok(await sb.storage.from(bucketOf(f)).createSignedUrl(f.path, 120, { download: f.name }));
  const a = document.createElement('a'); a.href = d.signedUrl; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-vw],button[data-dl],button[data-fx],button[data-fv]'); if (!b) return;
  if (b.dataset.vw) {
    const f = fileMap[b.dataset.vw]; if (!f) return;
    if (f.enc && (!unlock.key || unlock.postId !== curPost?.id)) return toast('먼저 비밀번호로 글을 여세요');
    const w = window.open('', '_blank');
    guard(async () => {
      try {
        let url;
        if (f.enc) {
          const blob = ok(await sb.storage.from(bucketOf(f)).download(f.path));
          const dec = await decFileBlob(unlock.key, blob);
          url = URL.createObjectURL(dec.blob); setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else { url = ok(await sb.storage.from(bucketOf(f)).createSignedUrl(f.path, 600)).signedUrl; }
        if (w) w.location.href = url; else location.href = url;
      } catch (err) { if (w) w.close(); throw err; }
    });
  }
  else if (b.dataset.dl) { const f = fileMap[b.dataset.dl]; if (f) guard(() => download(f)); }
  else if (b.dataset.fx) {
    const f = fileMap[b.dataset.fx];
    if (f) guard(async () => {
      if (!(await askConfirm(`"${f.name}" 파일을 삭제할까요?`, '삭제', true))) return;
      ok(await sb.from('report_files').delete().eq('id', f.id));
      await sb.storage.from(BUCKET).remove([f.path]);
      toast('삭제했습니다'); await loadMyFiles(); myFiles = myFiles.filter(x => x.id !== f.id);
    });
  }
  else if (b.dataset.fv) { const r = repMap[b.dataset.fv]; if (r) openFullView(r, filesOf(r), 'admin'); }
});

/* ---------- 대표: 직원 · 승인 ---------- */
async function loadPeople() { people = ok(await sb.from('profiles').select('*').order('created_at')); }
const staffList = () => people.filter(p => p.role !== 'admin' && p.approved).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
async function loadStaff() {
  await loadPeople();
  const pend = people.filter(p => p.role !== 'admin' && !p.approved).length;
  $('#stc').textContent = `직원 ${staffList().length}명` + (pend ? ` · 승인 대기 ${pend}명` : '');
  $('#pendb').hidden = !pend; $('#pendb').textContent = pend;
  const rows = [...people].sort((a, b) => (a.role === 'admin') - (b.role === 'admin') || a.approved - b.approved || a.name.localeCompare(b.name, 'ko'));
  $('#stlist').innerHTML = `<table><thead><tr><th>이름</th><th>아이디</th><th>가입일</th><th>상태</th><th></th></tr></thead><tbody>${rows.map(p => `<tr>
    <td><span class="who"><span class="avatar">${esc(initial(p.name))}</span><b>${esc(p.name)}</b></span></td><td class="mono">${esc(p.login_id)}</td><td class="mono">${esc(dt(p.created_at).slice(0, 10))}</td>
    <td>${p.role === 'admin' ? '<span class="pill ad">대표</span>' : p.approved ? '<span class="pill ok">승인</span>' : '<span class="pill no">대기</span>'}</td>
    <td>${p.role === 'admin' ? '' : p.approved ? `<button class="btn ghost sm" type="button" data-ap="${p.id}" data-v="0">승인 취소</button>` : `<button class="btn sm" type="button" data-ap="${p.id}" data-v="1">승인</button>`}</td>
  </tr>`).join('')}</tbody></table>`;
  $('#stlist').querySelectorAll('button[data-ap]').forEach(b => (b.onclick = () => guard(async () => {
    const p = people.find(x => x.id === b.dataset.ap), v = b.dataset.v === '1';
    if (!v && !(await askConfirm(`${p.name} 님의 승인을 취소할까요? 기록은 남고, 이 직원은 더 이상 사이트를 쓸 수 없습니다.`, '승인 취소', true))) return;
    ok(await sb.from('profiles').update({ approved: v }).eq('id', p.id));
    toast(v ? '승인했습니다' : '승인을 취소했습니다'); await loadStaff();
  })));
}

/* ---------- 대표: 주간보고 (제출 날짜별 전체 목록) — 직원이 지정한 날짜(report_date)를 제출일로 표시 ---------- */
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const wday = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
// "9" "900" "0930" "9:30" "18:05" → "HH:MM" / 빈칸 → null / 잘못된 값 → undefined
function parseTime(v) {
  v = String(v || '').trim().replace(/[^0-9:]/g, '');
  if (!v) return null;
  let h, m;
  if (v.includes(':')) [h, m] = v.split(':').map(x => Number(x || 0));
  else if (v.length <= 2) { h = Number(v); m = 0; }
  else { h = Number(v.slice(0, -2)); m = Number(v.slice(-2)); }
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return pad(h) + ':' + pad(m);
}
const allStaff = () => people.filter(p => p.role !== 'admin').sort((a, b) => a.name.localeCompare(b.name, 'ko'));
const person = id => people.find(x => x.id === id) || {};
let allReps = [], allFiles = [];
function dayTitle(d) {
  const t = today(), label = `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일 (${wday(d)})`;
  const tag = d === t ? '오늘' : d === addDays(t, -1) ? '어제' : '';
  return `<span>${(d.slice(0, 4) !== t.slice(0, 4) ? d.slice(0, 4) + '년 ' : '') + label}</span>` + (tag ? `<span class="pill ac">${tag}</span>` : '');
}
async function loadAR() {
  await loadPeople();
  const [reps, files] = await Promise.all([
    sb.from('reports').select('*').order('report_date', { ascending: false }).order('submitted_at', { ascending: false }).limit(1000).then(ok),
    sb.from('report_files').select('*').order('uploaded_at').limit(3000).then(ok),
  ]);
  allReps = reps; allFiles = files;
  const w0 = monday(today()), w1 = addDays(w0, 6), staffN = staffList().length, pend = people.filter(p => p.role !== 'admin' && !p.approved).length;
  const thisWeek = reps.filter(r => r.report_date >= w0 && r.report_date <= w1);
  $('#atiles').innerHTML = `<div class="tile"><span>이번 주 보고서</span><b>${thisWeek.length}</b></div>
    <div class="tile"><span>이번 주 제출 직원</span><b>${new Set(thisWeek.map(r => r.user_id)).size}<small class="mu"> / ${staffN}명</small></b></div>
    <div class="tile"><span>전체 보고서</span><b>${reps.length}</b></div>
    <div class="tile${pend ? ' alert' : ''}"><span>승인 대기</span><b>${pend}</b></div>`;
  $('#pendb').hidden = !pend; $('#pendb').textContent = pend;
  const sf = $('#arf').value;
  $('#arf').innerHTML = '<option value="">전체 직원</option>' + allStaff().map(s => `<option value="${s.id}"${s.id === sf ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  renderAR();
}
const filesOf = r => allFiles.filter(f => f.report_id === r.id);
function renderAR() {
  const sf = $('#arf').value;
  const reps = allReps.filter(r => !sf || r.user_id === sf);
  $('#arsum').textContent = `· 보고서 ${reps.length}건 · 첨부 ${reps.reduce((a, r) => a + filesOf(r).length, 0)}개`;
  const days = {};
  reps.forEach(r => { (days[r.report_date] ||= []).push(r); });   // 직원이 지정한 제출 날짜별로 묶음
  const order = Object.keys(days).sort().reverse();
  repMap = {};
  if (!order.length) { $('#arep').innerHTML = '<div class="card empty"><h2 class="display">아직 올라온 보고서가 없습니다</h2><p class="mu m0">직원이 보고서를 제출하면 여기에 제출 날짜별로 모입니다.</p></div>'; return; }
  $('#arep').innerHTML = order.map(d => {
    const list = days[d].sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
    return `<section class="day"><h3 class="dayh">${dayTitle(d)}<span class="mu">${list.length}건</span></h3>
      ${list.map(r => {
        repMap[r.id] = r; const fs = filesOf(r);
        return `<article class="card entry">
          <div class="hd"><span class="who"><span class="avatar">${esc(initial(person(r.user_id).name))}</span><span><b>${esc(person(r.user_id).name || '(알 수 없음)')}</b>${fs.length ? `<span class="meta"><span class="pill ad">첨부 ${fs.length}</span></span>` : ''}</span></span>
            <button class="btn ghost sm" type="button" data-fv="${r.id}">전체화면</button></div>
          <span class="rtitle">${esc(r.title || '(제목 없음)')}</span>
          <div class="repbox"><div class="mu">이번 주 한 일</div><div class="rep">${esc(r.content) || '—'}</div></div>
          ${fs.length ? `<div class="files">${fs.map(f => fileHtml(f, 'admin')).join('')}</div>` : ''}
        </article>`;
      }).join('')}</section>`;
  }).join('');
}
$('#arf').onchange = () => renderAR();

/* 엑셀 다운로드 */
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    sc.onload = res; sc.onerror = () => rej(new Error('엑셀 기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요.'));
    document.head.appendChild(sc);
  });
}
$('#arx').onclick = () => guard(async () => {
  $('#arx').disabled = true;
  try {
    await loadXLSX();
    const sf = $('#arf').value;
    const reps = allReps.filter(r => !sf || r.user_id === sf);
    const s1 = [['제출일', '이름', '아이디', '제목', '이번 주 한 일', '첨부 파일']]
      .concat(reps.map(r => { const p = person(r.user_id); return [r.report_date, p.name || '', p.login_id || '', r.title, r.content, filesOf(r).map(f => f.name).join(', ')]; }));
    const s2 = [['제출일', '이름', '아이디', '보고서 제목', '파일 이름', '크기(KB)']]
      .concat(reps.flatMap(r => filesOf(r).map(f => { const p = person(r.user_id); return [r.report_date, p.name || '', p.login_id || '', r.title, f.name, Math.round(f.size / 1024)]; })));
    const wb = XLSX.utils.book_new();
    const w1 = XLSX.utils.aoa_to_sheet(s1); w1['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 }, { wch: 70 }, { wch: 30 }];
    const w2 = XLSX.utils.aoa_to_sheet(s2); w2['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 }, { wch: 40 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, w1, '주간보고');
    XLSX.utils.book_append_sheet(wb, w2, '첨부파일');
    const fname = `주간보고_${today()}${sf ? '_' + (person(sf).name || '') : ''}.xlsx`;
    const blob = new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('엑셀 파일을 저장했습니다');
  } finally { $('#arx').disabled = false; }
});
/* ---------- 게시판 ---------- */
/* ---------- 화면 전환 (보고서 / 게시판) ---------- */
function goView(v) {
  curView = v; closeFullView();
  if (v === 'board') { show('board'); showBoard('list'); guard(loadPosts); }
  else if (me.role === 'admin') show('adminApp');
  else { show('staffApp'); showStaff('list'); }
  renderHeader(); window.scrollTo(0, 0);
}
$$('#nav button').forEach(b => (b.onclick = () => { if (me) goView(b.dataset.v); }));
// 휴대폰 폭에서는 메뉴를 상단 바 밖(화면 아래 탭 바)으로 옮긴다 — 상단 바의 유리 효과가 fixed 기준을 가로채기 때문
const navMq = window.matchMedia('(max-width: 640px)');
function placeNav() { const nav = $('#nav'); if (navMq.matches) { if (nav.parentElement !== document.body) document.body.appendChild(nav); } else if (nav.parentElement === document.body) $('.top .in').insertBefore(nav, $('.topr')); }
placeNav(); (navMq.addEventListener ? navMq.addEventListener('change', placeNav) : navMq.addListener(placeNav));

/* ---------- 게시판 ---------- */
let dir = [], posts = [], curPost = null, comments = [], postFiles = [], bpending = [], bfiles = [], cpending = [];
let unlock = { postId: null, key: null, salt: null, plain: '' };   // 이 세션에서 열어둔 잠긴 글
const tagBoard = f => Object.assign(f, { bucket: BOARD_BUCKET });
const isAdmin = () => !!(me && me.role === 'admin');
const dirName = id => (dir.find(p => p.id === id) || {}).name || (me && me.id === id ? me.name : '(알 수 없음)');
const dirRole = id => (dir.find(p => p.id === id) || {}).role;
function ago(iso) {
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  const k = kst(iso), t = today();
  if (k.slice(0, 10) === addDays(t, -1)) return '어제 ' + k.slice(11);
  return (k.slice(0, 4) === t.slice(0, 4) ? md(k.slice(0, 10)) : k.slice(0, 10)) + ' ' + k.slice(11);
}
const whoHtml = (id, sub) => `<span class="avatar">${esc(initial(dirName(id)))}</span><span><b>${esc(dirName(id))}</b>${dirRole(id) === 'admin' ? ' <span class="pill ad">대표</span>' : ''}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>`;
function showBoard(v) { ['list', 'view', 'write'].forEach(k => ($('#b' + k).hidden = k !== v)); window.scrollTo(0, 0); }
async function loadDir() { dir = ok(await sb.rpc('staff_directory')) || []; }
async function loadPosts() {
  if (!dir.length) await loadDir();
  posts = ok(await sb.from('posts').select('*, comments(count), board_files(count)').order('is_notice', { ascending: false }).order('created_at', { ascending: false }).limit(200));
  $('#bcount').textContent = posts.length ? `글 ${posts.length}개` : '';
  const chat = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>';
  $('#plist').innerHTML = posts.length ? posts.map(p => {
    const n = p.comments?.[0]?.count ?? 0, fn = p.board_files?.[0]?.count ?? 0;
    return `<button class="card pcard${p.is_notice ? ' notice' : ''}" type="button" data-post="${p.id}">
      <span class="pmain"><span class="ptitle">${p.is_notice ? '<span class="pill ac">공지</span>' : ''}${p.locked ? '<span class="pill lk">🔒 잠금</span>' : ''}<span>${esc(p.title)}</span></span>
        <span class="psnip">${p.locked ? '<span class="mu">비밀번호로 잠긴 글입니다</span>' : esc((p.content || '').replace(/\s+/g, ' ').slice(0, 120)) || '&nbsp;'}</span>
        <span class="meta"><span class="who"><span class="avatar sm">${esc(initial(dirName(p.user_id)))}</span>${esc(dirName(p.user_id))}</span><span>${esc(ago(p.created_at))}</span>${fn ? `<span class="clip"><svg viewBox="0 0 24 24"><path d="M21 12.5 12.6 21a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2L10 18.4a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"/></svg>${fn}</span>` : ''}</span></span>
      <span class="cbubble${n ? ' has' : ''}">${chat}${n}</span></button>`;
  }).join('') : `<div class="card empty"><span class="state-ic"><svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg></span><h2 class="display">아직 글이 없습니다</h2><p class="mu m0">오른쪽 위 <b>글쓰기</b>로 첫 글을 남겨 보세요.</p></div>`;
}
$('#plist').addEventListener('click', e => { const b = e.target.closest('[data-post]'); if (b) guard(() => openPost(Number(b.dataset.post))); });
async function openPost(id) {
  const p = ok(await sb.from('posts').select('*').eq('id', id).maybeSingle());
  if (!p) { toast('삭제된 글입니다'); return loadPosts(); }
  curPost = p;
  const opened = !p.locked || unlock.postId === p.id;
  const mine = me.id === p.user_id;
  $('#bvt').innerHTML = (p.is_notice ? '<span class="pill ac" style="vertical-align:middle;margin-right:8px">공지</span>' : '')
    + (p.locked ? '<span class="pill lk" style="vertical-align:middle;margin-right:8px">🔒 잠금</span>' : '') + esc(p.title);
  $('#bvwho').innerHTML = whoHtml(p.user_id, dt(p.created_at) + ' (' + ago(p.created_at) + ')');
  $('#bvact').innerHTML = (isAdmin() ? '<button class="btn ghost sm" type="button" id="pdate">날짜 수정</button>' : '')
    + (mine && opened ? '<button class="btn ghost sm" type="button" id="pedit">수정</button>' : '')
    + (mine || isAdmin() ? '<button class="btn ghost sm" type="button" id="pdel">삭제</button>' : '');
  if (isAdmin()) $('#pdate').onclick = () => editStamp('글 쓴 날짜 수정', p.title, p.created_at, async iso => { ok(await sb.from('posts').update({ created_at: iso }).eq('id', p.id)); await openPost(p.id); });
  if (mine && opened) $('#pedit').onclick = () => openBoardWrite(p);
  if (mine || isAdmin()) $('#pdel').onclick = () => guard(async () => {
    if (!(await askConfirm('이 글을 삭제할까요? 댓글과 첨부 파일도 함께 지워집니다.', '삭제', true))) return;
    const cids = ok(await sb.from('comments').select('id').eq('post_id', p.id)) || [];
    const pf = ok(await sb.from('board_files').select('path').eq('post_id', p.id)) || [];
    const cf = cids.length ? (ok(await sb.from('board_files').select('path').in('comment_id', cids.map(c => c.id))) || []) : [];
    const paths = [...pf, ...cf].map(f => f.path);
    ok(await sb.from('posts').delete().eq('id', p.id));
    if (paths.length) await sb.storage.from(BOARD_BUCKET).remove(paths);
    toast('삭제했습니다'); showBoard('list'); await loadPosts();
  });
  showBoard('view');
  if (opened) await revealPost(p); else renderLocked(p);
}
async function revealPost(p) {
  $('#bvc').textContent = p.locked ? unlock.plain : (p.content || '');
  postFiles = (ok(await sb.from('board_files').select('*').eq('post_id', p.id).order('created_at')) || []).map(tagBoard);
  $('#bvfiles').innerHTML = postFiles.length ? postFiles.map(f => fileHtml(f, 'view')).join('') : '';
  $('#bvfiles').hidden = !postFiles.length;
  $('#bcmt').hidden = false;
  $('#cin').value = ''; cpending = []; renderCPending();
  await loadComments();
}
function renderLocked(p) {
  postFiles = []; $('#bvfiles').hidden = true; $('#bvfiles').innerHTML = ''; $('#bcmt').hidden = true;
  $('#bvc').innerHTML = `<div class="lockbox"><div class="lockic">🔒</div>
    <b>비밀번호로 잠긴 글입니다</b>
    <p class="mu m0">이 글과 첨부파일은 비밀번호를 아는 사람만 볼 수 있습니다.</p>
    <form id="uf" class="urow" novalidate><input id="upw" type="password" placeholder="비밀번호" autocomplete="off"><button class="btn" type="submit">열기</button></form>
    <p class="err m0" id="ue"></p></div>`;
  $('#uf').onsubmit = e => { e.preventDefault(); guard(async () => {
    const pw = $('#upw').value; if (!pw) return;
    $('#ue').textContent = '여는 중…';
    let r; try { r = await openContent(pw, p.enc); }
    catch (_) { $('#ue').textContent = '비밀번호가 맞지 않습니다.'; $('#upw').select(); return; }
    unlock = { postId: p.id, key: r.key, salt: r.salt, plain: r.text };
    await openPost(p.id);
  }); };
  $('#upw').focus();
}
async function loadComments() {
  comments = ok(await sb.from('comments').select('*').eq('post_id', curPost.id).order('created_at'));
  const cf = comments.length ? (ok(await sb.from('board_files').select('*').in('comment_id', comments.map(c => c.id)).order('created_at')) || []).map(tagBoard) : [];
  const cfiles = id => cf.filter(f => f.comment_id === id);
  $('#bcc').textContent = comments.length || '';
  $('#clist').innerHTML = comments.length ? comments.map(c => `<div class="citem"><span class="avatar sm">${esc(initial(dirName(c.user_id)))}</span>
    <div class="cbody"><div class="chead"><b>${esc(dirName(c.user_id))}</b>${dirRole(c.user_id) === 'admin' ? '<span class="pill ad">대표</span>' : ''}<span>${esc(ago(c.created_at))}</span>${isAdmin() ? `<button class="link" type="button" data-cdate="${c.id}">날짜 수정</button>` : ''}${me.id === c.user_id || isAdmin() ? `<button class="link" type="button" data-cdel="${c.id}">삭제</button>` : ''}</div>
    <div class="ctext">${esc(c.content)}</div>${cfiles(c.id).length ? `<div class="files compact">${cfiles(c.id).map(f => fileHtml(f, 'view')).join('')}</div>` : ''}</div></div>`).join('') : '<div class="cempty">첫 댓글을 남겨 보세요.</div>';
}
$('#clist').addEventListener('click', e => {
  const d = e.target.closest('[data-cdate]');
  if (d) { const c = comments.find(x => x.id === Number(d.dataset.cdate)); if (c) editStamp('댓글 쓴 날짜 수정', c.content.slice(0, 40), c.created_at, async iso => { ok(await sb.from('comments').update({ created_at: iso }).eq('id', c.id)); await loadComments(); }); return; }
  const b = e.target.closest('[data-cdel]'); if (!b) return; guard(async () => {
  if (!(await askConfirm('이 댓글을 삭제할까요?', '삭제', true))) return;
  const cid = Number(b.dataset.cdel), fs = ok(await sb.from('board_files').select('path').eq('comment_id', cid)) || [];
  ok(await sb.from('comments').delete().eq('id', cid));
  if (fs.length) await sb.storage.from(BOARD_BUCKET).remove(fs.map(f => f.path));
  toast('삭제했습니다'); await loadComments();
}); });
function renderCPending() { $('#cpend').innerHTML = cpending.map((f, i) => pendHtml(f, i, 'data-cpx')).join(''); $('#cpend').hidden = !cpending.length; }
$('#cff').onchange = () => { cpending.push(...pickFiles($('#cff'))); renderCPending(); };
$('#cpend').addEventListener('click', e => { const b = e.target.closest('[data-cpx]'); if (!b) return; cpending.splice(Number(b.dataset.cpx), 1); renderCPending(); });
async function sendComment() {
  const t = $('#cin').value.trim(); if (!t && !cpending.length) return $('#cin').focus();
  $('#csend').disabled = true;
  try {
    const c = ok(await sb.from('comments').insert({ post_id: curPost.id, user_id: me.id, content: t || '(파일 첨부)' }).select().single());
    while (cpending.length) {
      const f = cpending[0]; $('#csend').textContent = `올리는 중… ${f.name}`;
      const path = await putFile(BOARD_BUCKET, f);
      const ins = await sb.from('board_files').insert({ user_id: me.id, comment_id: c.id, name: f.name, size: f.size, path });
      if (ins.error) { await sb.storage.from(BOARD_BUCKET).remove([path]); throw ins.error; }
      cpending.shift(); renderCPending();
    }
    $('#cin').value = ''; await loadComments(); toast('댓글을 남겼습니다');
  } finally { $('#csend').disabled = false; $('#csend').textContent = '등록'; }
}
$('#csend').onclick = () => guard(sendComment);
$('#cin').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); guard(sendComment); } });
$('#bback').onclick = () => { showBoard('list'); guard(loadPosts); };
/* 날짜·시각 수정 창 (대표 전용) */
function editStamp(title, what, cur, onSave) {
  openModal(`<h2>${esc(title)}</h2><p class="mu m0">${esc(what || '')}</p>
    <form id="ef" class="fields" novalidate>
      <div class="g2"><div><label for="evd">날짜</label><input type="date" id="evd" value="${toLocal(cur).slice(0, 10)}"></div>
        <div><label for="evt">시각</label><input id="evt" class="mono" inputmode="numeric" value="${toLocal(cur).slice(11, 16)}" placeholder="09:00"></div></div>
      <div class="row"><button class="btn ghost sm" type="button" data-q="0">오늘</button><button class="btn ghost sm" type="button" data-q="-1">어제</button><button class="btn ghost sm" type="button" data-q="-7">1주 전</button><span class="mu">시각은 숫자만 쳐도 됩니다. 예) 1730 → 17:30</span></div>
      <p class="err" id="ee"></p>
      <div class="row"><button class="btn ghost" type="button" data-close>취소</button><button class="btn" type="submit">저장</button></div>
    </form>`);
  $('#ef').querySelectorAll('button[data-q]').forEach(q => (q.onclick = () => { $('#evd').value = addDays(today(), Number(q.dataset.q)); }));
  $('#ef').onsubmit = e => { e.preventDefault(); guard(async () => {
    const d = $('#evd').value, t = parseTime($('#evt').value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ($('#ee').textContent = '날짜를 입력하세요.');
    if (t === undefined) return ($('#ee').textContent = '시각을 확인하세요. 예) 900, 17:30');
    await onSave(fromLocal(d + 'T' + (t || '09:00')));
    closeModal(); toast('날짜를 바꿨습니다');
  }); };
}
let editPost = null;
function renderBAttach() {
  $('#bmyfiles').innerHTML = bfiles.map(f => fileHtml(f, 'bedit')).join('');
  $('#bpending').innerHTML = bpending.map((f, i) => pendHtml(f, i, 'data-bpx')).join('');
  $('#bnofile').hidden = !!(bfiles.length || bpending.length);
}
$('#bff').onchange = () => { bpending.push(...pickFiles($('#bff'))); renderBAttach(); };
$('#bpending').addEventListener('click', e => { const b = e.target.closest('[data-bpx]'); if (!b) return; bpending.splice(Number(b.dataset.bpx), 1); renderBAttach(); });
$('#bmyfiles').addEventListener('click', e => { const b = e.target.closest('[data-bx]'); if (!b) return; const f = bfiles.find(x => x.id === b.dataset.bx); if (!f) return; guard(async () => {
  if (!(await askConfirm(`"${f.name}" 파일을 삭제할까요?`, '삭제', true))) return;
  ok(await sb.from('board_files').delete().eq('id', f.id)); await sb.storage.from(BOARD_BUCKET).remove([f.path]);
  bfiles = bfiles.filter(x => x.id !== f.id); renderBAttach(); toast('삭제했습니다');
}); });
function updateLockUI() {
  const on = $('#plock').checked, reuse = !!(editPost && editPost.locked);
  $('#pwwrap').hidden = !on || reuse;
  $('#pwnote').hidden = !on;
  $('#pwnote').textContent = reuse
    ? '이 글은 잠겨 있습니다. 기존 비밀번호가 그대로 유지됩니다.'
    : '이 비밀번호를 아는 사람만 글과 첨부파일을 볼 수 있습니다. 비밀번호를 잊으면 되돌릴 수 없습니다.';
}
$('#plock').onchange = updateLockUI;
function openBoardWrite(p) {
  editPost = p || null; bpending = []; bfiles = p ? postFiles.slice() : []; renderBAttach();
  $('#bwt').textContent = p ? '글 수정' : '글쓰기';
  $('#pt').value = p?.title || '';
  $('#pc').value = p ? (p.locked ? unlock.plain : (p.content || '')) : '';
  $('#pnwrap').hidden = !isAdmin(); $('#pn').checked = !!p?.is_notice;
  const editingLocked = !!(p && p.locked), canLock = !p;   // 잠금 선택은 새 글만, 수정 중엔 상태 고정
  $('#plockrow').hidden = !(canLock || editingLocked);
  $('#plock').checked = editingLocked; $('#plock').disabled = !canLock;
  $('#ppw').value = ''; $('#ppw2').value = ''; updateLockUI();
  $('#psave').textContent = p ? '수정하기' : '등록하기';
  showBoard('write'); $('#pt').focus();
}
$('#bwback').onclick = async () => {
  if ((bpending.length || $('#pt').value.trim() !== (editPost?.title || '') || $('#pc').value.trim() !== (editPost?.content || '')) && !(await askConfirm('작성 중인 내용이 저장되지 않습니다. 목록으로 갈까요?', '목록으로'))) return;
  if (editPost) guard(() => openPost(editPost.id)); else { showBoard('list'); guard(loadPosts); }
};
$('#psave').onclick = () => guard(async () => {
  const title = $('#pt').value.trim(), content = $('#pc').value.trim();
  if (!title) { $('#pt').focus(); return toast('제목을 입력하세요'); }
  if (!content && !bpending.length && !bfiles.length) { $('#pc').focus(); return toast('내용을 입력하세요'); }

  const locked = $('#plock').checked;
  let key = null, salt = null, enc = null;
  if (locked) {
    if (editPost && editPost.locked) {   // 기존 잠긴 글 수정: 비밀번호 재사용
      if (!unlock.key || unlock.postId !== editPost.id) return toast('먼저 비밀번호로 글을 열어야 수정할 수 있습니다');
      key = unlock.key; salt = unlock.salt;
    } else {   // 새 잠금: 비밀번호 두 번 확인
      const pw = $('#ppw').value, pw2 = $('#ppw2').value;
      if (pw.length < 4) { $('#ppw').focus(); return toast('비밀번호는 4자 이상으로 정하세요'); }
      if (pw !== pw2) { $('#ppw2').focus(); return toast('비밀번호가 서로 다릅니다'); }
      salt = crypto.getRandomValues(new Uint8Array(16)); key = await deriveKey(pw, salt);
    }
    enc = await encContent(key, salt, content);
  }

  $('#psave').disabled = true;
  try {
    const row = locked
      ? { title, content: '', locked: true, enc, ...(isAdmin() ? { is_notice: $('#pn').checked } : {}) }
      : { title, content, ...(isAdmin() ? { is_notice: $('#pn').checked } : {}) };
    $('#psave').textContent = '저장 중…';
    const saved = editPost
      ? ok(await sb.from('posts').update(row).eq('id', editPost.id).select().single())
      : ok(await sb.from('posts').insert({ ...row, user_id: me.id }).select().single());
    editPost = saved;
    if (locked) unlock = { postId: saved.id, key, salt, plain: content };   // 방금 만든/고친 글은 열린 상태로
    while (bpending.length) {
      const f = bpending[0]; $('#psave').textContent = `파일 올리는 중… ${f.name}`;
      let path, ins;
      if (locked) {
        const blob = await encFileBlob(key, f);
        path = await putFile(BOARD_BUCKET, new File([blob], 'enc.bin', { type: 'application/octet-stream' }));
        ins = await sb.from('board_files').insert({ user_id: me.id, post_id: saved.id, name: '🔒 잠긴 첨부파일', size: f.size, path, enc: true });
      } else {
        path = await putFile(BOARD_BUCKET, f);
        ins = await sb.from('board_files').insert({ user_id: me.id, post_id: saved.id, name: f.name, size: f.size, path });
      }
      if (ins.error) { await sb.storage.from(BOARD_BUCKET).remove([path]); throw ins.error; }
      bpending.shift(); renderBAttach();
    }
    toast(saved.updated_at === saved.created_at ? '글을 올렸습니다' : '저장했습니다'); editPost = null; await openPost(saved.id);
  } finally { $('#psave').disabled = false; $('#psave').textContent = editPost ? '수정하기' : '등록하기'; }
});

/* ---------- 시작 ---------- */
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me) { me = null; renderHeader(); show('lock'); } });
guard(enter).then(() => { if ($('#boot').hidden === false && !me) show('lock'); });
})();
