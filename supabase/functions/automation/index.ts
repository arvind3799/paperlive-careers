// PaperLive Careers automation. Runs every 10 minutes (pg_cron) and on demand from the admin portal.
// Steps: alerts -> leads, sheet sync, HR outreach, HR replies -> JDs -> jobs, candidate alerts, deadline close -> resumes to HR.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const SB_URL = env("SUPABASE_URL"), SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
const SENDER = env("SENDER_EMAIL"), SENDER_NAME = env("SENDER_NAME", "PaperLive Placement Team");
const CAREERS_URL = env("CAREERS_URL", "https://careers.paperlive.in");
const ADMIN_URL = env("ADMIN_URL", "https://admin.paperlive.in");
const ADMIN_NOTIFY = env("ADMIN_NOTIFY_EMAIL", SENDER);
const MODEL = env("ANTHROPIC_MODEL", "claude-sonnet-5-5");
const ALERT_SENDERS = env("LINKEDIN_ALERT_SENDERS", "jobalerts-noreply@linkedin.com,jobs-noreply@linkedin.com,jobs-listings@linkedin.com");
const MAX_ALERTS_PER_RUN = 150;
const db: SupabaseClient = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type, apikey, x-client-info" };

// ───────── Google ─────────
let gToken = "", gExp = 0;
async function google(path: string, init: RequestInit = {}, base = "https://gmail.googleapis.com/gmail/v1/users/me/") {
  if (!gToken || Date.now() > gExp) {
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"),
      refresh_token: env("GOOGLE_REFRESH_TOKEN"), grant_type: "refresh_token" }) });
    const j = await r.json();
    if (!j.access_token) throw new Error("Google sign-in failed: " + JSON.stringify(j));
    gToken = j.access_token; gExp = Date.now() + (j.expires_in - 60) * 1000;
  }
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${gToken}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Google ${path} ${r.status}: ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}
const b64urlDecode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
function bytesToB64(bytes: Uint8Array) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
const toB64url = (s: string) => bytesToB64(new TextEncoder().encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encHeader = (s: string) => `=?UTF-8?B?${bytesToB64(new TextEncoder().encode(s))}?=`;
const wrap76 = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
const escHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

type Attachment = { filename: string; mime: string; bytes: Uint8Array };
async function sendMail(o: { to: string; subject: string; html: string; threadId?: string; inReplyTo?: string; attachments?: Attachment[]; bcc?: string }) {
  const boundary = "pl" + crypto.randomUUID().replace(/-/g, "");
  const head = [`From: ${encHeader(SENDER_NAME)} <${SENDER}>`, `To: ${o.to}`, o.bcc ? `Bcc: ${o.bcc}` : "", `Subject: ${encHeader(o.subject)}`, "MIME-Version: 1.0",
    o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}\r\nReferences: ${o.inReplyTo}` : "", `Content-Type: multipart/mixed; boundary="${boundary}"`].filter(Boolean).join("\r\n");
  let body = `--${boundary}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(bytesToB64(new TextEncoder().encode(o.html)))}`;
  for (const a of o.attachments || [])
    body += `--${boundary}\r\nContent-Type: ${a.mime}; name="${a.filename}"\r\nContent-Disposition: attachment; filename="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(bytesToB64(a.bytes))}`;
  body += `--${boundary}--`;
  return await google("messages/send", { method: "POST", body: JSON.stringify({ raw: toB64url(head + "\r\n\r\n" + body), threadId: o.threadId }) });
}
async function logMail(kind: string, to: string, subject: string, extra: Record<string, unknown> = {}) {
  await db.from("email_log").insert({ kind, to_email: to, subject, ...extra });
}

const labelIds: Record<string, string> = {};
async function label(name: string) {
  if (labelIds[name]) return labelIds[name];
  const { labels } = await google("labels");
  let l = labels.find((x: any) => x.name === name);
  if (!l) l = await google("labels", { method: "POST", body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
  return (labelIds[name] = l.id);
}
async function markProcessed(id: string) {
  await google(`messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [await label("PaperLive/Processed")] }) });
}
const header = (m: any, n: string) => (m.payload?.headers || []).find((h: any) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
function walk(p: any, out: any[] = []) { out.push(p); for (const c of p?.parts || []) walk(c, out); return out; }
function bodyText(m: any) {
  const parts = walk(m.payload);
  const plain = parts.find(p => p.mimeType === "text/plain" && p.body?.data);
  const html = parts.find(p => p.mimeType === "text/html" && p.body?.data);
  if (html) {
    const h = b64urlDecode(html.body.data);
    const links = [...h.matchAll(/href="([^"]*linkedin\.com\/(?:comm\/)?jobs\/view\/[^"]*)"/g)].map(x => x[1].split("?")[0]);
    const text = h.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
    return (plain ? b64urlDecode(plain.body.data) : text) + (links.length ? "\n\nJob links:\n" + [...new Set(links)].join("\n") : "");
  }
  return plain ? b64urlDecode(plain.body.data) : (m.snippet || "");
}
async function pdfAttachments(m: any) {
  const out: { name: string; data: string }[] = [];
  for (const p of walk(m.payload)) {
    if (p.filename && /pdf$/i.test(p.filename) && p.body?.attachmentId && out.length < 2) {
      const a = await google(`messages/${m.id}/attachments/${p.body.attachmentId}`);
      out.push({ name: p.filename, data: bytesToB64(b64urlBytes(a.data)) });
    }
  }
  return out;
}

// ───────── Claude ─────────
async function claudeJSON(prompt: string, pdfs: { data: string }[] = []) {
  const content: any[] = pdfs.map(p => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } }));
  content.push({ type: "text", text: prompt });
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: {
    "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content }] }) });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude API: " + JSON.stringify(j));
  const t: string = j.content.map((c: any) => c.text || "").join("");
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  return m ? JSON.parse(m[0]) : null;
}

// ───────── Settings / helpers ─────────
async function settings() { const { data } = await db.from("settings").select("*").eq("id", 1).single(); return data; }
const relevant = (role: string, kw: string[]) => kw.some(k => role.toLowerCase().includes(k.toLowerCase()));
const fmtIST = (d: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(d)) + " IST";
const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

// 1. LinkedIn job-alert emails -> leads
async function stepAlerts(s: any) {
  const from = ALERT_SENDERS.split(",").map(x => `from:${x.trim()}`).join(" OR ");
  const { messages = [] } = await google(`messages?maxResults=15&q=${encodeURIComponent(`(${from}) newer_than:7d -label:PaperLive/Processed`)}`);
  let created = 0;
  for (const { id } of messages) {
    const m = await google(`messages/${id}?format=full`);
    const jobs = await claudeJSON(`This is a LinkedIn job alert email. List every job in it as a JSON array of objects with keys company, role, location, url (the linkedin.com/jobs/view link for that job, or null). Reply with the JSON array only.\n\n${bodyText(m).slice(0, 30000)}`) || [];
    for (const j of jobs) {
      if (!j?.company || !j?.role || !relevant(j.role, s.role_keywords)) continue;
      const { error } = await db.from("leads").insert({ company: j.company, role: j.role, location: j.location, source: "linkedin_alert", source_url: j.url, status: "needs_contact" });
      if (!error) created++;
    }
    await markProcessed(id);
  }
  return { alert_emails: messages.length, leads_created: created };
}

// 2. Leads -> Google Sheet
async function stepSheet() {
  const sheet = env("SHEET_ID"); if (!sheet) return { skipped: "no SHEET_ID" };
  const { data: rows } = await db.from("leads").select("*").eq("sheet_synced", false).order("created_at").limit(200);
  if (!rows?.length) return { synced: 0 };
  const values = rows.map(l => [fmtIST(l.created_at), l.company, l.role, l.location || "", l.source, l.source_url || "", l.hr_name || "", l.hr_email || "", l.status]);
  await google(`${sheet}/values/${encodeURIComponent(env("SHEET_RANGE", "Leads!A:I"))}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", body: JSON.stringify({ values }) }, "https://sheets.googleapis.com/v4/spreadsheets/");
  await db.from("leads").update({ sheet_synced: true }).in("id", rows.map(r => r.id));
  return { synced: rows.length };
}

// 3. Email HR of new leads
async function stepOutreach(s: any) {
  if (!s.outreach_enabled) return { skipped: "outreach off" };
  const { data: leads } = await db.from("leads").select("*").in("status", ["new", "needs_contact"]).not("hr_email", "is", null).is("contacted_at", null).limit(25);
  let sent = 0;
  for (const l of leads || []) {
    const v = { hr_name: l.hr_name || "there", company: l.company, role: l.role };
    const subject = fill(s.outreach_subject, v);
    try {
      const r = await sendMail({ to: l.hr_email, subject, html: escHtml(fill(s.outreach_body, v)).replace(/\n/g, "<br>") });
      await db.from("leads").update({ status: "contacted", contacted_at: new Date().toISOString(), gmail_thread_id: r.threadId }).eq("id", l.id);
      await logMail("hr_outreach", l.hr_email, subject, { lead_id: l.id }); sent++;
    } catch (e) { await logMail("hr_outreach", l.hr_email, subject, { lead_id: l.id, ok: false, error: String(e) }); }
  }
  return { outreach_sent: sent };
}

// 4. HR replies (and anything the team labels PaperLive/JD) -> jobs
const JD_PROMPT = (text: string) => `You read emails sent to a placement team. Decide whether this email (and any attached PDF) contains a job description or an open role the company wants candidates for.
Reply with JSON only:
{"is_jd": boolean, "not_interested": boolean, "company": string|null, "role": string|null, "skills": string[], "exp_min": number|null, "exp_max": number|null,
 "package_text": string|null, "package_min_lpa": number|null, "package_max_lpa": number|null, "location": string|null, "work_mode": "Onsite"|"Hybrid"|"Remote"|null,
 "description": string (a clean 80-150 word summary of the role for candidates, no contact details)}
Use years for experience (e.g. "3-5 years" -> 3 and 5; "3+ years" -> 3 and 3+3). Package in lakhs per annum (LPA). not_interested is true only if they clearly decline.

EMAIL:
${text.slice(0, 25000)}`;

async function createJobFromJD(x: any, s: any, hrEmail: string, lead: any) {
  const job = {
    lead_id: lead?.id ?? null, company: x.company || lead?.company || "Company", role: x.role || lead?.role || "Role",
    skills: Array.isArray(x.skills) ? x.skills.slice(0, 15) : [], exp_min: x.exp_min ?? 0, exp_max: Math.max(x.exp_max ?? x.exp_min ?? 50, x.exp_min ?? 0),
    package_text: x.package_text, package_min_lpa: x.package_min_lpa, package_max_lpa: x.package_max_lpa,
    location: x.location || lead?.location, work_mode: ["Onsite", "Hybrid", "Remote"].includes(x.work_mode) ? x.work_mode : null,
    description: x.description, status: s.auto_publish ? "live" : "draft",
  };
  const { data, error } = await db.from("jobs").insert(job).select().single();
  if (error) throw error;
  await db.from("job_pipeline").update({ hr_email: hrEmail, jd_source: "email" }).eq("job_id", data.id);
  return data;
}

async function stepReplies(s: any) {
  let jobs = 0, declined = 0;
  const processed = await label("PaperLive/Processed");
  const { data: leads } = await db.from("leads").select("*").eq("status", "contacted").not("gmail_thread_id", "is", null).limit(40);
  for (const l of leads || []) {
    const t = await google(`threads/${l.gmail_thread_id}?format=full`);
    const replies = (t.messages || []).filter((m: any) => !header(m, "From").toLowerCase().includes(SENDER.toLowerCase()) && !(m.labelIds || []).includes(processed));
    for (const m of replies) {
      const x = await claudeJSON(JD_PROMPT(`From: ${header(m, "From")}\nSubject: ${header(m, "Subject")}\n\n${bodyText(m)}`), await pdfAttachments(m));
      if (x?.is_jd) { await createJobFromJD(x, s, l.hr_email, l); await db.from("leads").update({ status: "jd_received" }).eq("id", l.id); jobs++; }
      else if (x?.not_interested) { await db.from("leads").update({ status: "not_interested" }).eq("id", l.id); declined++; }
      await markProcessed(m.id);
    }
  }
  // Manual route: any email the team labels "PaperLive/JD" in Gmail
  await label("PaperLive/JD");
  const { messages = [] } = await google(`messages?maxResults=10&q=${encodeURIComponent("label:PaperLive/JD -label:PaperLive/Processed")}`);
  for (const { id } of messages) {
    const m = await google(`messages/${id}?format=full`);
    const from = header(m, "From"), hr = (from.match(/<([^>]+)>/)?.[1] || from).trim();
    const x = await claudeJSON(JD_PROMPT(`From: ${from}\nSubject: ${header(m, "Subject")}\n\n${bodyText(m)}`), await pdfAttachments(m));
    if (x?.is_jd) {
      const { data: lead } = await db.from("leads").insert({ company: x.company || hr.split("@")[1] || "Company", role: x.role || "Role", location: x.location, source: "email", hr_email: hr, status: "jd_received", contacted_at: new Date().toISOString(), gmail_thread_id: m.threadId }).select().single();
      await createJobFromJD(x, s, hr, lead); jobs++;
    }
    await markProcessed(id);
  }
  return { jds_captured: jobs, declined };
}

// 5. New live jobs -> email every eligible candidate
async function stepNotify(onlyJob?: string) {
  let q = db.from("job_overview").select("*").eq("status", "live").gt("deadline", new Date().toISOString()).is("notified_at", null);
  if (onlyJob) q = q.eq("id", onlyJob);
  const { data: jobs } = await q;
  let sent = 0;
  for (const j of jobs || []) {
    const { data: cands } = await db.from("candidates").select("id,name,email").eq("alerts", true).gte("exp", j.exp_min).lte("exp", j.exp_max);
    const { data: done } = await db.from("email_log").select("to_email").eq("job_id", j.id).eq("kind", "candidate_alert");
    const already = new Set((done || []).map(d => d.to_email.toLowerCase()));
    const todo = (cands || []).filter(c => !already.has(c.email.toLowerCase()));
    const link = `${CAREERS_URL}/?job=${j.id}`;
    const subject = `New opening: ${j.role} at ${j.company} (apply by ${fmtIST(j.deadline)})`;
    const batch = todo.slice(0, MAX_ALERTS_PER_RUN - sent);
    for (const c of batch) {
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">
<p>Hi ${escHtml(c.name || "there")},</p><p>A new opening that matches your experience is live on PaperLive Careers.</p>
<table style="border-collapse:collapse;font-size:15px">${[["Role", j.role], ["Company", j.company], ["Experience", `${j.exp_min}–${j.exp_max} years`], ["Package", j.package_text || "Not disclosed"], ["Location", [j.location, j.work_mode].filter(Boolean).join(", ")], ["Apply by", fmtIST(j.deadline)]]
  .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#666">${k}</td><td style="padding:4px 0"><b>${escHtml(v)}</b></td></tr>`).join("")}</table>
<p style="margin:24px 0"><a href="${link}" style="background:#ff4a1c;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">View and apply</a></p>
<p style="color:#666;font-size:13px">Applications close automatically at the deadline. To stop job alerts, turn them off in your profile on ${escHtml(CAREERS_URL)}.</p></div>`;
      try { await sendMail({ to: c.email, subject, html }); await logMail("candidate_alert", c.email, subject, { job_id: j.id }); sent++; }
      catch (e) { await logMail("candidate_alert", c.email, subject, { job_id: j.id, ok: false, error: String(e) }); }
    }
    // Every eligible candidate has now been tried: mark the job as notified (large lists finish over several runs)
    if (batch.length === todo.length) {
      const { count } = await db.from("email_log").select("*", { count: "exact", head: true }).eq("job_id", j.id).eq("kind", "candidate_alert").eq("ok", true);
      await db.from("job_pipeline").update({ notified_at: new Date().toISOString(), notified_count: count || 0 }).eq("job_id", j.id);
    }
    if (sent >= MAX_ALERTS_PER_RUN) break;
  }
  return { candidate_alerts: sent };
}

// 6. Deadline passed -> close job, send resumes to HR
async function stepClose() {
  const now = new Date().toISOString();
  await db.from("jobs").update({ status: "closed" }).eq("status", "live").lte("deadline", now);
  const { data: jobs } = await db.from("job_overview").select("*").eq("status", "closed").lte("deadline", now).is("sent_to_hr_at", null).limit(5);
  let sentJobs = 0;
  for (const j of jobs || []) {
    const { data: apps } = await db.from("applications").select("id,resume_path,applied_at,candidates(name,email,phone,exp,skills,current_location)").eq("job_id", j.id).order("applied_at");
    if (!apps?.length) {
      await db.from("job_pipeline").update({ sent_to_hr_at: now, sent_count: 0, notes: "Closed with no applications" }).eq("job_id", j.id);
      await sendMail({ to: ADMIN_NOTIFY, subject: `Closed with no applications: ${j.role} at ${j.company}`, html: `No candidate applied before the deadline. Nothing was sent to HR.<br><a href="${ADMIN_URL}">Open admin portal</a>` }).catch(() => {});
      continue;
    }
    if (!j.hr_email) {
      const { count } = await db.from("email_log").select("*", { count: "exact", head: true }).eq("job_id", j.id).eq("kind", "admin_notice");
      if (!count) {
        await sendMail({ to: ADMIN_NOTIFY, subject: `Add HR email: ${j.role} at ${j.company} has ${apps.length} applicants`, html: `The deadline passed but this job has no HR email, so resumes were not sent. Add the HR email in the admin portal and they will go out on the next run.<br><a href="${ADMIN_URL}">Open admin portal</a>` }).catch(() => {});
        await logMail("admin_notice", ADMIN_NOTIFY, "missing HR email", { job_id: j.id });
      }
      continue;
    }
    const attachments: Attachment[] = []; let size = 0; const links: Record<string, string> = {};
    for (const a of apps) {
      if (!a.resume_path) continue;
      const c: any = a.candidates;
      const ext = a.resume_path.split(".").pop() || "pdf";
      const { data: blob } = await db.storage.from("resumes").download(a.resume_path);
      if (blob && size + blob.size < 18_000_000) {
        const bytes = new Uint8Array(await blob.arrayBuffer()); size += bytes.length;
        attachments.push({ filename: `${(c?.name || "Candidate").replace(/[^\w ]/g, "").trim().replace(/ +/g, "_")}_${c?.exp ?? ""}yrs.${ext}`, mime: blob.type || "application/pdf", bytes });
      } else {
        const { data: s } = await db.storage.from("resumes").createSignedUrl(a.resume_path, 60 * 60 * 24 * 14);
        if (s?.signedUrl) links[a.id] = s.signedUrl;
      }
    }
    const rows = apps.map((a: any, i: number) => { const c = a.candidates || {}; return `<tr>${[i + 1, c.name, c.exp != null ? c.exp + " yrs" : "", c.skills, c.current_location, c.email, c.phone].map(v => `<td style="border:1px solid #ddd;padding:6px 8px">${escHtml(v)}</td>`).join("")}<td style="border:1px solid #ddd;padding:6px 8px">${links[a.id] ? `<a href="${links[a.id]}">Download</a>` : "Attached"}</td></tr>`; }).join("");
    const subject = `${apps.length} shortlisted profiles for ${j.role} (${j.exp_min}–${j.exp_max} yrs) | PaperLive Learning`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111"><p>Hi,</p><p>Thank you for sharing the requirement for <b>${escHtml(j.role)}</b>. Please find ${apps.length} candidate profile${apps.length > 1 ? "s" : ""} below, with resumes attached.</p>
<table style="border-collapse:collapse;font-size:13px"><tr>${["#", "Name", "Experience", "Skills", "Location", "Email", "Phone", "Resume"].map(h => `<th style="border:1px solid #ddd;padding:6px 8px;background:#f5f5f5;text-align:left">${h}</th>`).join("")}</tr>${rows}</table>
<p>We'd be glad to coordinate interview slots. Our team will call you shortly for an update.</p><p>Regards,<br>${escHtml(SENDER_NAME)}<br>PaperLive Learning</p></div>`;
    try {
      const { data: lead } = j.lead_id ? await db.from("leads").select("gmail_thread_id").eq("id", j.lead_id).single() : { data: null };
      await sendMail({ to: j.hr_email, subject, html, attachments, threadId: lead?.gmail_thread_id || undefined, bcc: ADMIN_NOTIFY });
      await db.from("job_pipeline").update({ sent_to_hr_at: now, sent_count: apps.length }).eq("job_id", j.id);
      await db.from("applications").update({ status: "sent_to_hr" }).eq("job_id", j.id).eq("status", "applied");
      await logMail("hr_resumes", j.hr_email, subject, { job_id: j.id }); sentJobs++;
    } catch (e) { await logMail("hr_resumes", j.hr_email, subject, { job_id: j.id, ok: false, error: String(e) }); }
  }
  return { resumes_sent_for_jobs: sentJobs };
}

// ───────── Entry ─────────
async function allowed(req: Request) {
  const cron = req.headers.get("x-cron-secret");
  if (cron) { const { data } = await db.rpc("check_cron_secret", { s: cron }); return data === true; }
  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) return false;
  const u = createClient(SB_URL, env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data } = await u.rpc("is_admin");
  return data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await allowed(req))) return new Response(JSON.stringify({ error: "not allowed" }), { status: 401, headers: { ...cors, "content-type": "application/json" } });
  const body = await req.json().catch(() => ({}));
  const steps: string[] = body.steps || ["alerts", "sheet", "outreach", "replies", "notify", "close"];
  const s = await settings();
  const summary: Record<string, unknown> = {}, errors: string[] = [];
  const run: Record<string, () => Promise<unknown>> = {
    alerts: () => stepAlerts(s), sheet: stepSheet, outreach: () => stepOutreach(s),
    replies: () => stepReplies(s), notify: () => stepNotify(body.job_id), close: stepClose,
  };
  const googleReady = !!(env("GOOGLE_REFRESH_TOKEN") && env("SENDER_EMAIL"));
  const needsAI = ["alerts", "replies"];
  for (const st of steps) {
    if (!run[st]) continue;
    if (!googleReady) { summary[st] = { skipped: "Gmail not connected yet (add the Google secrets)" }; continue; }
    if (needsAI.includes(st) && !env("ANTHROPIC_API_KEY")) { summary[st] = { skipped: "ANTHROPIC_API_KEY not set" }; continue; }
    try { summary[st] = await run[st](); } catch (e) { errors.push(`${st}: ${e instanceof Error ? e.message : e}`); }
  }
  // The sheet step runs again so leads made in this run land in the sheet straight away
  if (!googleReady) await db.from("jobs").update({ status: "closed" }).eq("status", "live").lte("deadline", new Date().toISOString());
  else if (steps.includes("alerts") || steps.includes("replies")) { try { summary.sheet2 = await stepSheet(); } catch { /* next run */ } }
  await db.from("automation_runs").insert({ summary, error: errors.join("\n") || null });
  return new Response(JSON.stringify({ summary, errors }), { headers: { ...cors, "content-type": "application/json" } });
});
