# Recipe Library — Chrome extension

One-click capture: the extension's background service worker snapshots the current
tab and persists a job to the local ingestion API. Once the popup says **Queued ✓**,
the popup and source tab are no longer part of extraction. YouTube tabs send just the
URL (the server pulls metadata/transcript); other ordinary tabs send rendered page
HTML, which sidesteps bot-walled recipe sites.

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

- Ordinary pages and YouTube are fire-and-forget after the quick **Queued ✓** handoff.
- Facebook/Instagram/Threads still generate a preview in the popup before queueing;
  keep the popup open for that preview, then confirm. Their confirmation redesign is
  intentionally deferred until the queue architecture is stable.
- A toolbar badge shows `…` during handoff, briefly `✓` when the server accepts the
  job, and `!` when capture/delivery fails.
- Non-localhost API hosts additionally need a matching entry in
  `manifest.json` → `host_permissions`.
