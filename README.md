# Voice-Reactive Character Overlay for Online D&D

When a player talks in your Discord voice channel, their D&D character portrait
lights up — visual-novel style — on top of everyone's Roll20 view. Idle
characters are dimmed; the active speaker is raised, lit, and labeled with their
character name. No webcams, no transcription. It just runs in the background.

```
 Discord voice  ->  discord-listener  ->  relay (WebSocket + HTTP)  ->  extension overlay on Roll20
 (host only)        (host machine)        (host or cheap VPS)           (every player)
```

The data source (Discord) is fully decoupled from the display target (Roll20).
The overlay never reads Roll20's internals, so Roll20 UI changes won't break it.

## Repository layout

```
dnd-voice-overlay/
├── config/
│   ├── campaign.example.json   # copy to campaign.json and edit per campaign
│   └── portraits/              # drop your character PNGs here
├── packages/
│   ├── discord-listener/       # Node/TS: reads Discord speaking events  (HOST ONLY)
│   ├── relay/                  # Node/TS: WebSocket fan-out + serves config & portraits
│   └── extension/              # Manifest v3 Chrome extension overlay    (EVERY PLAYER)
├── SETUP.md                    # do this; lists every manual step
└── README.md
```

## Who runs what

| Role        | Runs                                                          | Authorizes Discord? |
|-------------|---------------------------------------------------------------|---------------------|
| Host (you)  | discord-listener + relay, edits campaign.json, supplies PNGs   | Yes, once           |
| Each player | The browser extension, pointed at the relay URL                | No                  |

## Quick start

See **SETUP.md** for the full walkthrough. Short version:

1. Register a Discord application (host only).
2. Edit config/campaign.json — map each Discord user ID to a portrait + name.
3. Drop portrait PNGs into config/portraits/.
4. Start the relay, then start the listener.
5. Each player installs the extension and sets the relay URL.

## Design notes / scope

- In scope: speaking detection -> portrait highlight, click-through overlay,
  per-campaign config without code changes.
- Out of scope: transcription / speech-to-text, webcams/video, speaker
  diarization, Roll20's built-in voice.
- Latency target: portrait lights within ~0.5s of speech start.
- Discord voice scope is gated, but only the host (the app owner) ever
  authorizes, so this is a non-issue. No Discord audio is received.
