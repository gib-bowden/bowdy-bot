# Railway Deployment Setup

## 1. Push to GitHub

```bash
git remote add origin git@github.com:YOUR_USERNAME/bowdy-bot.git
git push -u origin main
```

## 2. Create Railway Project

1. Go to [railway.com](https://railway.com/) and sign up / log in
2. Click **New Project** > **Deploy from GitHub repo**
3. Select the `bowdy-bot` repo
4. Railway auto-detects the Dockerfile and starts a build — it will fail until env vars are set, that's fine

## 3. Add a Volume

The SQLite database needs persistent storage so it survives redeploys.

1. In your Railway project, click **New** > **Volume**
2. Set mount path to `/data`
3. Attach it to the bowdy-bot service

## 4. Set Environment Variables

In the Railway service settings, go to **Variables** and add:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `PLATFORM` | `twilio` or `groupme` |
| `TWILIO_ACCOUNT_SID` | `ACxxxxx` |
| `TWILIO_AUTH_TOKEN` | your auth token |
| `TWILIO_PHONE_NUMBER` | `+1...` (your Twilio number) |
| `TWILIO_ALLOWLIST` | `+1...:Gib,+1...:Mary Becker` |
| `DB_PATH` | `/data/bowdy-bot.db` |
| `TZ` | `America/Chicago` |
| `GOOGLE_CLIENT_ID` | your OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | your OAuth client secret |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` output |
| `GOOGLE_OAUTH_REDIRECT_URI` | `https://your-app.up.railway.app/oauth/callback` |
| `GOOGLE_CALENDAR_ID` | your calendar ID (e.g. `family@gmail.com`) |

## 5. Configure Google OAuth

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Edit your OAuth 2.0 Client ID
3. Add `https://your-app.up.railway.app/oauth/callback` to **Authorized redirect URIs**
4. Make sure your Google account is listed as a **test user** under the OAuth consent screen (unless the app is published)

## 6. Deploy

After setting variables, Railway will automatically redeploy. Check the deploy logs for:

```
Starting Twilio SMS platform on port ...
OAuth routes mounted on platform server
```

## 7. Connect Google Account

1. Visit `https://your-app.up.railway.app/` in your browser
2. Click **Connect Google Account** and sign in
3. The OAuth tokens are stored in the SQLite database on the Railway volume

This only needs to be done once — the bot uses stored refresh tokens for subsequent requests.

## 8. Configure Twilio Webhook

1. Copy the public URL from Railway (Settings > Networking > Public Networking — generate a domain if needed)
2. Go to [Twilio Console](https://console.twilio.com/) > Phone Numbers > your number
3. Under **Messaging** > "A message comes in", set:
   - Webhook URL: `https://your-app.up.railway.app/` (POST)
4. Save

## 9. Verify

1. Text the Twilio number from an allowlisted phone
2. Check Railway logs for the incoming SMS
3. You should get a reply back via SMS
4. Try a calendar or tasks command to confirm Google OAuth is working

## Troubleshooting

- **Build fails**: Check Railway build logs — likely a missing dependency or Node version issue
- **No response to SMS**: Check that the webhook URL is correct and the phone is in `TWILIO_ALLOWLIST`
- **Google OAuth not working**: Make sure `GOOGLE_OAUTH_REDIRECT_URI` matches the redirect URI in Google Cloud Console exactly
- **DB resets on redeploy**: Make sure the volume is mounted to `/data` and `DB_PATH=/data/bowdy-bot.db`
