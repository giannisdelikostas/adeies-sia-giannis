# Άδειες v2

A shared leave tracker for the two of you, synced between both phones.

- Counts **working days only**: weekends and every Greek public holiday are skipped automatically, including the Easter-based ones (Καθαρά Δευτέρα, Μ. Παρασκευή, Δευτέρα του Πάσχα, Αγίου Πνεύματος).
- Settings per person: work days (5- or 6-day week), which holidays apply to them, and extra local holidays (e.g. 26/10 Αγίου Δημητρίου).
- Allowance per year, with carry-over from the previous year (worked out automatically).
- Leave types: Κανονική (counts against the allowance), Ασθένεια, Ειδική, Άνευ αποδοχών. Half days are supported.
- **Μαζί** tab: when you are both free together, shared leaves, and **bridges** (γέφυρες) that show what each of you would need to take.
- Calendar view, upcoming/past lists, countdown, warnings for overlaps or going over the allowance, undo on delete.
- Export to Google/Apple Calendar (.ics), JSON backup, and a one-click import from the old version.
- Installable app on the phone (PWA), dark mode, Greek throughout.

No build step: plain HTML/CSS/JS plus Supabase.

---

## Setup (about 10 minutes)

### 1. Supabase project
The free plan allows **2 active projects**. If your other app uses one, create a second one here: supabase.com → New project (region: Frankfurt).

> If both slots are taken, you can put these tables in your existing project instead. The table names (`people`, `leaves`, `allowances`, `extra_holidays`) must not already exist there.

### 2. Create the tables
1. Open `supabase/schema.sql` and **change the two e-mails and names** in the last lines.
2. Supabase → **SQL Editor** → New query → paste the whole file → **Run**.

### 3. Create the two logins
1. Supabase → **Authentication → Users → Add user → Create new user**. Enter each e-mail with a password and tick **Auto Confirm User**. Do this twice.
2. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up".
   (Even if someone signs up, they can't see anything, because only the e-mails in `people` have access.)

### 4. Connect the app
Supabase → **Project Settings → API Keys**: copy the **Project URL** and the **anon / publishable** key into `config.js`:

```js
export const SUPABASE_URL = 'https://xxxx.supabase.co';
export const SUPABASE_KEY = 'eyJ...';   // or sb_publishable_...
```
This key is meant to be public. Security comes from Row Level Security in the database.

### 5. Deploy (same Vercel project = same URL)
Replace the files in the existing GitHub repo `adeies-sia-giannis` with the contents of this folder and push. Vercel will redeploy at **adeies-sia-giannis.vercel.app**.

- **Keep-alive:** `vercel.json` adds a daily Cron (free on Hobby) that calls `/api/keepalive`. This way Supabase never sees a week without activity and won't pause the project.
- After deploying, check: Vercel → Project → Settings → Cron Jobs.

### 6. Old data
Open the new version **in the same browser where you used the old one**. Go to Ρυθμίσεις → "Δεδομένα από την παλιά έκδοση", choose which slot belongs to whom, then tap Εισαγωγή. Days are recalculated as working days, and entries without dates are skipped.

### 7. On your phones
- iPhone: Safari → Share → **Add to Home Screen**
- Android: Chrome → menu → **Install app**

---

## Local preview / demo
```bash
python3 -m http.server 8000      # → http://localhost:8000
```
If `config.js` is empty, or you add `?demo` to the URL, the app runs in **demo mode** with sample data stored only in the browser.

Logic tests (holidays, Easter, working days, bridges, .ics):
```bash
npm test
```

## Notes
- **Πρωτομαγιά:** when it falls during Easter week, the government moves it. In that case, turn it off for that person (Ρυθμίσεις → Αργίες που ισχύουν) and add the new date as an extra holiday.
- **Αγίου Πνεύματος** isn't a mandatory day off for many private-sector employees. Turn it off for whoever works that day.
- Easter is calculated correctly for 1900–2099.

## Files
```
index.html            app shell
styles.css            design (light/dark)
config.js             Supabase URL + key
js/app.js             UI
js/lib.js             pure logic (holidays, working days, bridges, .ics) — tested
js/store.js           Supabase + demo storage
api/keepalive.js      daily ping (Vercel Cron)
supabase/schema.sql   tables + security
fonts/                Commissioner + Noto Serif Display (Greek, OFL)
tests/lib.test.mjs    unit tests
```
