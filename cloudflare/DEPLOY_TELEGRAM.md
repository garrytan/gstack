# Cloudflare Worker (Free) — Telegram Webhook Deployment

This deploys the Telegram bot as a Cloudflare Worker (no always-on server, no polling).

## Prerequisites
- A Cloudflare account
- A Telegram bot token from @BotFather

## Deploy

From the repo root:

```bash
cd cloudflare
npx wrangler@latest deploy
```

This prints a `workers.dev` URL like:
`https://gstack-telegram-webhook.<your-subdomain>.workers.dev`

## Configure secrets

```bash
cd cloudflare
npx wrangler@latest secret put TELEGRAM_TOKEN
npx wrangler@latest secret put WEBHOOK_SECRET
```

Optional (restrict who can use the bot):

```bash
npx wrangler@latest secret put TELEGRAM_ALLOWED_CHAT_IDS
```

Enter your Telegram chat id (or comma-separated list).


Alternative (recommended, from repo root; avoids the “Required Worker name missing” error):

```bash
bun run telegram:whitelist --ids 6611272032,8714377309
```
Optional (enable `/portfolio` in the Worker):


```bash
npx wrangler@latest secret put PORTFOLIO
```

Enter a comma-separated ticker list, for example:
`GOOGL,NVDA,TSM,MSFT,MSTR,TCOM,0700.HK,7226.HK,9988.HK,1810.HK`

## Important note (secrets vs vars)

If you define `TELEGRAM_ALLOWED_CHAT_IDS` or `PORTFOLIO` as plain environment variables in `wrangler.toml`, they can override your remote secrets. This project uses secrets for these values.

## Set the Telegram webhook

Replace:
- `<TOKEN>` with your Telegram bot token
- `<WORKER_URL>` with the URL printed by `wrangler deploy`
- `<WEBHOOK_SECRET>` with the value you set in `WEBHOOK_SECRET`

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/telegram/<WEBHOOK_SECRET>"
```

To verify:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Test in Telegram

- `NVDA`
- `/summary NVDA`
- `/full NVDA`
- `/watch NVDA,AAPL,TSLA`
- `/portfolio`

## Notes / Limitations (Worker version)
- This Worker returns a “Trading Brief” summary. It does not run Bun/Playwright, so it does not scrape news.
- If you need the full report and news scraping, run the local bot (`bun run telegram:bot`) on your PC/VPS.
