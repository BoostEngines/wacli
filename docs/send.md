# send

Read when: sending text, files, quoted replies, or reactions.

`wacli send` requires authentication, a live connection, and writable mode. Send attempts are bounded and retry once after reconnect for known stale-session/usync timeout failures. After a successful send, wacli keeps the connection alive briefly so whatsmeow can handle retry receipts from devices that could not decrypt the first copy. Repeated send commands within 5 seconds print a stderr warning so tight loops make WhatsApp rate-limit/account-risk visible.

## Commands

```bash
wacli send text --to RECIPIENT --message TEXT [--pick N] [--mention USER]... [--no-preview] [--reply-to MSG_ID] [--reply-to-sender JID] [--post-send-wait 2s]
wacli send file --to RECIPIENT --file PATH [--pick N] [--caption TEXT] [--filename NAME] [--mime TYPE] [--ptt] [--reply-to MSG_ID] [--reply-to-sender JID] [--post-send-wait 2s]
wacli send voice --to RECIPIENT --file PATH [--pick N] [--mime TYPE] [--reply-to MSG_ID] [--reply-to-sender JID] [--post-send-wait 2s]
wacli send react --to PHONE_OR_JID --id MSG_ID [--reaction TEXT] [--sender JID] [--post-send-wait 2s]
```

## Recipients

- `send text` and `send file` accept a JID, phone number, or synced contact/group/chat name.
- If a name matches multiple recipients, interactive terminals prompt.
- In scripts, use `--pick N` to choose a displayed match.
- Phone numbers may use common formatting such as `+1 (234) 567-8900`.

## Replies and reactions

- `send text` fetches Open Graph metadata for the first `http://` or `https://` URL and sends it as a WhatsApp link preview.
- Preview metadata fetches time out after 10 seconds and fall back to plain text.
- Pass `--no-preview` to disable link-preview fetching.
- Pass repeatable `--mention` values to mention user JIDs or phone numbers in group text messages.
- `--reply-to` quotes a stored message ID.
- For unsynced group replies, pass `--reply-to-sender`.
- `send react` defaults to thumbs-up.
- Pass `--reaction ""` to clear a reaction.
- For group reactions, pass `--sender` for the original message sender.
- Use `--post-send-wait 0` to disable the retry-receipt grace window for latency-sensitive scripts.

## Files

- File uploads are capped at 100 MiB.
- MIME type is detected automatically unless `--mime` is set.
- `--filename` changes the displayed document name.
- Captions apply to images, videos, and documents.
- `send voice` is a shortcut for `send file --ptt`.
- Voice notes require OGG/Opus audio (`audio/ogg; codecs=opus`).
- When available, `ffprobe` sets voice-note duration and `ffmpeg` generates the 64-sample waveform from decoded PCM audio.

## Examples

```bash
wacli send text --to mom --message "landed"
wacli send text --to "Family" --pick 2 --message "on my way"
wacli send text --to "Family" --message "@alice can you check this?" --mention 15551234567
wacli send text --to 1234567890 --message "replying" --reply-to ABC123
wacli send file --to 1234567890 --file ./pic.jpg --caption "hi"
wacli send file --to 1234567890 --file /tmp/report --filename report.pdf
wacli send voice --to 1234567890 --file ./voice.ogg
wacli send react --to 1234567890 --id ABC123 --reaction "❤️"
```
