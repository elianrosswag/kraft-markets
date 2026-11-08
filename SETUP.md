# Putting markets.elian.ink live (free, about 15 minutes)

## 1. Create the repo
GitHub → **New repository** → name `markets` → **Public** (Actions and Pages are free for public repos) → **Create repository**.

## 2. Upload the files
Click **uploading an existing file** and drag in: `index.html`, `README.md`, `CNAME`, and the `assets` and `collector` folders. (`collector` now contains two scripts: `collect.py` for market data and `news.py` for the Wire.) Then click **Commit changes**.

The workflow lives in a hidden folder (`.github`), so create it by hand:
**Add file → Create new file**, type the name `.github/workflows/collect.yml` (the slashes create the folders), paste in the contents of the **collect.yml** I sent you, then click **Commit changes**.

## 3. Switch Pages to "GitHub Actions"
**Settings → Pages → Build and deployment → Source: GitHub Actions.**
This is different from your elian.ink repo: here the workflow publishes the site itself, so it can update every 15 minutes.

## 4. Run the collector once
**Actions** tab → if asked, click *I understand… enable them* → choose **collect** → **Run workflow**.
It takes about a minute. Click into the run to watch each step and the `ok` / `FAIL` line for every source. That log is your backend's console.

## 5. Custom domain
Namecheap → elian.ink → **Advanced DNS → Add New Record**:

| Type | Host | Value |
|---|---|---|
| CNAME Record | `markets` | `elianrosswag.github.io.` |

Then in GitHub **Settings → Pages → Custom domain**, enter `markets.elian.ink` → **Save**. Once the certificate has been issued (up to an hour; you'll briefly see the same privacy warning as before), tick **Enforce HTTPS**.

Your other records (`@`, `www`, `gym`) stay as they are.

## 6. Check it
- `https://markets.elian.ink` shows the dashboard
- `https://markets.elian.ink/data/cyd.json` returns the small JSON the desk display will read
- The **Sources** section at the bottom shows which APIs are healthy

## Optional: Surf API key
Without a key, the Wire uses Surf's free tier (30 credits a day per IP; the collector uses about 24). To use your own key instead: **Settings → Secrets and variables → Actions → New repository secret**, name it `SURF_API_KEY` and paste the key. Secrets are encrypted and never shown in logs or on the site.
