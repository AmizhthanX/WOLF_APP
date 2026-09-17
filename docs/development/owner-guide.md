# Your to-do list, step by step

Everything in WOLF that only **you** can do — because it needs your accounts, your second PC, your
administrator password, or your decision — written as small steps you can follow one at a time.

Do the parts in order. Each part says how long it takes and what you need. You can stop after any part.

**How to read this guide**

- A grey box like this is something to type or paste:

  ```powershell
  echo hello
  ```

  Copy the **whole** box, paste it into the window named, press **Enter**, and wait until the blinking cursor comes
  back before the next step.
- *Italic text in angle brackets* like `<your-name>` means "replace this, including the `<` and `>`".
- **Never paste a password, key or secret into a chat, an issue, or a file inside `H:\WOLF_APP`.** The guide says
  where each one goes.

---

## Part 0 — Open the two windows you will use (2 minutes)

You need a **PowerShell window in the WOLF folder**. Most parts use it.

1. Press the **Windows key** on your keyboard.
2. Type `PowerShell`.
3. Click **Windows PowerShell** (not "ISE", not "Run as administrator" — only Part 7 needs that).
4. In the blue or black window that opens, paste this and press Enter:

   ```powershell
   cd H:\WOLF_APP
   ```

5. The line before the cursor should now end with `H:\WOLF_APP>`. Keep this window open.

---

## Part 1 — Finish the other session's unfinished work (already done)

**Nothing to do:** that session committed its files on its own (`Device-key browser test run in Firefox`), and the
roadmap has been updated. Kept here only in case it happens again with another session.

Another Claude session changed files and did not commit them. Until you decide, they sit there uncommitted.

1. In the PowerShell window, paste:

   ```powershell
   git status --short
   ```

2. You should see these four lines (maybe more if you changed things yourself):

   ```
    M docs/development/getting-started.md
    M docs/development/roadmap.md
    M services/e2e/browser/device-key.html
    M services/e2e/src/device-key-harness.ts
   ```

3. **Option A — keep them (recommended).** Open the Claude desktop app, find that session in the sidebar, and type:
   `commit your uncommitted changes`. Wait for it to finish.
4. **Option B — throw them away.** Only if you are sure. Paste:

   ```powershell
   git restore docs/development/getting-started.md docs/development/roadmap.md services/e2e/browser/device-key.html services/e2e/src/device-key-harness.ts
   ```

5. Run `git status --short` again. Those four lines should be gone.
6. Tell me "Part 1 done" in this chat, and I will update the roadmap, which I have been leaving alone.

---

## Part 2 — Try everything on this PC, with no accounts (20 minutes)

This runs the whole of WOLF on this computer: a pretend cloud, the dashboard, and the real agent.

### 2a. Start the local cloud

1. Open a **second** PowerShell window (Part 0, steps 1–4). Name in your head: **"cloud window"**.
2. Make a webhook key for this test and start the cloud — paste all four lines together:

   ```powershell
   cd H:\WOLF_APP
   $env:WOLF_WEBHOOK_KEY = node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   npm run build --workspaces --if-present
   npm run dev:cloud
   ```

3. Wait (the build takes a minute or two). When it is ready you will see a line containing
   **`Local cloud is up`**. Leave this window open. **Closing it stops the cloud and forgets everything.**

### 2b. Start the dashboard

1. Open a **third** PowerShell window. Name: **"web window"**.
2. Paste:

   ```powershell
   cd H:\WOLF_APP
   npm run dev:web
   ```

3. Wait for a line with **`Ready`** or `localhost:3000`.
4. Open your web browser (Chrome or Edge) and go to: **http://localhost:3000**
5. Sign in with:
   - Email: `owner@example.com`
   - Password: `a-long-local-passphrase`

   (These only exist in this pretend local cloud.)

6. **Stuck on "Restoring your session…"?** That was a bug in the dashboard's security settings, fixed on
   2026-09-17. In the web window press **Ctrl+C**, then paste `git pull` only if you use GitHub (otherwise skip it),
   and run `npm run dev:web` again. Then in the browser press **Ctrl+Shift+R** to reload without the old copy.
   Still stuck after 15 seconds? Press **F12**, click **Console**, and tell me the red lines.

### 2c. Connect this PC as a WOLF PC

1. In the dashboard, click **Add a PC**. A long **enrollment token** appears. Click it and copy it
   (Ctrl+C). It is shown only once.
2. Open a **fourth** PowerShell window. Name: **"agent window"**. Paste, replacing *`<paste-token-here>`* with
   the token (keep the quotes):

   ```powershell
   cd H:\WOLF_APP
   dotnet build windows\Wolf.sln -c Release
   $env:WOLF_ENROLLMENT_TOKEN = "<paste-token-here>"
   $env:Wolf__ApiBaseUrl = "http://127.0.0.1:8080"
   $env:Wolf__RealtimeUrl = "ws://127.0.0.1:8081/agent"
   $env:Wolf__DataDirectory = "$env:TEMP\wolf-local-agent"
   .\apps\windows-agent\Wolf.Agent.Host\bin\Release\net9.0-windows10.0.22621.0\Wolf.Agent.exe
   ```

3. Wait for **`Cloud link established`**. Go back to the browser and refresh: your PC shows **online**.

### 2d. Try the new file changes

1. Click your PC → the **Remote desktop** tab → **Start streaming**. You see your own screen (that is normal — it is this PC).
2. Scroll down to **Files** → **Ask for file access**.
3. Click **C:\\** → `Users` → `Public` → `Documents`.
4. Click **New folder**, type `wolf-try`, click **Make folder**.
5. Open `wolf-try`. Click **Send a file**, choose any small file on your computer.
6. Next to that file click **Rename**, type a new name, click **Rename**.
7. Click **Delete** → **Move to Recycle Bin**.
8. Open the **Recycle Bin** on your desktop: the file is there. Right-click it → **Restore** if you want it back.
9. Click the **Audit log** tab on the PC page: you will see `file.create-folder`, `file.upload`, `file.rename`,
   `file.delete` — and **no file names**. That is the privacy promise working.

### 2e. Try a webhook to your own Discord or Slack (optional)

**Discord** — you need a Discord server where you are an admin:

1. In Discord, hover over a text channel → click the **gear** (Edit Channel).
2. Click **Integrations** → **Webhooks** → **New Webhook**.
3. Click the new webhook → **Copy Webhook URL**.

**Slack** — you need a Slack workspace where you can add apps:

1. Go to **https://api.slack.com/apps** → **Create New App** → **From scratch**.
2. Name it `WOLF`, pick your workspace, **Create App**.
3. Left menu **Incoming Webhooks** → switch **Activate Incoming Webhooks** to **On**.
4. **Add New Webhook to Workspace** → pick a channel → **Allow**.
5. Click **Copy** next to the new Webhook URL.

**In WOLF:**

1. In the dashboard top bar click **Webhooks**.
2. **Name**: `My chat`. **Address**: paste the URL. **Sends to** changes to *Discord* or *Slack* by itself.
3. Click **Add webhook**. Type your password (`a-long-local-passphrase`) when asked.
4. A **signing secret** appears once. You do not need it for Discord or Slack — click **I have saved it**.
5. Click **Send a test**. Within a few seconds a message **"[Test] A test from WOLF"** appears in your channel.

Note: the local cloud only sends **tests**. Real alert messages need the full server (Part 8).

### 2f. Stop everything

In each of the cloud, web and agent windows, press **Ctrl+C**. If asked "Terminate batch job (Y/N)?", type `Y`
and Enter.

---

## Part 3 — Wake a sleeping PC (30 minutes, needs a second PC)

You need: a **second Windows PC** in the same home, connected with an **Ethernet cable** (Wi-Fi almost never
wakes). In these steps, **"main PC"** is this one, **"other PC"** is the second one.

### 3a. Let the other PC be woken (do this on the other PC)

1. **Firmware (BIOS/UEFI) setting.** Restart the other PC. While it starts, press the setup key — usually
   **Delete**, **F2**, **F10** or **F12** (the first screen usually says which). Look under **Power**,
   **Advanced** or **APM** for **Wake on LAN**, **Power On By PCI-E**, or **Resume by LAN**. Set it to
   **Enabled**. Choose **Save & Exit**. (If you cannot find it, continue — many PCs have it on already.)
2. When Windows is back: press **Windows key + X** → **Device Manager**.
3. Open **Network adapters** → double-click the adapter that is **not** Wi-Fi (for example "Realtek … GbE" or
   "Intel … Ethernet").
4. **Power Management** tab: tick **Allow this device to wake the computer** and **Only allow a magic packet to
   wake the computer**. Click **OK**.
5. Open it again → **Advanced** tab → find **Wake on Magic Packet** → set **Enabled** → **OK**.
6. Check Windows agrees: open PowerShell on the other PC and paste:

   ```powershell
   powercfg /devicequery wake_armed
   ```

   Your Ethernet adapter's name must be in the list.

### 3b. Let the other PC reach the local cloud (on the main PC)

1. Find the main PC's address: in PowerShell paste `ipconfig` and look under your Ethernet or Wi-Fi adapter for
   **IPv4 Address**, something like `192.168.1.23`. Write it down — here it is *`<main-ip>`*.
2. Start the cloud so the home network can reach it, with a password of your own instead of the default. In the
   cloud window:

   ```powershell
   cd H:\WOLF_APP
   $env:WOLF_LOCAL_HOST = "0.0.0.0"
   $env:WOLF_OWNER_PASSWORD = Read-Host "Choose an owner password for this test"
   npm run dev:cloud
   ```

   Type a password of **at least 12 characters** when asked (it shows as you type — nobody else is looking). If Windows asks **"Allow Node.js on networks?"**, tick
   **Private networks only** and click **Allow**.
3. Start the dashboard (Part 2b) and sign in with `owner@example.com` and the password you just chose.
4. Connect the **main PC** (Part 2c).

### 3c. Connect the other PC

1. On the main PC, copy the whole folder
   `H:\WOLF_APP\apps\windows-agent\Wolf.Agent.Host\bin\Release\net9.0-windows10.0.22621.0`
   to a USB stick.
2. On the other PC, copy it to `C:\WOLF-agent`.
3. On the other PC install the **.NET 9 Desktop Runtime (x64)** from **https://dotnet.microsoft.com/download/dotnet/9.0**
   if it is not installed.
4. In the dashboard click **Add a PC** again and copy the new token.
5. On the other PC, PowerShell, replacing both placeholders:

   ```powershell
   $env:WOLF_ENROLLMENT_TOKEN = "<paste-token-here>"
   $env:Wolf__ApiBaseUrl = "http://<main-ip>:8080"
   $env:Wolf__RealtimeUrl = "ws://<main-ip>:8081/agent"
   $env:Wolf__DataDirectory = "$env:TEMP\wolf-local-agent"
   C:\WOLF-agent\Wolf.Agent.exe
   ```

6. Wait for **`Cloud link established`**. In the dashboard, the other PC is online. On its **Overview** tab, in
   **Capabilities**, **Wake-on-LAN** should say available.

### 3d. Wake it

1. On the other PC: **Start** → **Power** → **Sleep**.
2. On the main PC's dashboard, wait until the other PC shows **offline** (up to a minute).
3. Open the other PC → **Power** tab → **Wake** panel → **Send from**: pick the main PC → **Wake** → **Confirm**.
4. The other PC should turn on within a few seconds, and show **online** once its agent reconnects.
5. It did not wake? Check 3a again (firmware setting and both Device Manager tabs), and that both PCs are on the
   same router. Tell me what the Wake panel said.

---

## Part 4 — Push notifications on your phone (30 minutes, needs a Google account)

WOLF's phone app is woken through Google's Firebase. I cannot create accounts, so you make the project.

### 4a. Create the Firebase project

1. Go to **https://console.firebase.google.com** and sign in with your Google account.
2. Click **Create a project** (or **Add project**).
3. Name: `wolf` → **Continue**. Turn **Google Analytics off** → **Create project**. Wait, then **Continue**.

### 4b. Register the Android app

1. On the project page click the **Android** icon (**Add app**).
2. **Android package name**: exactly `app.amizhthan.wolf`.
3. Nickname: `WOLF`. Leave the SHA-1 empty. Click **Register app**.
4. Click **Download google-services.json**. Save it to your **Downloads** folder — **not** inside `H:\WOLF_APP`.
5. Click **Next**, **Next**, **Continue to console** (skip the SDK instructions; WOLF is already set up).

### 4c. Give the app its four Firebase values

1. Open `Downloads\google-services.json` with **Notepad** (right-click → Open with → Notepad).
2. Find these four values:

   | In the file | Copy the text after it |
   | --- | --- |
   | `"mobilesdk_app_id":` | something like `1:1234567890:android:abc123…` |
   | `"project_id":` | something like `wolf-1a2b3` |
   | `"current_key":` | something like `AIzaSy…` |
   | `"project_number":` | only digits, like `1234567890` |

3. Open `H:\WOLF_APP\apps\android\local.properties` in Notepad (it is ignored by git, so it never gets committed).
4. Add these four lines at the bottom, with your values, **no quotes**:

   ```
   wolf.firebase.applicationId=<mobilesdk_app_id value>
   wolf.firebase.projectId=<project_id value>
   wolf.firebase.apiKey=<current_key value>
   wolf.firebase.senderId=<project_number value>
   ```

5. **File** → **Save**. Close Notepad.

### 4d. Let the server send wake-ups

1. In the Firebase console click the **gear** next to *Project Overview* → **Project settings**.
2. **Service accounts** tab → **Generate new private key** → **Generate key**. A `.json` file downloads.
3. Make a private folder outside the project, and move the file there. In PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force C:\WOLF-secrets
   Move-Item "$env:USERPROFILE\Downloads\wolf-*-firebase-adminsdk-*.json" C:\WOLF-secrets\fcm.json
   ```

   (If the move says "cannot find", open Downloads, find the newest `.json` with `firebase-adminsdk` in its name,
   and move it to `C:\WOLF-secrets` renamed `fcm.json` by hand.)
4. **This file is a password.** Never email it, never put it in `H:\WOLF_APP`.

### 4e. Try it

1. In the cloud window, before `npm run dev:cloud`, add three lines (replace the project id):

   ```powershell
   $env:WOLF_PUSH_PROVIDER = "fcm"
   $env:WOLF_FCM_PROJECT_ID = "<project_id value>"
   $env:WOLF_FCM_CREDENTIALS_FILE = "C:\WOLF-secrets\fcm.json"
   npm run dev:cloud
   ```

2. Tell me "Part 4 done". I will build the app with your Firebase values and run the push test on the emulator
   (I will not need to see any of the values).

---

## Part 5 — Put the code on GitHub (15 minutes, needs a GitHub account)

This repository has **no GitHub remote yet**, so CI and the release pipeline have never run.

1. Go to **https://github.com/new** and sign in.
2. **Repository name**: `WOLF`. Choose **Private**. Do **not** tick "Add a README" or anything else.
   Click **Create repository**.
3. On the next page, copy the HTTPS address shown, like `https://github.com/<you>/WOLF.git`.
4. In PowerShell (replace the address):

   ```powershell
   cd H:\WOLF_APP
   git remote add origin https://github.com/<you>/WOLF.git
   git push -u origin main
   ```

5. A GitHub sign-in window appears. Choose **Sign in with your browser** and approve.
6. Refresh the GitHub page: your code is there. Click the **Actions** tab: the **CI** workflow starts by itself.
   A green tick after ~15 minutes means everything builds and passes on GitHub too. A red cross: click it, and
   paste me the name of the failed step.

---

## Part 6 — A signed Android release (20 minutes, after Part 5)

### 6a. Make your upload key (once, and keep it forever)

1. Paste in PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force C:\WOLF-secrets
   & "C:\Program Files\JetBrains\PyCharm 2026.2.1\jbr\bin\keytool.exe" -genkeypair -v -keystore C:\WOLF-secrets\wolf-upload.jks -alias wolf-upload -keyalg RSA -keysize 4096 -validity 10000
   ```

2. It asks for a **keystore password**: type a long new password, Enter, type it again. (Nothing shows while you
   type — that is normal.)
3. It asks your name, organisation, city, country: answer or press Enter to skip. Type `yes` to confirm.
4. If it asks for a **key password**, press **Enter** to use the same password.
5. **Back up `C:\WOLF-secrets\wolf-upload.jks` and the password** somewhere safe (a password manager and a USB
   stick). Losing them means you cannot update the app for anyone who installed it.

### 6b. Give GitHub the key, without it ever entering the code

1. Copy the key as text to your clipboard:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\WOLF-secrets\wolf-upload.jks")) | Set-Clipboard
   ```

2. On GitHub, open your WOLF repository → **Settings** → left menu **Environments** → **New environment**.
3. Name: exactly `android-release` → **Configure environment**.
4. Under **Environment secrets** click **Add environment secret** four times:

   | Name | Value |
   | --- | --- |
   | `WOLF_ANDROID_KEYSTORE_BASE64` | press **Ctrl+V** (the long text from step 1) |
   | `WOLF_ANDROID_KEYSTORE_PASSWORD` | your keystore password |
   | `WOLF_ANDROID_KEY_ALIAS` | `wolf-upload` |
   | `WOLF_ANDROID_KEY_PASSWORD` | the same password (unless you chose a different key password) |

5. Optional, if you did Part 4 — under **Environment variables** click **Add environment variable** four times:
   `WOLF_FIREBASE_APPLICATION_ID`, `WOLF_FIREBASE_PROJECT_ID`, `WOLF_FIREBASE_API_KEY`, `WOLF_FIREBASE_SENDER_ID`,
   with the same four values as in Part 4c.
6. Clear your clipboard: copy any ordinary word.

### 6c. Publish version 0.1.0

1. In PowerShell:

   ```powershell
   cd H:\WOLF_APP
   git tag android-v0.1.0
   git push origin android-v0.1.0
   ```

2. GitHub → **Actions** → **Android release** is running. Wait for the green tick.
3. GitHub → **Releases** (right side of the repository page) → **android-v0.1.0**. It lists the APK, its
   **SHA-256**, and the **signing certificate fingerprint**.
4. Check the fingerprint is yours:

   ```powershell
   & "C:\Program Files\JetBrains\PyCharm 2026.2.1\jbr\bin\keytool.exe" -list -v -keystore C:\WOLF-secrets\wolf-upload.jks -alias wolf-upload
   ```

   Type the keystore password. The **SHA256** line must match the release page.

---

## Part 7 — The tests that need administrator (10 minutes)

Two tests change real Windows settings, so they only run when you allow it. They are safe: one stops and starts
the **Print Spooler**, the other turns one scheduled task off and back on.

1. Press the **Windows key**, type `PowerShell`, **right-click** Windows PowerShell → **Run as administrator**
   → **Yes**.
2. Paste:

   ```powershell
   cd H:\WOLF_APP
   $env:WOLF_TEST_SERVICE_CONTROL = "1"
   dotnet test windows\Wolf.sln --filter "FullyQualifiedName~ServiceProtectionTests"
   ```

3. Wait for **`Passed!`**. (During it, printing is unavailable for a second.)
4. Then:

   ```powershell
   $env:WOLF_TEST_AUTORUN_CONTROL = "1"
   dotnet test windows\Wolf.sln --filter "FullyQualifiedName~AutorunTests"
   ```

5. Wait for **`Passed!`**. Close the window.
6. Paste me both final lines (`Passed!` or `Failed!` with the numbers).

---

## Part 8 — Put WOLF on the internet (later; needs a decision from you)

The real deployment to Google Cloud is **not built yet**, because this PC has none of the tools it needs
(Terraform, Docker, the Google Cloud CLI). To go ahead:

1. Decide: **Google Cloud** (what WOLF was designed for) — this will cost money monthly once running.
2. Create a Google Cloud account at **https://console.cloud.google.com** and turn on billing.
3. Install the tools — in an **administrator** PowerShell:

   ```powershell
   winget install Google.CloudSDK
   winget install Hashicorp.Terraform
   winget install Docker.DockerDesktop
   ```

   Restart the PC after Docker Desktop installs, and open Docker Desktop once to finish its setup.
4. Tell me "Part 8 tools installed". I will write the infrastructure and deployment, and walk you through
   `gcloud auth login` and the first deploy.

When it runs, the server needs these from **Google Secret Manager** (never in files):

| Secret | Make it with |
| --- | --- |
| `WOLF_TOKEN_SECRET` | `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` |
| `WOLF_WEBHOOK_KEY` | the same command, run again (a different value) |
| `WOLF_FCM_CREDENTIALS_FILE` | the `fcm.json` from Part 4d, as a mounted secret file |

---

## Part 9 — One more hardware check (5 minutes, needs two monitors)

1. Connect a second monitor to this PC.
2. Start everything as in Part 2, open **Remote desktop**, click **Refresh** in the **Displays** panel, then **Start streaming**.
3. In the **Display** list above the picture, choose the other monitor.
4. The picture should change to that monitor within a couple of seconds. Tell me whether it did.

---

## Optional — connectors in Claude

Some design tools (Asana, Atlassian, Figma, Intercom, Linear, Notion, Slack) are not connected to Claude. WOLF
does not need them. If you want them: claude.ai → **Settings** → **Connectors** → connect the ones you use.

---

## What to tell me when you are done

Just the part numbers, e.g. **"Parts 1, 2 and 7 done"**, plus anything that did not look like the guide said.
Never paste passwords, keys, tokens, `google-services.json` or `fcm.json` into the chat.
