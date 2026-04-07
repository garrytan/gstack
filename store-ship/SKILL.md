---
name: store-ship
description: App Store and Google Play submission — build preparation, metadata, submission workflow, build management, and post-submission monitoring.
---

# /store-ship

Run this after `/onboarding-audit` and before `/canary`. This skill handles the mechanics of submitting to the App Store and Google Play, including build preparation, metadata, submission, and monitoring.

## Use when

- Preparing a build for initial submission or update.
- Setting up continuous delivery for mobile.
- Responding to App Store or Play review feedback.
- Managing build versions and rollout phases.
- Setting up TestFlight or internal testing tracks.
- Configuring app signing and certificates.

## Inputs

Collect or infer:

- Platform: `flutter`, `swift`, `kotlin`, or `expo`.
- Target OS: iOS, Android, or both.
- Submission type: initial submission, update, or TestFlight/internal testing.
- Build status: built, signed, ready for upload.
- Metadata status: screenshots, descriptions, keywords prepared.
- Review notes: any special review information needed (e.g., demo account, video).
- Rollout strategy: immediate, phased, or manual.

If platform is missing:
- Read `~/.gstack/config` or project docs.
- If still unclear, ask one concise question before proceeding.

## Review standard

### 1. Build preparation
- Version number (CFBundleShortVersionString / versionName) incremented.
- Build number (CFBundleVersion / versionCode) incremented monotonically.
- Debug code removed or stripped in release.
- Crash reporting integrated (Sentry, Firebase Crashlytics).
- No hardcoded test URLs or debug features in release.
- Asset optimization completed (app icon, splash, images).

### 2. App signing
- iOS: valid distribution certificate, appropriate provisioning profile (App Store or Ad Hoc).
- Android: valid signing key (don't lose or change the keystore for existing apps).
- Flutter/Expo: correctly configured for release builds.
- Secrets loaded from environment, not embedded in binary.

### 3. iOS App Store specific
- Privacy nutrition labels completed accurately.
- Age rating questionnaire accurate.
- App Store screenshots meet specifications (different sizes, no device frames).
- App preview videos (optional but recommended).
- Keywords optimized for search (100 characters, comma-separated).
- Description includes feature list and call to action.
- Test account provided if login is required.
- Demo video provided if hardware features need demonstration.

### 4. Google Play specific
- App listing complete (short description, full description, screenshots, feature graphic).
- Release track configured (production, internal testing, closed, open).
- Target audience and content rating completed.
- Data safety section completed accurately.
- Pricing and distribution set correctly (free/paid, countries).
- App bundle (AAB) or APK properly configured.

### 5. Submission workflow
- Fastlane or equivalent CI integration in place.
- Build upload automated (Transporter for iOS, Play Console API for Android).
- Submission creates version record for tracking.
- Review submission doesn't include extraneous build notes.

### 6. Post-submission
- Build appears in console within expected time (minutes to hours).
- Review time estimated (iOS: hours to days, Android: hours to days, often faster for updates).
- Rollout strategy set (immediate for low-risk, phased for regression detection).
- Monitoring enabled for crashes and ANRs.
- Store listing monitoring for any issues.

## Output format

Use this exact structure:

### Verdict
One paragraph with a blunt recommendation:
- `PASS`
- `PASS WITH WARNINGS`
- `FAIL`

### Critical issues
Bullets only. Include only issues that will block submission or cause rejection.

### Warnings
Bullets only. Important but non-blocking.

### Platform-specific notes
Split into:
- `iOS`
- `Android`
- `Flutter / shared`
Only include sections that apply.

### Submission steps
Give the exact commands or steps to submit.

### Build checklist
Provide a short, execution-ready checklist.

## Style

- Be direct and specific.
- Focus on common rejection reasons.
- Recommend automation (Fastlane, Play Console API) over manual upload.
- Flag issues that cause review delays or rejections.
- Don't suggest anything that violates store guidelines.

## Mobile-specific checks

- Version and build numbers correct and monotonic.
- Signing certificates valid and not expired.
- Privacy disclosures accurate.
- No guideline violations in app functionality or metadata.

## Examples

Good prompts:
- `/store-ship prepare this Flutter app for App Store submission`
- `/store-ship set up Fastlane for automated Play Console uploads`
- `/store-ship review this build for submission readiness`

Bad prompts:
- `/store-ship submit the app`
- `/store-ship check if ready`