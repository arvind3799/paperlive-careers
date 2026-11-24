import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm";

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.PL_CONFIG;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const IST = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmt = (t) => IST.format(new Date(t)) + " IST";
const toast = (m) => { const t = document.createElement("div"); t.className = "toast"; t.textContent = m; document.body.append(t); setTimeout(() => t.remove(), 3000); };
const dlg = $("#dlg"), body = $("#dlgBody");
const ROLE_TYPES = [["DevOps", /devops/i], ["Multi-cloud", /multi.?cloud/i], ["SRE", /sre|site reliability/i], ["Platform", /platform/i], ["Cloud", /cloud|aws|azure|gcp/i], ["Kubernetes", /kubernetes|k8s/i], ["Data", /data/i], ["Security", /secur/i]];

let jobs = [], session = null, me = null, myApps = [];

function timeLeft(t) {
  const m = Math.round((new Date(t) - Date.now()) / 60000);
  if (m <= 0) return { txt: "Closed", urgent: false };
  const h = Math.floor(m / 60), d = Math.floor(h / 24);
  return { txt: d >= 1 ? `${d}d ${h % 24}h` : `${h}h ${m % 60}m`, urgent: m < 180 };
}
const pkgOf = (j) => j.package_text || (j.package_min_lpa ? `₹${j.package_min_lpa}${j.package_max_lpa ? "–" + j.package_max_lpa : "+"} LPA` : "Not disclosed");
const eligible = (j) => me?.exp != null && me.exp >= j.exp_min && me.exp <= j.exp_max;

// ───────── Data ─────────
async function loadJobs() {
  const { data, error } = await sb.from("jobs").select("id,company,role,skills,exp_min,exp_max,package_text,package_min_lpa,package_max_lpa,location,work_mode,description,deadline,posted_at")
    .eq("status", "live").gt("deadline", new Date().toISOString()).order("deadline");
  if (error) { $("#count").textContent = "Couldn't load openings. Refresh the page to try again."; return; }
  jobs = data; buildFacets(); render();
  const deep = new URLSearchParams(location.search).get("job");
  if (deep && !dlg.open) openJob(deep);
}
async function loadMe() {
  session = (await sb.auth.getSession()).data.session;
  if (!session) { me = null; myApps = []; return authUI(); }
  const { data } = await sb.from("candidates").select("*").eq("user_id", session.user.id).maybeSingle();
  me = data;
  const { data: apps } = await sb.from("applications").select("job_id,status,applied_at,jobs(company,role,deadline)").order("applied_at", { ascending: false });
  myApps = apps || [];
  if (me?.exp != null && $("#fExp").value === "-1") { $("#fExp").value = Math.min(15, Math.round(me.exp)); expOut(); }
  authUI();
  if (me && (!me.name || me.exp == null || !me.resume_path)) openProfile(true);
}
function authUI() {
  $("#authArea").innerHTML = session
    ? `<button class="ghost" data-act="profile">${esc(me?.name?.split(" ")[0] || "My profile")}</button><button class="ghost" data-act="signout">Sign out</button>`
    : `<button class="ghost" data-act="signin">Sign in</button><button class="pri" data-act="signup">Register</button>`;
  $("#mine").classList.toggle("hide", !session);
  $("#mineList").innerHTML = myApps.length
    ? `<table><tr><th>Role</th><th>Company</th><th>Applied</th><th>Status</th></tr>${myApps.map((a) => `<tr><td>${esc(a.jobs?.role)}</td><td>${esc(a.jobs?.company)}</td><td class="nw">${fmt(a.applied_at)}</td><td>${{ applied: "Applied", sent_to_hr: "Profile sent to company", interview: "Interview", offer: "Offer", rejected: "Not selected" }[a.status] || esc(a.status)}</td></tr>`).join("")}</table>`
    : `<p class="mut">You haven't applied yet.</p>`;
  render();
}

// ───────── Filters ─────────
function buildFacets() {
  const locs = [...new Set(jobs.flatMap((j) => String(j.location || "").split(/[,/]/).map((s) => s.trim()).filter(Boolean)))].sort();
  const keep = (id) => new Set([...document.querySelectorAll(`#${id} input:checked`)].map((i) => i.value));
  const lk = keep("fLoc"), rk = keep("fRole");
  $("#fLoc").innerHTML = locs.map((l) => `<label><input type="checkbox" value="${esc(l)}" ${lk.has(l) ? "checked" : ""}> ${esc(l)} <span class="mut">(${jobs.filter((j) => String(j.location).includes(l)).length})</span></label>`).join("") || `<span class="mut">No locations yet</span>`;
  $("#fRole").innerHTML = ROLE_TYPES.filter(([, re]) => jobs.some((j) => re.test(j.role + " " + (j.skills || []).join(" ")))).map(([n]) => `<label><input type="checkbox" value="${n}" ${rk.has(n) ? "checked" : ""}> ${n}</label>`).join("") || `<span class="mut">—</span>`;
}
const checked = (id) => [...document.querySelectorAll(`#${id} input:checked`)].map((i) => i.value);
function filtered() {
  const q = $("#qText").value.trim().toLowerCase(), ql = $("#qLoc").value.trim().toLowerCase();
  const exp = +$("#fExp").value, locs = checked("fLoc"), modes = checked("fMode"), roles = checked("fRole");
  const pkg = +$("#fPkg").value, close = +$("#fClose").value;
  let l = jobs.filter((j) => {
    const hay = [j.role, j.company, ...(j.skills || [])].join(" ").toLowerCase();
    if (q && !q.split(/\s+/).every((w) => hay.includes(w))) return false;
    if (ql && !String(j.location || "").toLowerCase().includes(ql)) return false;
    if (exp >= 0 && (exp < j.exp_min || exp > j.exp_max)) return false;
    if (locs.length && !locs.some((x) => String(j.location).includes(x))) return false;
    if (modes.length && !modes.includes(j.work_mode)) return false;
    if (roles.length && !roles.some((r) => ROLE_TYPES.find(([n]) => n === r)[1].test(j.role + " " + (j.skills || []).join(" ")))) return false;
    if (pkg && !((j.package_max_lpa || j.package_min_lpa || 0) >= pkg)) return false;
    if (close && new Date(j.deadline) - Date.now() > close * 3600e3) return false;
    return new Date(j.deadline) > Date.now();
  });
  const s = $("#sort").value;
  l.sort(s === "new" ? (a, b) => new Date(b.posted_at) - new Date(a.posted_at) : s === "pkg" ? (a, b) => (b.package_max_lpa || b.package_min_lpa || 0) - (a.package_max_lpa || a.package_min_lpa || 0) : (a, b) => new Date(a.deadline) - new Date(b.deadline));
  return l;
}
function render() {
  const l = filtered(), applied = new Set(myApps.map((a) => a.job_id));
  $("#count").textContent = jobs.length ? `${l.length} of ${jobs.length} live opening${jobs.length === 1 ? "" : "s"}` : "";
  $("#jobs").innerHTML = l.length ? l.map((j) => {
    const t = timeLeft(j.deadline);
    return `<article class="job" data-job="${esc(j.id)}" tabindex="0">
      <div class="co">${esc(j.company)}</div>
      <h3>${esc(j.role)}</h3>
      <div class="meta"><span>Experience <b>${j.exp_min}–${j.exp_max} yrs</b></span><span>Package <b>${esc(pkgOf(j))}</b></span><span>Location <b>${esc([j.location, j.work_mode].filter(Boolean).join(" · ") || "—")}</b></span></div>
      ${j.skills?.length ? `<div class="skills">${j.skills.slice(0, 6).map((s) => `<i>${esc(s)}</i>`).join("")}</div>` : ""}
      <div class="side"><div class="status ${t.urgent ? "urgent" : ""}"><small>Time left to apply</small><b>${t.txt}</b><small>Apply by ${fmt(j.deadline)}</small></div>
      ${applied.has(j.id) ? `<span class="pill ok">Applied</span>` : session && me?.exp != null && !eligible(j) ? `<span class="pill no">Needs ${j.exp_min}–${j.exp_max} yrs</span>` : `<button class="pri sm" data-apply="${esc(j.id)}">Apply</button>`}</div>
    </article>`;
  }).join("") : `<div class="empty"><h3>No openings match these filters</h3><p class="mut">${jobs.length ? "Try clearing a filter." : "New openings are posted every day. Register and we'll email you when one matches your experience."}</p></div>`;
}
function expOut() { const v = +$("#fExp").value; $("#fExpOut").textContent = v < 0 ? "Any" : `${v} yr${v === 1 ? "" : "s"}`; }

// ───────── Dialogs ─────────
function openJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) { toast("This opening has closed."); return; }
  const t = timeLeft(j.deadline), done = myApps.some((a) => a.job_id === id);
  body.innerHTML = `<div class="row sp"><span class="mut">${esc(j.company)}</span><button class="ghost sm" data-act="close">Close</button></div>
  <h2 style="font-size:34px">${esc(j.role)}</h2>
  <div class="facts"><div><span>Experience</span>${j.exp_min}–${j.exp_max} years</div><div><span>Package</span>${esc(pkgOf(j))}</div><div><span>Location</span>${esc(j.location || "—")}${j.work_mode ? " · " + esc(j.work_mode) : ""}</div><div><span>Apply by</span>${fmt(j.deadline)}</div><div><span>Time left</span><b>${t.txt}</b></div></div>
  ${j.skills?.length ? `<div class="skills" style="display:flex">${j.skills.map((s) => `<i>${esc(s)}</i>`).join("")}</div>` : ""}
  ${j.description ? `<p style="white-space:pre-line;margin:0">${esc(j.description)}</p>` : ""}
  <div class="row">${done ? `<span class="pill ok">You've applied</span>` : `<button class="pri" data-apply="${esc(j.id)}">Apply now</button>`}<button class="ghost" data-act="share" data-id="${esc(j.id)}">Copy link</button></div><p class="msg" id="applyMsg"></p>`;
  if (!dlg.open) dlg.showModal();
}
function authForm(mode) {
  body.innerHTML = `<div class="row sp"><h2 style="font-size:32px">${mode === "signup" ? "Register for placements" : "Sign in"}</h2><button class="ghost sm" data-act="close">Close</button></div>
  ${mode === "signup" ? `<p class="mut" style="margin:0">Use the same email you gave the placement team, so your details link up.</p>` : ""}
  <form id="af" class="grid"><label class="full">Email<input name="email" type="email" autocomplete="email" required></label>
  <label class="full">Password<input name="password" type="password" minlength="8" autocomplete="${mode === "signup" ? "new-password" : "current-password"}" required></label>
  <div class="full row"><button class="pri">${mode === "signup" ? "Create account" : "Sign in"}</button>
  <button type="button" class="link" data-act="${mode === "signup" ? "signin" : "signup"}">${mode === "signup" ? "I already have an account" : "New here? Register"}</button>
  ${mode === "signin" ? `<button type="button" class="link" data-act="reset">Forgot password</button>` : ""}</div></form><p class="msg" id="am"></p>`;
  $("#af").onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const m = $("#am"); m.className = "msg"; m.textContent = "Please wait…";
    const r = mode === "signup"
      ? await sb.auth.signUp({ email: f.email, password: f.password, options: { emailRedirectTo: location.origin + location.pathname + location.search } })
      : await sb.auth.signInWithPassword({ email: f.email, password: f.password });
    if (r.error) { m.textContent = r.error.message; return; }
    if (mode === "signup" && !r.data.session) { m.className = "msg ok"; m.textContent = "Check your inbox and click the confirmation link to finish registering."; return; }
    dlg.close(); await loadMe(); toast("Signed in");
  };
  if (!dlg.open) dlg.showModal();
}
function openProfile(first = false) {
  const c = me || {};
  body.innerHTML = `<div class="row sp"><h2 style="font-size:32px">${first ? "Complete your profile" : "My profile"}</h2>${first ? "" : `<button class="ghost sm" data-act="close">Close</button>`}</div>
  ${first ? `<p class="mut" style="margin:0">We use your experience to match you to openings and email you when one is posted.</p>` : ""}
  <form id="pf" class="grid">
  <label>Full name<input name="name" required value="${esc(c.name)}"></label>
  <label>Phone<input name="phone" type="tel" required value="${esc(c.phone)}"></label>
  <label>Total experience (years)<input name="exp" type="number" min="0" max="40" step="0.5" required value="${esc(c.exp ?? "")}"></label>
  <label>Current location<input name="current_location" value="${esc(c.current_location)}"></label>
  <label class="full">Key skills<input name="skills" value="${esc(c.skills)}" placeholder="AWS, Azure, Terraform, Kubernetes, Jenkins"></label>
  <label class="full">Resume (PDF or Word, up to 5 MB)${c.resume_path ? ` <span class="pill ok">Uploaded</span>` : ""}<input name="resume" type="file" accept=".pdf,.doc,.docx" ${c.resume_path ? "" : "required"}></label>
  <label class="full row" style="gap:10px"><input type="checkbox" name="alerts" ${c.alerts !== false ? "checked" : ""}> Email me new openings that match my experience</label>
  <div class="full"><button class="pri">Save profile</button></div></form><p class="msg" id="pm"></p>`;
  $("#pf").onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target), m = $("#pm"); m.className = "msg"; m.textContent = "Saving…";
    const patch = { name: fd.get("name"), phone: fd.get("phone"), exp: +fd.get("exp"), current_location: fd.get("current_location"), skills: fd.get("skills"), alerts: !!fd.get("alerts") };
    const file = fd.get("resume");
    if (file && file.size) {
      if (file.size > 5 * 1024 * 1024) { m.textContent = "That file is over 5 MB."; return; }
      const ext = file.name.split(".").pop().toLowerCase(), path = `${session.user.id}/resume-${Date.now()}.${ext}`;
      const up = await sb.storage.from("resumes").upload(path, file, { contentType: file.type });
      if (up.error) { m.textContent = "Resume upload failed: " + up.error.message; return; }
      patch.resume_path = path;
    }
    const { error } = await sb.from("candidates").update(patch).eq("user_id", session.user.id);
    if (error) { m.textContent = error.message; return; }
    dlg.close(); await loadMe(); toast("Profile saved");
  };
  if (!dlg.open) dlg.showModal();
}
async function apply(id, btn) {
  if (!session) return authForm("signup");
  if (!me?.resume_path || me.exp == null) return openProfile(true);
  const j = jobs.find((x) => x.id === id);
  if (!eligible(j)) { toast(`This role needs ${j.exp_min}–${j.exp_max} years of experience.`); return; }
  btn.disabled = true;
  const { error } = await sb.from("applications").insert({ job_id: id, candidate_id: me.id });
  if (error) { btn.disabled = false; const msg = /duplicate/.test(error.message) ? "You've already applied." : error.message; ($("#applyMsg") || {}).textContent = msg; toast(msg); return; }
  toast("Application sent. Your resume goes to the company after the deadline.");
  await loadMe(); if (dlg.open) openJob(id);
}

// ───────── Events ─────────
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-apply]"); if (a) { e.stopPropagation(); return apply(a.dataset.apply, a); }
  const b = e.target.closest("[data-act]");
  if (b) {
    const act = b.dataset.act;
    if (act === "close") return dlg.close();
    if (act === "signin" || act === "signup") return authForm(act);
    if (act === "signout") { await sb.auth.signOut(); return loadMe(); }
    if (act === "profile") return openProfile();
    if (act === "filters") return $("#filters").classList.toggle("open");
    if (act === "share") { try { await navigator.clipboard.writeText(`${location.origin}${location.pathname}?job=${b.dataset.id}`); toast("Link copied"); } catch { toast("Copy blocked"); } return; }
    if (act === "reset") { const em = $("#af [name=email]").value; if (!em) return ($("#am").textContent = "Type your email first."); const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: location.origin + location.pathname }); $("#am").textContent = error ? error.message : "Password reset email sent."; return; }
    if (act === "clear") { document.querySelectorAll(".filters input[type=checkbox]").forEach((i) => (i.checked = false)); $("#fExp").value = -1; $("#fPkg").value = 0; $("#fClose").value = 0; $("#qText").value = ""; $("#qLoc").value = ""; expOut(); return render(); }
  }
  const card = e.target.closest("[data-job]"); if (card) openJob(card.dataset.job);
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches?.(".job")) openJob(e.target.dataset.job); });
$("#filters").addEventListener("input", (e) => { if (e.target.id === "fExp") expOut(); render(); });
$("#sort").onchange = render;
$("#search").onsubmit = (e) => { e.preventDefault(); render(); };
$("#qText").oninput = render; $("#qLoc").oninput = render;
dlg.addEventListener("close", () => { if (new URLSearchParams(location.search).has("job")) history.replaceState(null, "", location.pathname); });
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" || ev === "SIGNED_OUT") loadMe(); if (ev === "PASSWORD_RECOVERY") passwordReset(); });
function passwordReset() {
  body.innerHTML = `<h2>Set a new password</h2><form id="rf" class="grid"><label class="full">New password<input name="p" type="password" minlength="8" required></label><div><button class="pri">Save</button></div></form><p class="msg" id="rm"></p>`;
  $("#rf").onsubmit = async (e) => { e.preventDefault(); const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("p") }); if (error) $("#rm").textContent = error.message; else { dlg.close(); toast("Password updated"); } };
  if (!dlg.open) dlg.showModal();
}
setInterval(render, 30000);           // countdowns tick; closed jobs drop off
setInterval(loadJobs, 5 * 60000);     // pick up new openings
expOut(); await loadMe(); await loadJobs();
