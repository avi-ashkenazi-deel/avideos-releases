# Custom voice clips

Drop your own audio recordings here and Time It will play them **instead of the
synthesized voice** wherever the filename matches the spoken phrase. Anything you
don't provide just uses text-to-speech, so record only what you want.

Supported formats: **mp3, m4a, wav, caf**.

After adding files, regenerate the project so they're bundled:

```sh
xcodegen generate
```

## Filename = the phrase, lowercased, spaces → dashes

| You hear…            | File to add            |
|----------------------|------------------------|
| the countdown 10…1   | `10.mp3` … `1.mp3`     |
| "Rest" (the break)   | `rest.mp3`             |
| "Go"                 | `go.mp3`               |
| "Round 2", "Round 3" | `round-2.mp3`, …       |
| "Interval 1", "2"…   | `interval-1.mp3`, …    |
| "30 seconds" left    | `30-seconds.mp3`       |
| "Halfway"            | `halfway.mp3`          |
| a custom cue label   | the label, slugged — e.g. "Push harder" → `push-harder.mp3` |

Notes:
- The rule is: lowercase the phrase and turn every run of non-letters/numbers
  into a single dash. So "Time's up" → `time-s-up`.
- These files are bundled into **both** the iPhone and Watch apps.
- Keep clips short (≈1s for countdown numbers) so they don't overlap the next one.
