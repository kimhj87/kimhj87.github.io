import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// 직원 회원가입: 이름·아이디·비밀번호로 계정을 만들고 이메일 확인 없이 바로 쓸 수 있게 한다.
// 새 계정은 profiles.approved=false 로 시작하며, 대표가 승인해야 기능을 쓸 수 있다.
const ID_DOMAIN = "staff.portal.app";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST만 허용됩니다" }, 405);
  let body: { name?: string; login_id?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: "잘못된 요청입니다" }, 400); }
  const name = String(body.name ?? "").trim().slice(0, 40);
  const id = String(body.login_id ?? "").trim().toLowerCase();
  const pw = String(body.password ?? "");
  if (!name) return json({ error: "이름을 입력하세요." }, 400);
  if (!/^[a-z0-9_]{4,20}$/.test(id)) return json({ error: "아이디는 영문 소문자·숫자·밑줄로 4~20자입니다." }, 400);
  if (pw.length < 6 || pw.length > 72) return json({ error: "비밀번호는 6~72자입니다." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.admin.createUser({
    email: `${id}@${ID_DOMAIN}`,
    password: pw,
    email_confirm: true,
    user_metadata: { name, login_id: id },
  });
  if (error) {
    const m = error.message || "";
    if (/already|registered|exists/i.test(m)) return json({ error: "이미 사용 중인 아이디입니다." }, 409);
    if (/password/i.test(m)) return json({ error: "비밀번호가 너무 단순합니다. 다른 비밀번호를 쓰세요." }, 400);
    console.error(m);
    return json({ error: "가입하지 못했습니다. 잠시 후 다시 시도하세요." }, 500);
  }
  return json({ ok: true });
});
