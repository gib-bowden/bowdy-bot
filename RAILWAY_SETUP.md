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
| `PLATFORM` | `twilio` |
| `TWILIO_ACCOUNT_SID` | `ACxxxxx` |
| `TWILIO_AUTH_TOKEN` | your auth token |
| `TWILIO_PHONE_NUMBER` | `+1...` (your Twilio number) |
| `TWILIO_ALLOWLIST` | `+1...:Gib,+1...:Mary Becker` |
| `DB_PATH` | `/data/bowdy-bot.db` |
| `TZ` | `America/Chicago` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | base64-encoded JSON (see below) |
| `GOOGLE_CALENDAR_ID` | your calendar ID |

### Base64-encode the Google service account key

```bash
base64 -i ~/.config/bowdy-bot/google-service-account.json | tr -d '\n' | pbcopy
```

Paste the clipboard contents as the `GOOGLE_SERVICE_ACCOUNT_KEY` value in Railway.

## 5. Deploy

After setting variables, Railway will automatically redeploy. Check the deploy logs for:

```
Starting Twilio SMS platform on port ...
```

## 6. Configure Twilio Webhook

1. Copy the public URL from Railway (Settings > Networking > Public Networking — generate a domain if needed)
2. Go to [Twilio Console](https://console.twilio.com/) > Phone Numbers > your number
3. Under **Messaging** > "A message comes in", set:
   - Webhook URL: `https://your-app.up.railway.app/` (POST)
4. Save

## 7. Verify

1. Text the Twilio number from an allowlisted phone
2. Check Railway logs for the incoming SMS
3. You should get a reply back via SMS
4. Try a calendar command to confirm the service account key works

## Troubleshooting

- **Build fails**: Check Railway build logs — likely a missing dependency or Node version issue
- **No response to SMS**: Check that the webhook URL is correct and the phone is in `TWILIO_ALLOWLIST`
- **Calendar not working**: Verify the base64 key decodes correctly: `echo "YOUR_BASE64" | base64 -d | jq .client_email`
- **DB resets on redeploy**: Make sure the volume is mounted to `/data` and `DB_PATH=/data/bowdy-bot.db`
