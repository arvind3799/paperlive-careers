// One-time: get a Google refresh token for placement@paperlive.in (Gmail + Sheets).
// Run on your own computer:  node scripts/get-google-token.mjs <CLIENT_ID> <CLIENT_SECRET>
// A browser opens; sign in as the placement mailbox and allow access. The refresh token prints here.
import http from "node:http";
import { exec } from "node:child_process";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) { console.log("Usage: node scripts/get-google-token.mjs <CLIENT_ID> <CLIENT_SECRET>"); process.exit(1); }
const redirect = "http://localhost:8765/callback";
const scopes = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/spreadsheets"];
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent", scope: scopes.join(" ") });

http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("No code"); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code" }) });
  const j = await r.json();
  res.end(j.refresh_token ? "Done. Go back to the terminal." : "Failed: " + JSON.stringify(j));
  console.log(j.refresh_token ? `\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n` : j);
  process.exit(0);
}).listen(8765, () => {
  console.log("Opening Google sign-in. If it doesn't open, visit:\n" + url);
  exec(`${process.platform === "win32" ? "start \"\"" : process.platform === "darwin" ? "open" : "xdg-open"} "${url}"`);
});
