# PaperLive Careers

Two websites and one automation backend for the PaperLive Learning placement cell.

| Site | Address | Who uses it |
|---|---|---|
| Careers | `careers.paperlive.in` | Candidates: browse jobs with filters, register, upload a resume, apply |
| Placement Desk | `admin.paperlive.in` | Placement team only: leads, jobs, applicants, candidates, emails, settings |

## How the automation works

Every 10 minutes the `automation` function runs these steps:

1. **LinkedIn job alerts become leads.** It reads LinkedIn job-alert emails in the placement Gmail inbox. AI pulls out each company, role, location and link, keeps the DevOps, multi-cloud, SRE and platform roles, and saves them as leads. Processed emails get the Gmail label `PaperLive/Processed`.
2. **Leads go to the Google Sheet.** New leads are added to your Google Sheet (the `Leads` tab).
3. **HR is emailed.** Any lead that has an HR email gets the outreach email from Settings. The function remembers the email thread.
4. **JD replies become jobs.** When HR replies on that thread, AI reads the reply and any PDF attached. If it is a JD, it creates the job and publishes it (or saves it as a draft if auto-publish is off). The deadline is set to the apply window from Settings, 20 hours by default. If HR says no, the lead is marked "Not interested".
   - Shortcut: drag any JD email in Gmail into the label `PaperLive/JD` and it is picked up the same way.
5. **Candidates get alerts.** Every candidate whose experience fits the job's range, with alerts turned on, gets an email with an "Apply" link to that job.
6. **At the deadline, resumes go to HR.** The job closes and disappears from the careers site. HR gets one email with a table of applicants and every resume attached (download links if the attachments total more than 18 MB). The team is copied on it.

What stays manual: adding the HR email to a lead, and calling HR for updates. You record interviews, offers and notes on each job in the admin portal.

> Why not scrape LinkedIn directly? LinkedIn's terms forbid bots on your account and it restricts accounts that use them. Job-alert emails give you the same leads with no risk to the PaperLive LinkedIn page.

## Folder layout

```
apps/careers/        candidate site (static: index.html, app.js, styles.css, config.js)
apps/admin/          placement desk (static, login required)
supabase/migrations/ database tables, security rules, resume storage
supabase/functions/automation/  the background automation (Deno)
scripts/             one-time helper to get the Google token
```

## Setup checklist

### 1. Supabase (project `paperlive-career`)
Already done: tables, security rules, resume storage, the `automation` function, and the 10-minute schedule. Both `config.js` files already point at the project.

1. (done)
2. **Auth → URL configuration:** set the Site URL to `https://careers.paperlive.in`. Add `https://careers.paperlive.in/**` and `https://admin.paperlive.in/**` as redirect URLs.
3. **Auth → SMTP:** turn on custom SMTP with the placement Gmail address. Use `smtp.gmail.com`, port 465, and a Google app password. Supabase's built-in mailer only sends a few sign-up emails an hour, so this is needed for candidates to register.
4. **Make yourself an admin.** Sign up once on the careers site with your work email, then run this in the SQL editor:
   ```sql
   insert into admins (user_id, email) select id, email from auth.users where email = 'you@paperlive.in';
   delete from candidates where lower(email) = 'you@paperlive.in';  -- optional: remove yourself from the candidate list
   ```

### 2. Google (Gmail + Sheets) for placement@paperlive.in
1. In Google Cloud Console, create a project and enable the **Gmail API** and the **Google Sheets API**.
2. Set up the OAuth consent screen as **Internal** (Workspace), then create an OAuth client of type **Desktop app**.
3. On your computer, run `node scripts/get-google-token.mjs CLIENT_ID CLIENT_SECRET`, signed in as the placement mailbox. Copy the refresh token it prints.
4. Create a Google Sheet with a tab called `Leads`. Add this header row: `Found, Company, Role, Location, Source, Link, HR name, HR email, Status`. Copy the sheet ID from its URL.
5. In LinkedIn, create job alerts for DevOps, multi-cloud, SRE, platform engineer and cloud engineer roles. Set them to **daily** and send them to the placement mailbox.

### 3. Function secrets (Supabase → Edge Functions → Secrets)
| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | from step 2 |
| `SENDER_EMAIL` | `placement@paperlive.in` |
| `SENDER_NAME` | `PaperLive Placement Team` |
| `ADMIN_NOTIFY_EMAIL` | address copied on resume emails and notices |
| `ANTHROPIC_API_KEY` | from console.anthropic.com (reads alerts and JDs) |
| `SHEET_ID` | the Google Sheet ID |
| `CAREERS_URL` / `ADMIN_URL` | `https://careers.paperlive.in` / `https://admin.paperlive.in` |

The schedule is already running. Until the Google secrets are added, each run just closes jobs whose deadline has passed and skips the email steps.

### 4. GitHub + Vercel
1. Push this folder to a new GitHub repo, for example `paperlive-careers`.
2. In Vercel, import the repo **twice**:
   - project `paperlive-careers` with root directory `apps/careers`;
   - project `paperlive-admin` with root directory `apps/admin`.
   Framework: Other. No build command.
3. Add domains: `careers.paperlive.in` to the first project and `admin.paperlive.in` to the second.
4. At your DNS provider for paperlive.in, add two CNAME records, `careers` and `admin`, both pointing to `cname.vercel-dns.com`.

Every push to GitHub redeploys both sites.

## Privacy and limits
- Candidates can only read live jobs and their own profile and applications. HR emails, leads, counts and other candidates are blocked by database rules, not just hidden in the page.
- Resumes are in a private storage bucket. Only the candidate and the placement team can open them, through links that expire.
- Gmail on Workspace sends up to 2,000 emails a day. The automation sends at most 150 candidate alerts per run and continues on the next run.
- Every candidate alert email explains how to turn alerts off (in the candidate's profile).
