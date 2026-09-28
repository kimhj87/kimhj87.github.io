// Supabase 프로젝트 staff-portal (서울) — 연결 완료
// anon 키는 공개돼도 되는 키입니다. service_role / secret 키는 절대 넣지 마세요.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://rtydbopidlnhlbrcdudl.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ0eWRib3BpZGxuaGxicmNkdWRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA1OTQyNDUsImV4cCI6MjEwNjE3MDI0NX0.f2idjTYtJWzQbSJcgvoamqH9J6PxfSqJbaYpGFUig5M',
  // 아이디 로그인을 위해 내부적으로 붙이는 가짜 이메일 도메인 (바꾸지 마세요)
  ID_DOMAIN: 'staff.portal.app',
  // 파일 1개 최대 크기(MB). 50보다 크게 하지 마세요.
  MAX_FILE_MB: 50,
  // 사이트 상단에 보일 이름
  SITE_NAME: '주간보고',
};
