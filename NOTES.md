# LH irrigation

Replaces the Google Sheet "LH irrigation restrictions". Started 17 October 2026.

- Page: https://juanignacioituarte-prog.github.io/lhirrigation/
- Repo: https://github.com/juanignacioituarte-prog/lhirrigation (folder `C:\dev\lhirrigation`)
- Data: Google Sheet "LH irrigation"
  https://docs.google.com/spreadsheets/d/1i3XZwT1GNVvyjZr7K_rNajXh8GZDNedHiLFM5e_nlxw
- Script: bound to that sheet. https://script.google.com/d/1dLwDJx5_U-AE9fCj78x5eT2ETtLtFedFzR-S0u4ShmUoi4MXIix4bAxC/edit

## Files

| File | What |
|---|---|
| `index.html` | The page. One file |
| `Code.js` | The Apps Script. Change `SCRIPT_VERSION` on every change |
| `appsscript.json` | Script settings (web app: execute as me, anyone) |
| `deploy.sh` | `sh /c/dev/lhirrigation/deploy.sh` sends `Code.js` live, same URL |
| `.clasp.json`, `.claspignore` | clasp settings (only Code.js and appsscript.json are pushed) |

## Who can use it

Google sign-in. The page gets a Google ID token and sends it with every call.
The script asks Google if the token is real and made for our client ID, then
looks for the email in the **users** tab (column A, any case). Not on the list =
no access. Take a row out and that person is out straight away.

**Admins** (Admin = TRUE in the users tab): Juani and Colm (Juani, 17 Oct 2026).
Admins see a Users button at the top and can add or remove users there. A user
added from the page is never an admin; tick Admin in the sheet for that. An
admin can only be removed in the sheet.

## Tabs in the sheet

| Tab | Columns |
|---|---|
| users | Email, Name (shows in the "changed by" notes), Admin (TRUE/FALSE) |
| consents | Key (big/small), Name, Volume m3 (not restricted, per day) |
| groups | Consent, Group (farm), Share % |
| pivots | Id, Consent, Group, Pivot, l/s, On, Hours |
| settings | restr (allowed % today), plan_by, plan_at, config_by, config_at |
| log | Time, Email, Action (plan / config), Details (JSON) - every change |

The tabs are made with the starting numbers the first time the script runs.

## How the page works

- Big consent / Small consent: ticks, hours and the allowed % save by themselves
  1.5 s after the last change. Only the pivots you changed are sent.
- Config: not restricted volume, share % for each farm, pivot names and l/s,
  add or remove pivots. Saved only with "Save config". Shares must add to 100%.
- Each view shows a note: last changed by name, date and time.
- The restriction cuts only the daily volume, not the flow. The flow limit
  stays the full consent (400 l/s big, 232.5 l/s small).
- ECan data cannot load by itself (Incapsula bot wall, no CORS). The allowed %
  is typed by hand from Band 11: HWRRP A-Block.

## One-time Google setup

1. Approve the script: open the script link above, pick `setup`, press Run,
   accept. After that the web app answers.
2. Google sign-in client ID: Google Cloud console > APIs & Services >
   Credentials > Create credentials > OAuth client ID > Web application.
   Authorized JavaScript origins: `https://juanignacioituarte-prog.github.io`.
   Put the client ID in `CLIENT_ID` in both `index.html` and `Code.js`, then
   deploy the script and push the page.
