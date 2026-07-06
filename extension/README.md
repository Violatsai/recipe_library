# Recipe Library — Chrome extension

One-click capture: sends the current tab to the local ingestion API.
YouTube tabs send just the URL (the server pulls metadata/transcript);
all other tabs also send the rendered page HTML, which sidesteps
bot-walled recipe sites.

## Build

```sh
npm run build --workspace extension
```

Outputs to `extension/dist/`.

## Load in Chrome (one-time)

1. Open `chrome://extensions`, toggle **Developer mode** (top right).
2. **Load unpacked** → select the `extension/dist` folder.
3. Click the extension's **⋯ → Options** (or right-click the toolbar icon →
   Options) and set:
   - **API base URL** — `http://localhost:3001` (default)
   - **Ingest API key** — the `INGEST_API_KEY` value from the server `.env`
4. Pin the icon, open any recipe page, click **Save recipe**.

Re-run the build after code changes, then hit ↻ on the extension card.

## Notes

- The save request runs in the popup — keep the popup open until the
  status flips to “Saved ✓” (enrichment takes ~10–30 s).
- Non-localhost API hosts additionally need a matching entry in
  `manifest.json` → `host_permissions`.
