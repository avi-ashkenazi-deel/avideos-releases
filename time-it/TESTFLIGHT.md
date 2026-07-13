# Shipping Time It to TestFlight

TestFlight is the easiest way to get the app (and the watch app) onto your
devices without wrestling with on-device wireless installs. Once the build is on
your iPhone via TestFlight, the **watch app installs to your paired watch
automatically**.

## Prerequisites

- A **paid Apple Developer Program** membership ($99/yr). A free account can run
  on-device but **cannot upload to TestFlight** — this is the usual blocker.
- An **app icon** must exist, or the upload fails validation:
  ```sh
  ./add-icon.sh ~/Downloads/your-image.png   # writes Icon-1024.png into both catalogs
  xcodegen generate
  ```

## One-time setup in App Store Connect

1. Go to <https://appstoreconnect.apple.com> ▸ **Apps** ▸ **＋** ▸ **New App**.
2. Platform **iOS**, name **Time It**, primary language, and **Bundle ID**
   `com.aviashkenazi.timeit` (pick it from the list — see "Bundle IDs" below),
   SKU anything (e.g. `timeit`).

### Bundle IDs
The project ships three bundle IDs. With **automatic signing** Xcode registers
them for you on first archive, or you can pre-create them under
**Certificates, Identifiers & Profiles ▸ Identifiers**:
- `com.aviashkenazi.timeit` (iPhone app)
- `com.aviashkenazi.timeit.watchkitapp` (watch app)
- `com.aviashkenazi.timeit.widget` (Live Activity widget)

If `com.aviashkenazi.*` is taken, change `bundleIdPrefix` in `project.yml`,
re-run `xcodegen generate`, and use your own prefix everywhere.

## In Xcode

1. `xcodegen generate && open TimeIt.xcodeproj`.
2. For **each** target (TimeIt, TimeItWatch, TimeItWidget) ▸ **Signing &
   Capabilities** ▸ set your **Team** and leave **Automatically manage signing**
   on.
3. Set the run destination to **Any iOS Device (arm64)** (not a simulator).
4. **Product ▸ Archive**. Wait for it to build.
5. In the **Organizer** window that opens: select the archive ▸ **Distribute
   App** ▸ **App Store Connect** ▸ **Upload** ▸ keep the defaults ▸ **Upload**.

## Back in App Store Connect

1. **TestFlight** tab — the build shows as "Processing" for ~5–15 min.
2. Export compliance is already answered (`ITSAppUsesNonExemptEncryption=false`),
   so no extra prompt.
3. Add yourself as an **Internal Tester**: **Users and Access** ▸ add your Apple
   ID as a user, then under **TestFlight ▸ Internal Testing** add yourself to a
   group. Internal testing needs **no Beta App Review**.
4. On your iPhone, install the **TestFlight** app from the App Store, open the
   invite, and **Install** Time It.
5. The **watch app** then installs to your paired Apple Watch automatically. If
   it doesn't appear in a minute, open the **Watch** app on the iPhone ▸ scroll
   to **Time It** ▸ **Install**.

## Re-uploading a new build

Each upload needs a **higher build number**. Bump it in `project.yml`:
```yaml
settings:
  base:
    CURRENT_PROJECT_VERSION: "2"   # was 1
```
then `xcodegen generate`, archive, and upload again. (Bump
`MARKETING_VERSION` only when you want a new user-facing version like 0.2.0.)

## Notes / likely snags

- **External** testers (anyone outside your team) require a one-time Beta App
  Review; **internal** testers (you) don't. Test internally first.
- Background-audio keep-alive + HealthKit are fine for TestFlight; for a future
  public App Store release be ready to justify the `audio` background mode and
  HealthKit usage in App Review.
- If archive fails with "missing app icon", you skipped `add-icon.sh`.
