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
const BUCKET = 'report-files';
const MAXB = MAX_FILE_MB * 1024 * 1024;
const email = id => `${id}@${ID_DOMAIN}`;

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
function show(id) { ['boot', 'lock', 'wait', 'staffApp', 'adminApp'].forEach(k => ($('#' + k).hidden = k !== id)); }
function fatal(t) { $('#boot').innerHTML = '<span>' + esc(t) + '</span>'; show('boot'); }

/* ---------- 설정 확인 ---------- */
if (SUPABASE_URL.includes('YOUR-') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  fatal('config.js에 Supabase 주소와 키를 넣어 주세요.');
  return;
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null, curWeek, people = [], fileMap = {}, repMap = {};
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
async function logout() { closeModal(); await sb.auth.signOut(); me = null; renderHeader(); show('lock'); toast('로그아웃했습니다'); }

function renderHeader() {
  $('#wbtn').hidden = !(me && me.role !== 'admin' && me.approved);
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
$('#home').onclick = e => { e.preventDefault(); closeFullView(); if (me && me.role !== 'admin' && me.approved && !$('#swrite').hidden) $('#wback').click(); else window.scrollTo(0, 0); };
$('#locksu').onclick = showSignup;
$('#reload').onclick = () => location.reload();
$('#waitout').onclick = logout;

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { me = null; renderHeader(); return show('lock'); }
  me = ok(await sb.from('profiles').select('*').eq('id', user.id).single());
  renderHeader();
  if (me.role === 'admin') { show('adminApp'); return guard(loadAR); }
  if (!me.approved) return show('wait');
  show('staffApp'); showStaff('list'); renderHeader(); guard(loadMyReports);
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
      <h2 class="serif">아직 쓴 보고서가 없습니다</h2><p class="mu m0">오른쪽 위 <b>작성하기</b>를 눌러 첫 보고서를 써 보세요.</p></div>`;
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
$('#wbtn').onclick = () => { if (me && me.role !== 'admin' && me.approved) { closeFullView(); openWrite(null); } };
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
async function uploadOne(f, reportId) {
  const ext = ((f.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'bin';
  const rid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  const path = `${me.id}/${rid}.${ext}`;
  ok(await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false }));
  const ins = await sb.from('report_files').insert({ user_id: me.id, report_id: reportId, name: f.name, size: f.size, path });
  if (ins.error) { await sb.storage.from(BUCKET).remove([path]); throw ins.error; }
}
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
      <h1 class="serif">${esc(r.title || '(제목 없음)')}</h1>
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
  const extra = mode === 'staff' ? `<button class="btn ghost sm" type="button" data-fx="${f.id}">삭제</button>` : '';
  const x = extInfo(f.name);
  return `<div class="file"><span class="ext ${x.cls}">${x.label}</span><span class="nm">${esc(f.name)}</span>
    <span class="meta">${size(f.size)}</span>
    <span class="fbtns"><button class="btn ghost sm" type="button" data-vw="${f.id}">보기</button><button class="btn ghost sm" type="button" data-dl="${f.id}">받기</button>${extra}</span></div>`;
}
async function download(f) {
  const d = ok(await sb.storage.from(BUCKET).createSignedUrl(f.path, 120, { download: f.name }));
  const a = document.createElement('a'); a.href = d.signedUrl; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button[data-vw],button[data-dl],button[data-fx],button[data-fv]'); if (!b) return;
  if (b.dataset.vw) {
    const f = fileMap[b.dataset.vw]; if (!f) return;
    const w = window.open('', '_blank');
    guard(async () => {
      try { const d = ok(await sb.storage.from(BUCKET).createSignedUrl(f.path, 600)); if (w) w.location.href = d.signedUrl; else location.href = d.signedUrl; }
      catch (err) { if (w) w.close(); throw err; }
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
  return `<span>${(d.slice(0, 4) !== t.slice(0, 4) ? d.slice(0, 4) + '년 ' : '') + label}</span>` + (tag ? `<span class="pill gold">${tag}</span>` : '');
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
  if (!order.length) { $('#arep').innerHTML = '<div class="card empty"><h2 class="serif">아직 올라온 보고서가 없습니다</h2><p class="mu m0">직원이 보고서를 제출하면 여기에 제출 날짜별로 모입니다.</p></div>'; return; }
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
/* ---------- 시작 ---------- */
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT' && me) { me = null; renderHeader(); show('lock'); } });
guard(enter).then(() => { if ($('#boot').hidden === false && !me) show('lock'); });
})();
