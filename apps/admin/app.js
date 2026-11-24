import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.PL_CONFIG;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s), app = $("#app"), dlg = $("#dlg"), body = $("#dlgBody");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmt = (t) => (t ? IST.format(new Date(t)) : "—");
const toast = (m) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3500); };
const left = (t) => { const m = Math.round((new Date(t) - Date.now()) / 60000); if (m <= 0) return "Closed"; const h = Math.floor(m / 60); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m % 60}m left`; };
const jobState = (j) => (j.status === "draft" ? "draft" : j.status === "live" && new Date(j.deadline) > Date.now() ? "live" : "closed");
const pkgOf = (j) => j.package_text || (j.package_min_lpa ? `₹${j.package_min_lpa}${j.package_max_lpa ? "–" + j.package_max_lpa : "+"} LPA` : "—");
const toLocalInput = (d) => { const x = new Date(d), p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
const LEAD_STATUS = { new: "New", needs_contact: "Needs HR email", contacted: "HR emailed", jd_received: "JD received", not_interested: "Not interested", closed: "Closed" };
new MutationObserver(() => { for (const c of document.querySelectorAll(".stack td:not([data-l])")) { let i = 0, p = c; while ((p = p.previousElementSibling)) i += p.colSpan; c.dataset.l = c.closest("table").rows[0].cells[i]?.textContent || ""; } }).observe(document, { childList: true, subtree: true });

let view = location.hash.slice(1) || "overview", sub = { jobs: "live", leads: "all" };
const fail = (error) => { if (error) { toast(error.message || String(error)); throw error; } };
async function runAutomation(steps, job_id) {
  const { data, error } = await sb.functions.invoke("automation", { body: { steps, job_id } });
  if (error) { toast("Automation error: " + error.message); return null; }
  if (data?.errors?.length) toast("Automation finished with errors: " + data.errors[0]);
  return data;
}
function download(name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ───────── Auth ─────────
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return loginView();
  const { data: ok } = await sb.rpc("is_admin");
  $("#who").innerHTML = `<span class="mut" style="color:#bbb">${esc(session.user.email)}</span><button class="ghost sm" data-act="signout">Sign out</button>`;
  if (!ok) { $("#tabs").classList.add("hide"); app.innerHTML = `<section class="band wrap login"><h1>No admin access</h1><p>${esc(session.user.email)} isn't on the placement team list. Ask an existing admin to add you.</p></section>`; return; }
  $("#tabs").classList.remove("hide"); render();
}
function loginView() {
  $("#tabs").classList.add("hide"); $("#who").innerHTML = "";
  app.innerHTML = `<section class="band login"><h1>Placement team sign in</h1><form id="lf" class="grid" style="margin-top:18px"><label class="full">Email<input name="email" type="email" required autocomplete="email"></label><label class="full">Password<input name="password" type="password" required autocomplete="current-password"></label><div><button class="pri">Sign in</button></div></form><p class="mut" id="lm"></p></section>`;
  $("#lf").onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const { error } = await sb.auth.signInWithPassword(f); if (error) $("#lm").textContent = error.message; else boot(); };
}

// ───────── Views ─────────
function render() {
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === view));
  ({ overview, leads, jobs, candidates, emails, settings }[view] || overview)();
}
async function overview() {
  const [{ data: s, error }, { data: live }, { data: runs }] = await Promise.all([
    sb.rpc("admin_stats"), sb.from("job_overview").select("*").eq("status", "live").gt("deadline", new Date().toISOString()).order("deadline"),
    sb.from("automation_runs").select("*").order("started_at", { ascending: false }).limit(1)]);
  fail(error);
  const f = [["Leads sourced", s.leads], ["HR emailed", s.contacted], ["JDs received", s.jds], ["Jobs posted", s.posted], ["Applications", s.applications], ["Profiles sent to HR", s.sent_to_hr], ["Interviews", s.interviews], ["Offers", s.offers]];
  const mx = Math.max(1, ...f.map((x) => x[1])), run = runs?.[0];
  app.innerHTML = `<section class="band wrap"><h1>${s.live} live opening${s.live === 1 ? "" : "s"}, ${s.applications} applications, ${s.offers} offers to date</h1>
  <div class="kpis">${[[s.leads, "Leads sourced", `+${s.leads_week} this week`], [s.jds, "JDs received"], [s.live, "Live openings"], [s.active_candidates, "Active candidates"], [s.applications, "Applications"], [s.interviews, "Interviews conducted"], [s.offers, "Offers"]]
    .map(([v, l, x]) => `<div class="kpi"><div class="big">${v}</div><span>${l}</span>${x ? `<small>${x}</small>` : ""}</div>`).join("")}</div></section>
  <section class="band wrap cols" style="padding-top:0">
   <div><h2>Placement pipeline</h2><div class="funnel">${f.map(([l, v]) => `<div class="frow"><div>${l}</div><div class="bar"><i style="width:${Math.max(1, (v / mx) * 85)}%"></i><b>${v}</b></div></div>`).join("")}</div></div>
   <div><h2>Automation</h2><div class="panel"><p style="margin-top:0">Runs every 10 minutes: reads LinkedIn alerts, emails HR, captures JDs, alerts candidates, sends resumes at the deadline.</p>
   <p class="mut">Last run: ${run ? fmt(run.started_at) + " IST" : "never"}${run?.error ? ` · <span class="pill bad">errors</span>` : run ? ` · <span class="pill ok">ok</span>` : ""}</p>
   ${run ? `<pre>${esc(JSON.stringify(run.summary, null, 1))}${run.error ? "\n\n" + esc(run.error) : ""}</pre>` : ""}
   <div class="row" style="margin-top:12px"><button class="pri" data-act="runall">Run now</button></div></div></div></section>
  <section class="band wrap" style="padding-top:0"><div class="row sp"><h2>Closing soonest</h2><button class="pri" data-act="newjob">Post a job</button></div>${jobTable(live || [])}</section>`;
}
function jobTable(list) {
  if (!list.length) return `<p class="mut">Nothing here.</p>`;
  return `<div class="scroll"><table class="stack"><thead><tr><th>Role</th><th>Company</th><th>Experience</th><th>Package</th><th>Deadline (IST)</th><th class="n">Eligible</th><th class="n">Alerted</th><th class="n">Applied</th><th>Status</th></tr></thead><tbody>${list.map((j) => {
    const st = jobState(j);
    return `<tr class="click" data-job="${esc(j.id)}"><td><b>${esc(j.role)}</b>${j.jd_source === "email" ? ` <span class="pill off">AI</span>` : ""}</td><td>${esc(j.company)}</td><td class="nw">${j.exp_min}–${j.exp_max} yrs</td><td>${esc(pkgOf(j))}</td><td class="nw">${st === "draft" ? "—" : fmt(j.deadline)}</td><td class="n">${j.eligible}</td><td class="n">${j.notified_at ? j.notified_count : "—"}</td><td class="n">${j.applicants}</td>
    <td><span class="pill ${st === "live" ? "" : st === "draft" ? "off" : "ok"}">${st === "live" ? left(j.deadline) : st === "draft" ? "Draft" : j.sent_to_hr_at ? `Sent ${j.sent_count} to HR` : "Closed, sending"}</span></td></tr>`;
  }).join("")}</tbody></table></div>`;
}
async function jobs() {
  const { data, error } = await sb.from("job_overview").select("*").order("created_at", { ascending: false }); fail(error);
  const groups = { live: data.filter((j) => jobState(j) === "live"), draft: data.filter((j) => jobState(j) === "draft"), closed: data.filter((j) => jobState(j) === "closed") };
  app.innerHTML = `<section class="band wrap"><div class="row sp"><h1>Jobs</h1><button class="pri" data-act="newjob">Post a job</button></div>
  <div class="sub">${[["live", "Live"], ["draft", "Drafts"], ["closed", "Closed"]].map(([k, l]) => `<button class="sm" data-sub="jobs:${k}" aria-pressed="${sub.jobs === k}">${l} (${groups[k].length})</button>`).join("")}</div>${jobTable(groups[sub.jobs])}</section>`;
}
async function leads() {
  const { data, error } = await sb.from("leads").select("*").order("created_at", { ascending: false }).limit(1000); fail(error);
  const list = sub.leads === "all" ? data : data.filter((l) => l.status === sub.leads);
  const cnt = (k) => data.filter((l) => l.status === k).length;
  app.innerHTML = `<section class="band wrap"><div class="row sp"><h1>${data.length} leads sourced</h1><div class="row"><button class="ghost" data-act="exportleads">Download CSV</button><button class="pri" data-act="newlead">Add lead</button></div></div>
  <p class="mut">LinkedIn job alerts become leads automatically. Add the HR email to a lead and the outreach email goes out on the next run.</p>
  <div class="sub"><button class="sm" data-sub="leads:all" aria-pressed="${sub.leads === "all"}">All (${data.length})</button>${Object.entries(LEAD_STATUS).map(([k, l]) => `<button class="sm" data-sub="leads:${k}" aria-pressed="${sub.leads === k}">${l} (${cnt(k)})</button>`).join("")}</div>
  ${list.length ? `<div class="scroll"><table class="stack"><thead><tr><th>Found</th><th>Company</th><th>Role</th><th>Location</th><th>HR</th><th>Source</th><th>Status</th></tr></thead><tbody>${list.map((l) => `<tr class="click" data-lead="${esc(l.id)}"><td class="nw">${fmt(l.created_at)}</td><td><b>${esc(l.company)}</b></td><td>${esc(l.role)}</td><td>${esc(l.location)}</td><td>${l.hr_email ? esc(l.hr_name || "") + " " + esc(l.hr_email) : `<span class="pill">Add HR email</span>`}</td><td>${l.source === "linkedin_alert" ? (/^https:\/\//.test(l.source_url || "") ? `<a href="${esc(l.source_url)}" target="_blank" rel="noopener">LinkedIn</a>` : "LinkedIn") : esc(l.source)}</td><td><span class="pill ${l.status === "jd_received" ? "ok" : l.status === "not_interested" || l.status === "closed" ? "off" : ""}">${LEAD_STATUS[l.status]}</span></td></tr>`).join("")}</tbody></table></div>` : `<p class="mut">No leads in this group.</p>`}</section>`;
  window._leads = data;
}
async function candidates() {
  const [{ data, error }, { data: apps }] = await Promise.all([sb.from("candidates").select("*").order("created_at", { ascending: false }), sb.from("applications").select("candidate_id")]); fail(error);
  const n = {}; (apps || []).forEach((a) => (n[a.candidate_id] = (n[a.candidate_id] || 0) + 1));
  app.innerHTML = `<section class="band wrap"><div class="row sp"><h1>${data.length} candidates</h1><div class="row"><button class="ghost" data-act="importc">Import CSV / paste</button><button class="pri" data-act="newcand">Add candidate</button></div></div>
  <div class="row" style="margin:16px 0"><input id="cq" placeholder="Search name, email or skill" style="max-width:340px"><label class="row nw">Experience <input id="cmin" type="number" min="0" placeholder="min" style="width:80px"> to <input id="cmax" type="number" min="0" placeholder="max" style="width:80px"></label></div><div id="clist"></div></section>`;
  const draw = () => {
    const q = $("#cq").value.toLowerCase(), mn = $("#cmin").value, mx = $("#cmax").value;
    const l = data.filter((c) => [c.name, c.email, c.skills].join(" ").toLowerCase().includes(q) && (mn === "" || c.exp >= +mn) && (mx === "" || c.exp <= +mx));
    $("#clist").innerHTML = `<p class="mut">${l.length} shown</p><div class="scroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th class="n">Exp.</th><th>Skills</th><th>Resume</th><th class="n">Applied</th><th>Alerts</th><th></th></tr></thead><tbody>${l.map((c) => `<tr><td><b>${esc(c.name || "—")}</b>${c.user_id ? "" : ` <span class="pill off">not registered</span>`}</td><td>${esc(c.email)}</td><td class="nw">${esc(c.phone)}</td><td class="n">${c.exp ?? "—"}</td><td>${esc(c.skills)}</td><td>${c.resume_path ? `<button class="sm ghost" data-resume="${esc(c.resume_path)}">Open</button>` : "—"}</td><td class="n">${n[c.id] || 0}</td><td><input type="checkbox" data-alert="${esc(c.id)}" ${c.alerts ? "checked" : ""} aria-label="Alerts"></td><td><button class="sm ghost" data-editc="${esc(c.id)}">Edit</button></td></tr>`).join("")}</tbody></table></div>`;
  };
  ["cq", "cmin", "cmax"].forEach((id) => ($("#" + id).oninput = draw)); draw(); window._cands = data;
}
async function emails() {
  const [{ data: log }, { data: runs }] = await Promise.all([sb.from("email_log").select("*").order("created_at", { ascending: false }).limit(300), sb.from("automation_runs").select("*").order("started_at", { ascending: false }).limit(20)]);
  const kind = { candidate_alert: "Candidate alert", hr_outreach: "HR outreach", hr_resumes: "Resumes to HR", admin_notice: "Team notice" };
  app.innerHTML = `<section class="band wrap"><h1>Emails sent</h1><div class="scroll" style="margin-top:18px"><table class="stack"><thead><tr><th>When (IST)</th><th>Type</th><th>To</th><th>Subject</th><th>Result</th></tr></thead><tbody>${(log || []).map((e) => `<tr><td class="nw">${fmt(e.created_at)}</td><td>${kind[e.kind] || esc(e.kind)}</td><td>${esc(e.to_email)}</td><td>${esc(e.subject)}</td><td>${e.ok ? `<span class="pill ok">Sent</span>` : `<span class="pill bad" title="${esc(e.error)}">Failed</span>`}</td></tr>`).join("") || `<tr><td colspan="5" class="mut">No emails yet.</td></tr>`}</tbody></table></div>
  <h2 style="margin-top:32px">Automation runs</h2><div class="scroll"><table class="stack"><thead><tr><th>When (IST)</th><th>Summary</th><th>Errors</th></tr></thead><tbody>${(runs || []).map((r) => `<tr><td class="nw">${fmt(r.started_at)}</td><td><code>${esc(JSON.stringify(r.summary))}</code></td><td>${esc(r.error || "")}</td></tr>`).join("")}</tbody></table></div></section>`;
}
async function settings() {
  const { data: s, error } = await sb.from("settings").select("*").eq("id", 1).single(); fail(error);
  app.innerHTML = `<section class="band wrap" style="max-width:860px"><h1>Settings</h1><form id="sf" class="grid" style="margin-top:20px">
  <label class="full row" style="gap:10px"><input type="checkbox" name="auto_publish" ${s.auto_publish ? "checked" : ""}> Publish JDs captured from HR emails straight away (off = they wait as drafts for review)</label>
  <label class="full row" style="gap:10px"><input type="checkbox" name="outreach_enabled" ${s.outreach_enabled ? "checked" : ""}> Email HR automatically when a lead has an HR email</label>
  <label>Hours candidates get to apply<input name="default_window_hours" type="number" min="1" max="168" value="${s.default_window_hours}"></label>
  <label class="full">Role keywords that count as a lead (comma separated)<input name="role_keywords" value="${esc(s.role_keywords.join(", "))}"></label>
  <label class="full">HR outreach subject<input name="outreach_subject" value="${esc(s.outreach_subject)}"></label>
  <label class="full">HR outreach email. Use {hr_name}, {company} and {role}.<textarea name="outreach_body" rows="12">${esc(s.outreach_body)}</textarea></label>
  <div><button class="pri">Save settings</button></div></form></section>`;
  $("#sf").onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const { error } = await sb.from("settings").update({ auto_publish: !!f.get("auto_publish"), outreach_enabled: !!f.get("outreach_enabled"), default_window_hours: +f.get("default_window_hours"),
      role_keywords: f.get("role_keywords").split(",").map((x) => x.trim()).filter(Boolean), outreach_subject: f.get("outreach_subject"), outreach_body: f.get("outreach_body"), updated_at: new Date().toISOString() }).eq("id", 1);
    toast(error ? error.message : "Settings saved");
  };
}

// ───────── Dialogs ─────────
const show = (html) => { body.innerHTML = html; if (!dlg.open) dlg.showModal(); };
const head = (t) => `<div class="row sp"><h2 style="margin:0">${t}</h2><button class="ghost sm" data-act="close">Close</button></div>`;
async function openJob(id) {
  const [{ data: j }, { data: apps }] = await Promise.all([sb.from("job_overview").select("*").eq("id", id).single(), sb.from("applications").select("id,status,applied_at,resume_path,candidates(name,email,phone,exp,skills)").eq("job_id", id).order("applied_at")]);
  const st = jobState(j);
  show(`${head(esc(j.role))}<div class="mut">${esc(j.company)}</div>
  <div class="facts panel"><div><span>Experience</span>${j.exp_min}–${j.exp_max} yrs</div><div><span>Package</span>${esc(pkgOf(j))}</div><div><span>Location</span>${esc(j.location || "—")} ${esc(j.work_mode || "")}</div><div><span>Deadline</span>${st === "draft" ? "Not posted" : fmt(j.deadline) + " IST"}</div><div><span>Status</span>${st === "live" ? left(j.deadline) : st}</div><div><span>HR email</span>${esc(j.hr_email || "Not set")}</div><div><span>JD received</span>${fmt(j.jd_received_at)} ${j.jd_source === "email" ? "(AI from email)" : ""}</div><div><span>Candidates alerted</span>${j.notified_at ? `${j.notified_count} on ${fmt(j.notified_at)}` : "Not yet"}</div><div><span>Sent to HR</span>${j.sent_to_hr_at ? `${j.sent_count} on ${fmt(j.sent_to_hr_at)}` : "Not yet"}</div></div>
  <div class="grid"><label>Interviews conducted<input id="piv" type="number" min="0" value="${j.interviews || 0}"></label><label>Offers<input id="pof" type="number" min="0" value="${j.offers || 0}"></label><label class="full">Notes from HR calls<textarea id="pno" rows="2">${esc(j.pipeline_notes)}</textarea></label></div>
  <div class="row"><button data-act="savepipe" data-id="${esc(id)}">Save progress</button>${st === "draft" ? `<button class="pri" data-act="publish" data-id="${esc(id)}">Publish and alert candidates</button>` : ""}${st === "live" ? `<button class="ghost" data-act="closenow" data-id="${esc(id)}">Close now and send to HR</button>` : ""}${st === "live" && !j.notified_at ? `<button class="ghost" data-act="notify" data-id="${esc(id)}">Send candidate alerts now</button>` : ""}<button class="ghost" data-act="editjob" data-id="${esc(id)}">Edit</button><button class="ghost" data-act="deljob" data-id="${esc(id)}">Delete</button></div>
  <div class="row sp"><h2 style="margin:0;font-size:24px">${apps.length} applicant${apps.length === 1 ? "" : "s"}</h2>${apps.length ? `<button class="sm ghost" data-act="exportapps" data-id="${esc(id)}">Download CSV</button>` : ""}</div>
  ${apps.length ? `<div class="scroll"><table class="stack"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th class="n">Exp.</th><th>Resume</th><th>Stage</th></tr></thead><tbody>${apps.map((a) => `<tr><td>${esc(a.candidates?.name)}</td><td>${esc(a.candidates?.email)}</td><td class="nw">${esc(a.candidates?.phone)}</td><td class="n">${a.candidates?.exp ?? ""}</td><td>${a.resume_path ? `<button class="sm ghost" data-resume="${esc(a.resume_path)}">Open</button>` : "—"}</td><td><select data-appst="${esc(a.id)}" aria-label="Stage">${["applied", "sent_to_hr", "interview", "offer", "rejected"].map((s) => `<option value="${s}" ${a.status === s ? "selected" : ""}>${{ applied: "Applied", sent_to_hr: "Sent to HR", interview: "Interview", offer: "Offer", rejected: "Rejected" }[s]}</option>`).join("")}</select></td></tr>`).join("")}</tbody></table></div>` : `<p class="mut">No applications yet.</p>`}`);
  window._job = { j, apps };
}
async function jobForm(j = {}, lead = null) {
  const pipe = j.id ? (await sb.from("job_pipeline").select("hr_email").eq("job_id", j.id).single()).data : null;
  const v = { ...j, company: j.company || lead?.company, role: j.role || lead?.role, location: j.location || lead?.location, hr_email: pipe?.hr_email || lead?.hr_email || "" };
  const { data: s } = await sb.from("settings").select("default_window_hours").eq("id", 1).single();
  show(`${head(j.id ? "Edit job" : "Post a job")}<form id="jf" class="grid">
  <label>Company<input name="company" required value="${esc(v.company)}"></label><label>Role<input name="role" required value="${esc(v.role)}"></label>
  <label>Min experience (yrs)<input name="exp_min" type="number" step="0.5" min="0" required value="${esc(v.exp_min ?? 3)}"></label><label>Max experience (yrs)<input name="exp_max" type="number" step="0.5" min="0" required value="${esc(v.exp_max ?? 5)}"></label>
  <label>Package as shown<input name="package_text" value="${esc(v.package_text)}" placeholder="₹14–18 LPA"></label><label>Package from (LPA, for filters)<input name="package_min_lpa" type="number" step="0.5" value="${esc(v.package_min_lpa)}"></label><label>Package up to (LPA)<input name="package_max_lpa" type="number" step="0.5" value="${esc(v.package_max_lpa)}"></label>
  <label>Location<input name="location" value="${esc(v.location)}" placeholder="Pune"></label><label>Work mode<select name="work_mode"><option value="">—</option>${["Onsite", "Hybrid", "Remote"].map((m) => `<option ${v.work_mode === m ? "selected" : ""}>${m}</option>`).join("")}</select></label>
  <label>Apply by (your local time)<input name="deadline" type="datetime-local" required value="${toLocalInput(v.deadline || Date.now() + (s?.default_window_hours || 20) * 3600e3)}"></label>
  <label>HR email (resumes go here at the deadline)<input name="hr_email" type="email" value="${esc(v.hr_email)}"></label>
  <label class="full">Skills (comma separated)<input name="skills" value="${esc((v.skills || []).join(", "))}"></label>
  <label class="full">Description for candidates<textarea name="description" rows="5">${esc(v.description)}</textarea></label>
  <div class="full row">${j.id ? `<button class="pri" name="go" value="save">Save</button>` : `<button class="pri" name="go" value="live">Publish and alert candidates</button><button name="go" value="draft">Save as draft</button>`}</div></form>`);
  $("#jf").onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)), go = e.submitter?.value;
    const num = (x) => (x === "" || x == null ? null : +x);
    const row = { company: f.company, role: f.role, exp_min: +f.exp_min, exp_max: +f.exp_max, package_text: f.package_text || null, package_min_lpa: num(f.package_min_lpa), package_max_lpa: num(f.package_max_lpa),
      location: f.location || null, work_mode: f.work_mode || null, deadline: new Date(f.deadline).toISOString(), skills: f.skills.split(",").map((x) => x.trim()).filter(Boolean), description: f.description || null };
    if (row.exp_max < row.exp_min) return toast("Max experience must be at least the minimum.");
    if (go !== "save") { row.status = go; if (lead) row.lead_id = lead.id; }
    if (go === "live" && new Date(row.deadline) <= Date.now()) return toast("Pick a deadline in the future.");
    const r = j.id ? await sb.from("jobs").update(row).eq("id", j.id).select().single() : await sb.from("jobs").insert(row).select().single();
    fail(r.error);
    await sb.from("job_pipeline").update({ hr_email: f.hr_email || null }).eq("job_id", r.data.id);
    if (lead) await sb.from("leads").update({ status: "jd_received", hr_email: lead.hr_email || f.hr_email || null }).eq("id", lead.id);
    if (go === "live") { toast("Published. Sending alerts to eligible candidates…"); const res = await runAutomation(["notify"], r.data.id); if (res) toast(`Alerts sent: ${res.summary?.notify?.candidate_alerts ?? 0}`); }
    else toast("Saved");
    openJob(r.data.id); render();
  };
}
function leadForm(l = {}) {
  show(`${head(l.id ? esc(l.company) : "Add lead")}<form id="lf2" class="grid">
  <label>Company<input name="company" required value="${esc(l.company)}"></label><label>Role<input name="role" required value="${esc(l.role)}"></label>
  <label>Location<input name="location" value="${esc(l.location)}"></label><label>Post / job link<input name="source_url" type="url" value="${esc(l.source_url)}"></label>
  <label>HR name<input name="hr_name" value="${esc(l.hr_name)}"></label><label>HR email<input name="hr_email" type="email" value="${esc(l.hr_email)}"></label>
  <label>Status<select name="status">${Object.entries(LEAD_STATUS).map(([k, v]) => `<option value="${k}" ${(l.status || "new") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
  <label class="full">Notes<textarea name="notes" rows="3">${esc(l.notes)}</textarea></label>
  <div class="full row"><button class="pri">Save lead</button>${l.id ? `<button type="button" class="ghost" data-act="jobfromlead" data-id="${esc(l.id)}">Create job from this lead</button><button type="button" class="ghost" data-act="dellead" data-id="${esc(l.id)}">Delete</button>` : ""}</div>
  ${l.contacted_at ? `<p class="mut full">HR emailed ${fmt(l.contacted_at)} IST. Replies on that email thread are read automatically.</p>` : ""}</form>`);
  $("#lf2").onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    for (const k in f) if (f[k] === "") f[k] = null;
    if (f.hr_email && f.status === "needs_contact") f.status = "new";
    const r = l.id ? await sb.from("leads").update({ ...f, sheet_synced: false }).eq("id", l.id) : await sb.from("leads").insert({ ...f, source: "manual" });
    fail(r.error); dlg.close(); toast(f.hr_email && !l.contacted_at ? "Saved. The outreach email goes out on the next run." : "Lead saved"); render();
  };
}
function candForm(c = {}) {
  show(`${head(c.id ? "Edit candidate" : "Add candidate")}<form id="cf" class="grid">
  <label>Name<input name="name" required value="${esc(c.name)}"></label><label>Email<input name="email" type="email" required value="${esc(c.email)}" ${c.user_id ? "readonly" : ""}></label>
  <label>Phone<input name="phone" value="${esc(c.phone)}"></label><label>Experience (yrs)<input name="exp" type="number" step="0.5" min="0" required value="${esc(c.exp)}"></label>
  <label class="full">Skills<input name="skills" value="${esc(c.skills)}"></label><label>Current location<input name="current_location" value="${esc(c.current_location)}"></label>
  <div class="full row"><button class="pri">Save</button>${c.id ? `<button type="button" class="ghost" data-act="delcand" data-id="${esc(c.id)}">Delete</button>` : ""}</div></form>`);
  $("#cf").onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.exp = +f.exp;
    const r = c.id ? await sb.from("candidates").update(f).eq("id", c.id) : await sb.from("candidates").insert({ ...f, source: "team" });
    fail(r.error); dlg.close(); toast("Candidate saved"); render();
  };
}
function importForm() {
  show(`${head("Import candidates")}<p class="mut" style="margin:0">Paste rows from Excel or Google Sheets, or upload a CSV. Columns in this order: name, email, phone, experience (years), skills, location. A header row is skipped.</p>
  <input type="file" id="cfile" accept=".csv,text/csv"><textarea id="ctext" rows="10" placeholder="Asha Rao, asha@example.com, 9876543210, 4, AWS Terraform, Pune"></textarea>
  <div class="row"><button class="pri" data-act="doimport">Import</button><span class="mut" id="imsg"></span></div>`);
  $("#cfile").onchange = async (e) => ($("#ctext").value = await e.target.files[0].text());
}
async function doImport() {
  const rows = $("#ctext").value.split(/\r?\n/).map((l) => (l.includes("\t") ? l.split("\t") : l.split(",")).map((s) => s.trim().replace(/^"|"$/g, ""))).filter((r) => r[1]?.includes("@"));
  const recs = rows.map((r) => ({ name: r[0], email: r[1].toLowerCase(), phone: r[2] || null, exp: r[3] ? +r[3] : null, skills: r[4] || null, current_location: r[5] || null, source: "team" }));
  if (!recs.length) return ($("#imsg").textContent = "No rows with an email found.");
  const { data: existing } = await sb.from("candidates").select("email");
  const have = new Set((existing || []).map((x) => x.email.toLowerCase()));
  const fresh = recs.filter((r) => !have.has(r.email));
  for (let i = 0; i < fresh.length; i += 200) { const { error } = await sb.from("candidates").insert(fresh.slice(i, i + 200)); if (error) return ($("#imsg").textContent = error.message); }
  dlg.close(); toast(`${fresh.length} added, ${recs.length - fresh.length} already on the list`); render();
}

// ───────── Events ─────────
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-tab]"); if (t) { view = t.dataset.tab; history.replaceState(null, "", "#" + view); return render(); }
  const s = e.target.closest("[data-sub]"); if (s) { const [k, v] = s.dataset.sub.split(":"); sub[k] = v; return render(); }
  const rs = e.target.closest("[data-resume]"); if (rs) { const { data, error } = await sb.storage.from("resumes").createSignedUrl(rs.dataset.resume, 600); if (error) return toast(error.message); window.open(data.signedUrl, "_blank", "noopener"); return; }
  const ec = e.target.closest("[data-editc]"); if (ec) return candForm(window._cands.find((c) => c.id === ec.dataset.editc));
  const jr = e.target.closest("[data-job]"); if (jr) return openJob(jr.dataset.job);
  const lr = e.target.closest("[data-lead]"); if (lr) return leadForm(window._leads.find((l) => l.id === lr.dataset.lead));
  const b = e.target.closest("[data-act]"); if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  const confirmTwice = () => { if (b.dataset.sure) return true; b.dataset.sure = 1; b.textContent = "Click again to confirm"; return false; };
  switch (act) {
    case "close": return dlg.close();
    case "signout": await sb.auth.signOut(); return loginView();
    case "runall": { b.disabled = true; b.textContent = "Running…"; await runAutomation(); return render(); }
    case "newjob": return jobForm();
    case "newlead": return leadForm();
    case "newcand": return candForm();
    case "importc": return importForm();
    case "doimport": return doImport();
    case "editjob": return jobForm(window._job.j);
    case "jobfromlead": return jobForm({}, window._leads.find((l) => l.id === id));
    case "savepipe": { const { error } = await sb.from("job_pipeline").update({ interviews: +$("#piv").value, offers: +$("#pof").value, notes: $("#pno").value }).eq("job_id", id); toast(error ? error.message : "Progress saved"); return render(); }
    case "publish": { const j = window._job.j; const dl = new Date(j.deadline) > Date.now() ? j.deadline : null; fail((await sb.from("jobs").update({ status: "live", deadline: dl }).eq("id", id)).error); toast("Published. Sending alerts…"); const r = await runAutomation(["notify"], id); if (r) toast(`Alerts sent: ${r.summary?.notify?.candidate_alerts ?? 0}`); openJob(id); return render(); }
    case "notify": { b.disabled = true; const r = await runAutomation(["notify"], id); if (r) toast(`Alerts sent: ${r.summary?.notify?.candidate_alerts ?? 0}`); return openJob(id); }
    case "closenow": { if (!confirmTwice()) return; fail((await sb.from("jobs").update({ deadline: new Date().toISOString() }).eq("id", id)).error); toast("Closed. Sending resumes to HR…"); await runAutomation(["close"]); openJob(id); return render(); }
    case "deljob": { if (!confirmTwice()) return; fail((await sb.from("jobs").delete().eq("id", id)).error); dlg.close(); toast("Job deleted"); return render(); }
    case "dellead": { if (!confirmTwice()) return; fail((await sb.from("leads").delete().eq("id", id)).error); dlg.close(); return render(); }
    case "delcand": { if (!confirmTwice()) return; fail((await sb.from("candidates").delete().eq("id", id)).error); dlg.close(); return render(); }
    case "exportleads": return download("leads.csv", [["Found", "Company", "Role", "Location", "Source", "Link", "HR name", "HR email", "Status", "HR emailed"], ...window._leads.map((l) => [fmt(l.created_at), l.company, l.role, l.location, l.source, l.source_url, l.hr_name, l.hr_email, LEAD_STATUS[l.status], fmt(l.contacted_at)])]);
    case "exportapps": { const { j, apps } = window._job; return download(`${j.company}-${j.role}-applicants.csv`.replace(/[^\w.-]+/g, "_"), [["Name", "Email", "Phone", "Experience", "Skills", "Applied", "Stage"], ...apps.map((a) => [a.candidates?.name, a.candidates?.email, a.candidates?.phone, a.candidates?.exp, a.candidates?.skills, fmt(a.applied_at), a.status])]); }
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.dataset.appst) { const { error } = await sb.from("applications").update({ status: e.target.value }).eq("id", e.target.dataset.appst); toast(error ? error.message : "Stage updated"); }
  if (e.target.dataset.alert) { const { error } = await sb.from("candidates").update({ alerts: e.target.checked }).eq("id", e.target.dataset.alert); toast(error ? error.message : "Alerts updated"); }
});
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_OUT") loginView(); });
setInterval(() => { if (!dlg.open && document.visibilityState === "visible" && (view === "overview" || view === "jobs")) render(); }, 60000);
boot();
