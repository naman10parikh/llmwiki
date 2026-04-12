# OAuth App Registration Guide

**Audience:** You (the WikiMem maintainer). You do this ONCE per platform. After that, every WikiMem user just clicks Connect, sees a consent screen, clicks Allow, and they're done. Their tokens are saved locally in `.wikimem/tokens.json` on their own machine. No server, no database, no user management.

---

## Status

| Platform | Status | Time Needed | Difficulty |
|----------|--------|-------------|------------|
| GitHub   | DONE   | -           | -          |
| Google   | TODO   | 5 min       | Easy       |
| Slack    | TODO   | 3 min       | Easy       |
| Linear   | TODO   | 2 min       | Easy       |
| Jira     | TODO   | 3 min       | Easy       |

---

## How It Works (For Users)

This is what happens from the user's perspective after you register the apps:

1. User runs `wikimem serve` (starts the local web UI on port 3456)
2. User clicks "Connect GitHub" (or any provider) in the sidebar
3. **For GitHub:** A device code appears (e.g. `ABCD-1234`). User goes to github.com/login/device, pastes the code, clicks "Authorize WikiMem". Done.
4. **For Google, Slack, Linear, Jira:** Browser opens the provider's consent screen. User clicks "Allow". Browser redirects to `localhost:3456/api/auth/callback`. Done.
5. Token is saved locally in `.wikimem/tokens.json` (in the user's wiki directory)
6. Auto-sync begins pulling their data (repos, emails, messages, issues, etc.)
7. Their data stays on THEIR machine. WikiMem is a local CLI tool. Nothing is transmitted to any server.

The OAuth app credentials (client_id / client_secret) are bundled in the npm package. This is the same pattern used by GitHub CLI (`gh`), Google Cloud CLI (`gcloud`), VS Code, and Claude Desktop. The credentials identify the *app* (WikiMem), not the *user*.

---

## Security & Privacy

- **Tokens stored locally, never transmitted.** `.wikimem/tokens.json` lives in the user's wiki directory on their machine. WikiMem has no backend server.
- **WikiMem is open source.** Users can audit every line of code at [github.com/naman10parikh/llmwiki](https://github.com/naman10parikh/llmwiki).
- **Users can disconnect any time.** `DELETE /api/auth/tokens/:provider` via the web UI, or delete the token from `.wikimem/tokens.json` manually.
- **Read-only access only.** Every OAuth app requests the minimum scopes needed. No write permissions. WikiMem reads data, it never modifies it.
- **Client secrets in CLI/desktop apps are "non-confidential."** Google's documentation explicitly states this for "Desktop" application types. GitHub Device Flow doesn't even require a secret. Slack, Linear, and Jira follow the same pattern used by every CLI tool that ships OAuth credentials. This is industry standard.
- **Users can override with their own credentials.** Set `WIKIMEM_GITHUB_CLIENT_ID`, `WIKIMEM_GOOGLE_CLIENT_ID`, etc. as environment variables. These always take priority over bundled defaults.

---

## Where Credentials Go

All credentials are pasted into one file:

```
src/core/oauth-defaults.ts
```

Specifically, into the `BUNDLED` object starting at line 31. Each provider has a block with commented-out `credentials` that you uncomment and fill in.

---

## 1. GitHub (DONE)

**Status: DONE. Client ID is `Ov23liPXlZFPixXov4vx`. No action needed.**

This is documented here for reference in case you ever need to recreate it.

### What was done

1. Went to **https://github.com/settings/developers**
2. Clicked **"New OAuth App"**
3. Filled in:
   - **Application name:** `WikiMem`
   - **Homepage URL:** `https://github.com/naman10parikh/wikimem`
   - **Authorization callback URL:** `http://localhost:3456/api/auth/callback`
4. Checked **"Enable Device Flow"** (this is the checkbox below the callback URL field)
5. Clicked **"Register application"**
6. Copied the **Client ID** from the top of the app page: `Ov23liPXlZFPixXov4vx`
7. Pasted it into `src/core/oauth-defaults.ts` line 39:
   ```typescript
   deviceFlowClientId: 'Ov23liPXlZFPixXov4vx',
   ```

**Note:** GitHub Device Flow only needs a Client ID. No Client Secret required. That's why the GitHub block only has `deviceFlowClientId` and no `credentials` object.

---

## 2. Google (Gmail + Google Drive)

### Step 1: Go to Google Cloud Console

Open: **https://console.cloud.google.com/apis/credentials**

If you don't have a Google Cloud project yet, it will prompt you to create one. If it does:
- Click **"Create Project"**
- Project name: `WikiMem`
- Organization: leave as "No organization"
- Click **"Create"**

If you already have a project, make sure it's selected in the project dropdown at the top-left of the page.

### Step 2: Enable the APIs

1. In the left sidebar, click **"Enabled APIs & services"** (or go to **https://console.cloud.google.com/apis/library**)
2. Search for **"Gmail API"**
3. Click on **"Gmail API"** in the results
4. Click the blue **"Enable"** button
5. Go back to the API Library (click the back arrow or go to **https://console.cloud.google.com/apis/library** again)
6. Search for **"Google Drive API"**
7. Click on **"Google Drive API"** in the results
8. Click the blue **"Enable"** button

### Step 3: Configure the OAuth Consent Screen

1. In the left sidebar, click **"OAuth consent screen"** (or go to **https://console.cloud.google.com/apis/credentials/consent**)
2. Select **"External"** as the User Type (this lets any Google user connect, not just your organization)
3. Click **"Create"**
4. Fill in the form:
   - **App name:** `WikiMem`
   - **User support email:** select your email from the dropdown
   - **App logo:** skip (optional)
   - Scroll down to **"Developer contact information"**
   - **Email addresses:** enter your email (e.g. `naman@example.com`)
5. Click **"Save and Continue"**
6. On the **Scopes** page:
   - Click **"Add or Remove Scopes"**
   - In the filter box, search for `gmail.readonly`
   - Check the box next to **`https://www.googleapis.com/auth/gmail.readonly`** ("View your email messages and settings")
   - Search for `drive.readonly`
   - Check the box next to **`https://www.googleapis.com/auth/drive.readonly`** ("See and download all your Google Drive files")
   - Click **"Update"** at the bottom of the panel
   - Click **"Save and Continue"**
7. On the **Test users** page:
   - Click **"+ Add Users"**
   - Enter your email address
   - Click **"Add"**
   - Click **"Save and Continue"**
8. Review the summary and click **"Back to Dashboard"**

**Important:** While the app is in "Testing" status, only the test users you added can authorize it. This is fine for development. To let anyone use it, you'd submit for Google's verification review later (after WikiMem has a privacy policy page).

### Step 4: Create the OAuth Client ID

1. In the left sidebar, click **"Credentials"** (or go to **https://console.cloud.google.com/apis/credentials**)
2. Click **"+ Create Credentials"** at the top
3. Select **"OAuth client ID"**
4. **Application type:** select **"Desktop app"** from the dropdown

   > **IMPORTANT:** Choose "Desktop app", NOT "Web application". Desktop app type means:
   > - The client_secret is considered non-confidential (safe to ship in code)
   > - The redirect works with localhost without HTTPS
   > - This is the same type used by `gcloud`, `gh`, and other CLI tools

5. **Name:** `WikiMem Desktop`
6. Click **"Create"**

### Step 5: Copy the credentials

A dialog appears with your credentials:

- **Client ID** — looks like: `123456789-abcdefg.apps.googleusercontent.com`
- **Client Secret** — looks like: `GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz`

Copy both values.

### Step 6: Paste into the code

Open `src/core/oauth-defaults.ts` and find the `google` block (around line 41-50). Replace the commented-out credentials:

**Before:**
```typescript
google: {
  // Google OAuth — "Desktop" application type
  // Register: https://console.cloud.google.com/apis/credentials
  // Application type: Desktop app (secret is non-confidential for desktop apps)
  // Enable: Gmail API, Google Drive API
  // credentials: {
  //   clientId: '...apps.googleusercontent.com',
  //   clientSecret: 'GOCSPX-...',
  // },
},
```

**After:**
```typescript
google: {
  // Google OAuth — "Desktop" application type
  // Register: https://console.cloud.google.com/apis/credentials
  // Application type: Desktop app (secret is non-confidential for desktop apps)
  // Enable: Gmail API, Google Drive API
  credentials: {
    clientId: 'YOUR_ID.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-YOUR_SECRET',
  },
},
```

Replace `YOUR_ID.apps.googleusercontent.com` and `GOCSPX-YOUR_SECRET` with the actual values you copied.

---

## 3. Slack

### Step 1: Create a new Slack app

Open: **https://api.slack.com/apps**

1. Click the green **"Create New App"** button
2. Select **"From scratch"** (not "From an app manifest")
3. Fill in:
   - **App Name:** `WikiMem`
   - **Pick a workspace to develop your app in:** select your Slack workspace from the dropdown (any workspace you're an admin of works, this is just for development)
4. Click **"Create App"**

### Step 2: Configure OAuth scopes

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to the **"Scopes"** section
3. Under **"Bot Token Scopes"**, click **"Add an OAuth Scope"** three times, adding:
   - `channels:history` (View messages and other content in public channels)
   - `channels:read` (View basic information about public channels in a workspace)
   - `users:read` (View people in a workspace)
4. Scroll up to **"Redirect URLs"**
5. Click **"Add New Redirect URL"**
6. Enter: `http://localhost:3456/api/auth/callback`
7. Click **"Add"**
8. Click **"Save URLs"**

### Step 3: Copy the credentials

1. In the left sidebar, click **"Basic Information"**
2. Scroll down to **"App Credentials"**
3. Copy:
   - **Client ID** — a numeric string like `1234567890.1234567890`
   - **Client Secret** — a hex string like `abcdef1234567890abcdef1234567890`
   - (Click "Show" next to Client Secret to reveal it)

### Step 4: Paste into the code

Open `src/core/oauth-defaults.ts` and find the `slack` block (around line 51-57). Replace the commented-out credentials:

**Before:**
```typescript
slack: {
  // Slack App
  // Register: https://api.slack.com/apps → Create New App → From scratch
  // OAuth & Permissions → scopes: channels:history, channels:read, users:read
  // Redirect URL: http://localhost:3456/api/auth/callback
  // credentials: { clientId: '...', clientSecret: '...' },
},
```

**After:**
```typescript
slack: {
  // Slack App
  // Register: https://api.slack.com/apps → Create New App → From scratch
  // OAuth & Permissions → scopes: channels:history, channels:read, users:read
  // Redirect URL: http://localhost:3456/api/auth/callback
  credentials: {
    clientId: 'YOUR_SLACK_CLIENT_ID',
    clientSecret: 'YOUR_SLACK_CLIENT_SECRET',
  },
},
```

Replace `YOUR_SLACK_CLIENT_ID` and `YOUR_SLACK_CLIENT_SECRET` with the actual values.

---

## 4. Linear

### Step 1: Create a new OAuth application

Open: **https://linear.app/settings/api**

1. Scroll down to the **"OAuth Applications"** section (below "Personal API keys")
2. Click **"Create new"** (or "New OAuth Application")
3. Fill in:
   - **Application name:** `WikiMem`
   - **Callback URL:** `http://localhost:3456/api/auth/callback`
   - **Description:** (optional) `Open-source LLM knowledge base — reads Linear issues for your personal wiki`
4. Click **"Create"**

### Step 2: Copy the credentials

After creating, you'll see:

- **Client ID** — a UUID like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- **Client Secret** — a long random string (shown only once, copy it now)

**Copy both values immediately.** The Client Secret is only shown once. If you lose it, you'll need to regenerate it.

### Step 3: Paste into the code

Open `src/core/oauth-defaults.ts` and find the `linear` block (around line 58-63). Replace the commented-out credentials:

**Before:**
```typescript
linear: {
  // Linear OAuth App
  // Register: https://linear.app/settings/api → OAuth Applications → Create new
  // Callback URL: http://localhost:3456/api/auth/callback
  // credentials: { clientId: '...', clientSecret: '...' },
},
```

**After:**
```typescript
linear: {
  // Linear OAuth App
  // Register: https://linear.app/settings/api → OAuth Applications → Create new
  // Callback URL: http://localhost:3456/api/auth/callback
  credentials: {
    clientId: 'YOUR_LINEAR_CLIENT_ID',
    clientSecret: 'YOUR_LINEAR_CLIENT_SECRET',
  },
},
```

Replace `YOUR_LINEAR_CLIENT_ID` and `YOUR_LINEAR_CLIENT_SECRET` with the actual values.

---

## 5. Jira (Atlassian)

### Step 1: Create a new OAuth 2.0 integration

Open: **https://developer.atlassian.com/console/myapps/**

1. Click **"Create"** at the top-right
2. Select **"OAuth 2.0 integration"** (not "Forge app" or "Connect app")
3. Fill in:
   - **Name:** `WikiMem`
4. Check **"I agree to the developer terms"**
5. Click **"Create"**

### Step 2: Configure the callback URL

1. In the left sidebar, click **"Authorization"**
2. Next to **"OAuth 2.0 (3LO)"**, click **"Add"** (or "Configure")
3. Set the **Callback URL:** `http://localhost:3456/api/auth/callback`
4. Click **"Save changes"**

### Step 3: Configure permissions (scopes)

1. In the left sidebar, click **"Permissions"**
2. Find **"Jira API"** and click **"Add"** (or "Configure")
3. Under **"Classic scopes"**, enable:
   - `read:jira-work` (Read Jira project and issue data)
   - `read:jira-user` (Read Jira user information)
4. Under **"Granular scopes"** (if shown), also look for:
   - `offline_access` (Maintain access to your data — needed for refresh tokens)
5. Click **"Save"**

### Step 4: Copy the credentials

1. In the left sidebar, click **"Settings"**
2. Copy:
   - **Client ID** — a long alphanumeric string
   - **Secret** — click **"Create new secret"** if none exists, then copy the value

**Copy the secret immediately.** Atlassian only shows it once.

### Step 5: Paste into the code

Open `src/core/oauth-defaults.ts` and find the `jira` block (around line 64-71). Replace the commented-out credentials:

**Before:**
```typescript
jira: {
  // Atlassian/Jira OAuth 2.0 App
  // Register: https://developer.atlassian.com/console/myapps/
  // Create → OAuth 2.0 integration
  // Callback URL: http://localhost:3456/api/auth/callback
  // Scopes: read:jira-work, read:jira-user, offline_access
  // credentials: { clientId: '...', clientSecret: '...' },
},
```

**After:**
```typescript
jira: {
  // Atlassian/Jira OAuth 2.0 App
  // Register: https://developer.atlassian.com/console/myapps/
  // Create → OAuth 2.0 integration
  // Callback URL: http://localhost:3456/api/auth/callback
  // Scopes: read:jira-work, read:jira-user, offline_access
  credentials: {
    clientId: 'YOUR_JIRA_CLIENT_ID',
    clientSecret: 'YOUR_JIRA_CLIENT_SECRET',
  },
},
```

Replace `YOUR_JIRA_CLIENT_ID` and `YOUR_JIRA_CLIENT_SECRET` with the actual values.

---

## After All 5 Are Done

Once you've pasted all credentials into `src/core/oauth-defaults.ts`, build, test, and publish:

```bash
cd /Users/naman/llmwiki

# Build and verify
pnpm build
pnpm test

# Bump version and publish
npm version patch --no-git-tag-version
npm publish

# Commit and push
git add -A && git commit -m "feat: bundle OAuth credentials for all 5 providers" && git push
```

After this publish, every user who runs `npm install -g wikimem` (or updates) gets the bundled credentials. They never need to register OAuth apps themselves.

---

## Troubleshooting

### "Access blocked: WikiMem has not completed the Google verification process"

This happens when a non-test-user tries to connect Google. Two options:
- **For now:** Add their Google email to the test users list in the OAuth consent screen (max 100 test users)
- **Long-term:** Submit the app for Google verification (requires a privacy policy URL and a short video demo)

### "redirect_uri_mismatch" error on any provider

The callback URL in the provider's app settings doesn't match what WikiMem sends. Ensure it's exactly: `http://localhost:3456/api/auth/callback` (no trailing slash, http not https, port 3456).

### "invalid_client" error

The Client ID or Client Secret was copied incorrectly. Go back to the provider's developer console, verify the credentials, and re-paste them. Watch for trailing spaces.

### Linear secret lost

Linear only shows the Client Secret once. If you lost it, go to https://linear.app/settings/api, delete the WikiMem OAuth app, and create a new one. Then update `oauth-defaults.ts` with the new credentials.

### Jira/Atlassian secret lost

Same as Linear — Atlassian only shows the secret once. Go to https://developer.atlassian.com/console/myapps/, click on WikiMem, go to Settings, and click "Create new secret" to rotate it. Update `oauth-defaults.ts`.

### User wants to use their own credentials

Users can override any bundled credential with environment variables:
```bash
export WIKIMEM_GOOGLE_CLIENT_ID="their-own-id.apps.googleusercontent.com"
export WIKIMEM_GOOGLE_CLIENT_SECRET="GOCSPX-their-own-secret"
```

The resolution order is: env vars > config.yaml > bundled defaults.
