# Manual test checklist

These can't be run in CI (they need a real iPhone + paired Apple Watch, audio,
and haptics). Run them on device after `xcodegen generate` and building both
schemes.

## Concurrency
- [ ] Start two presets from the **Timers** tab. Both appear on the **Running**
      dashboard and count down independently.
- [ ] Pause one; the other keeps running. Resume it; it continues from where it
      paused (no time lost or skipped).
- [ ] Use `+30s` / `-10s` on a running timer — the ring and remaining time jump
      accordingly, and a milestone you rewound past announces again.

## Gym use case (voice, ducking)
- [ ] Play music. Start **Gym interval**. Music **ducks** (not stops) when it
      says "Halfway" and "20 seconds", then returns to full volume.
- [ ] The last 10 seconds are spoken "10 … 1"; "complete" is announced at zero.
- [ ] When all timers finish/stop, music returns to full volume.

## Conference talk use case (watch haptics, silent)
- [ ] Start **20 min talk** on the **watch**. Lock the phone and put it away.
- [ ] Lower your wrist — the workout session keeps the app active (green
      indicator). Haptics still fire on time.
- [ ] Confirm the three milestones feel **distinct**: halftime (rising), 5-min
      warning (double buzz), wrap-up (strong buzz), plus the triple "time's up".

## Library sync
- [ ] Edit a preset's name/duration on the phone → it updates on the watch.
- [ ] Create a new preset on the phone → it appears in the watch list.
- [ ] Toggle airplane mode briefly; edits reconcile once reconnected
      (application-context is latest-wins).

## Persistence
- [ ] Force-quit and relaunch — presets persist (App Group JSON).
- [ ] First launch on a fresh install seeds the two sample presets.
